import crypto from "crypto";
import { razorpayInstance, RAZORPAY_CONFIG } from "../config/razorpay.js";
import { pool } from "../config/db.js";

// Plans definition in INR (paise: 1 INR = 100 paise)
const PLANS = {
  monthly: {
    amount: 49900, // ₹499
    durationDays: 30,
    label: "ResumeAI Pro Monthly",
  },
  yearly: {
    amount: 299900, // ₹2,999 (~₹250/mo)
    durationDays: 365,
    label: "ResumeAI Pro Annual (50% Off)",
  },
};

/**
 * POST /api/payment/create-order
 * Creates a Razorpay Order and logs it in the payments table
 */
export const createOrder = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan = "monthly" } = req.body;

    const planConfig = PLANS[plan] || PLANS.monthly;
    const orderOptions = {
      amount: planConfig.amount,
      currency: "INR",
      receipt: `rcpt_${userId.slice(0, 8)}_${Date.now()}`,
      notes: {
        userId,
        plan,
        label: planConfig.label,
      },
    };

    const order = await razorpayInstance.orders.create(orderOptions);

    // Save initial payment record in MySQL
    const paymentRecordId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO payments (id, user_id, order_id, amount, currency, plan, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [paymentRecordId, userId, order.id, planConfig.amount, "INR", plan, "created"]
      );
    } catch (dbErr) {
      console.warn("[MySQL] Payment order record insert warning:", dbErr.message);
    }

    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_CONFIG.keyId,
      plan,
      label: planConfig.label,
    });
  } catch (error) {
    console.error("Razorpay order creation error:", error);
    return res.status(500).json({
      error: "Failed to initialize Razorpay checkout order.",
      details: error.message,
    });
  }
};

/**
 * POST /api/payment/verify
 * Cryptographically verifies Razorpay HMAC signature, creates/updates subscription & upgrades user plan
 */
export const verifyPayment = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan = "monthly",
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing required payment verification fields." });
    }

    // Verify HMAC SHA-256 signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_CONFIG.keySecret)
      .update(body.toString())
      .digest("hex");

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      console.error("[Razorpay] Signature verification failed! Tampered payload detected.");
      return res.status(400).json({ error: "Payment signature verification failed." });
    }

    const planConfig = PLANS[plan] || PLANS.monthly;
    const daysToAdd = planConfig.durationDays;

    // 1. Update payment record to paid in MySQL
    try {
      await pool.query(
        `UPDATE payments 
         SET payment_id = ?, signature = ?, status = 'paid'
         WHERE order_id = ? AND user_id = ?`,
        [razorpay_payment_id, razorpay_signature, razorpay_order_id, userId]
      );
    } catch (dbErr) {
      console.warn("[MySQL] Warning updating payment record status:", dbErr.message);
    }

    // 2. Mark any older active subscriptions for this user as superseded
    try {
      await pool.query(
        `UPDATE subscriptions 
         SET status = 'cancelled', updated_at = NOW() 
         WHERE user_id = ? AND status = 'active'`,
        [userId]
      );
    } catch (subErr) {
      console.warn("[MySQL] Subscriptions status update warning:", subErr.message);
    }

    // 3. Insert new active subscription record into MySQL `subscriptions` table
    const subscriptionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO subscriptions (
         id, user_id, plan, billing_cycle, status, amount, currency,
         razorpay_order_id, razorpay_payment_id, current_period_start, current_period_end
       ) VALUES (?, ?, ?, ?, 'active', ?, 'INR', ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [
        subscriptionId,
        userId,
        `pro_${plan}`,
        plan === "yearly" ? "yearly" : "monthly",
        planConfig.amount,
        razorpay_order_id,
        razorpay_payment_id,
        daysToAdd,
      ]
    );

    // 4. Upgrade user account to PRO with expiry in MySQL `users` table
    await pool.query(
      `UPDATE users 
       SET plan = 'pro', pro_expires_at = DATE_ADD(NOW(), INTERVAL ? DAY)
       WHERE id = ?`,
      [daysToAdd, userId]
    );

    // 5. Fetch fresh user profile & newly created subscription
    const [userRows] = await pool.query(
      `SELECT id, email, name, avatar_url, plan, scans_used, pro_expires_at FROM users WHERE id = ?`,
      [userId]
    );
    const updatedUser = userRows[0] || {};

    const [subRows] = await pool.query(
      `SELECT * FROM subscriptions WHERE id = ?`,
      [subscriptionId]
    );
    const activeSub = subRows[0] || null;

    const expiresAt = activeSub?.current_period_end || updatedUser.pro_expires_at;
    const daysRemaining = expiresAt
      ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : daysToAdd;

    console.log(`[Razorpay] Upgraded user ${userId} to PRO. Subscription: ${subscriptionId}, Expires: ${expiresAt}`);

    return res.status(200).json({
      success: true,
      message: `🎉 Payment verified! You are now upgraded to ResumeAI PRO.`,
      paymentId: razorpay_payment_id,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        avatarUrl: updatedUser.avatar_url,
        plan: updatedUser.plan,
        scansUsed: updatedUser.scans_used ?? 0,
        scansLimit: 3,
        proExpiresAt: updatedUser.pro_expires_at,
      },
      subscription: activeSub
        ? {
            id: activeSub.id,
            plan: activeSub.plan,
            billingCycle: activeSub.billing_cycle,
            status: activeSub.status,
            amount: activeSub.amount,
            currency: activeSub.currency,
            currentPeriodStart: activeSub.current_period_start,
            currentPeriodEnd: activeSub.current_period_end,
            daysRemaining,
            isExpired: false,
          }
        : null,
    });
  } catch (error) {
    console.error("Payment verification server error:", error);
    return res.status(500).json({
      error: "Payment verification failed on server.",
      details: error.message,
    });
  }
};

/**
 * GET /api/payment/subscription
 * Retrieves the current user's active subscription and exact expiration details from `subscriptions` table
 */
export const getSubscription = async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch latest subscription record from subscriptions table
    const [subRows] = await pool.query(
      `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (subRows.length === 0) {
      return res.status(200).json({
        success: true,
        plan: "free",
        hasActiveSubscription: false,
        subscription: null,
      });
    }

    const sub = subRows[0];
    const now = new Date();
    const expiryDate = new Date(sub.current_period_end);
    const isExpired = expiryDate < now;
    const daysRemaining = Math.max(0, Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

    // Auto-sync status if expired
    if (isExpired && sub.status === "active") {
      try {
        await pool.query(`UPDATE subscriptions SET status = 'expired' WHERE id = ?`, [sub.id]);
        await pool.query(`UPDATE users SET plan = 'free' WHERE id = ?`, [userId]);
        sub.status = "expired";
      } catch (e) {
        console.warn("Could not update expired status in DB:", e.message);
      }
    }

    return res.status(200).json({
      success: true,
      hasActiveSubscription: !isExpired && sub.status === "active",
      plan: !isExpired && sub.status === "active" ? "pro" : "free",
      subscription: {
        id: sub.id,
        plan: sub.plan,
        billingCycle: sub.billing_cycle,
        status: sub.status,
        amount: sub.amount,
        amountFormatted: `₹${(sub.amount / 100).toLocaleString("en-IN")}`,
        currency: sub.currency,
        razorpayPaymentId: sub.razorpay_payment_id,
        razorpayOrderId: sub.razorpay_order_id,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd: sub.current_period_end,
        expiresAtFormatted: expiryDate.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
        daysRemaining,
        isExpired,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      },
    });
  } catch (error) {
    console.error("Error retrieving user subscription:", error);
    return res.status(500).json({
      error: "Failed to retrieve subscription status.",
      details: error.message,
    });
  }
};

/**
 * POST /api/payment/cancel
 * Cancel auto-renewal at period end
 */
export const cancelSubscription = async (req, res) => {
  try {
    const userId = req.user.id;
    await pool.query(
      `UPDATE subscriptions 
       SET cancel_at_period_end = 1, cancelled_at = NOW() 
       WHERE user_id = ? AND status = 'active'`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      message: "Subscription auto-renewal has been cancelled. Your PRO access will remain active until the end of your current billing period.",
    });
  } catch (error) {
    console.error("Cancel subscription error:", error);
    return res.status(500).json({ error: "Failed to cancel subscription", details: error.message });
  }
};
