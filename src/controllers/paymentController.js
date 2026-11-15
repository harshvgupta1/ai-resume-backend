import crypto from "crypto";
import { razorpayInstance, RAZORPAY_CONFIG } from "../config/razorpay.js";
import { pool } from "../config/db.js";

// Standard exchange rate: 1 USD = 86.00 INR
const EXCHANGE_RATE = 86.0;

// Base Pricing Definition in USD & Converted INR
const PLANS = {
  monthly: {
    baseAmountUsd: 9.0, // $9.00 USD
    amountUsdCents: 900, // 900 cents
    amountInrPaise: Math.round(9.0 * EXCHANGE_RATE * 100), // ₹774 (77400 paise)
    durationDays: 30,
    label: "ResumeAI Pro Monthly",
  },
  yearly: {
    baseAmountUsd: 59.0, // $59.00 USD
    amountUsdCents: 5900, // 5900 cents
    amountInrPaise: Math.round(59.0 * EXCHANGE_RATE * 100), // ₹5,074 (507400 paise)
    durationDays: 365,
    label: "ResumeAI Pro Annual (Save ~45%)",
  },
};

/**
 * POST /api/payment/create-order
 * 1. Converts USD to INR for Indian users wishing to pay via UPI (or keeps USD for Card payments)
 * 2. Creates Razorpay Order
 * 3. Records new order in the `orders` database table
 */
export const createOrder = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan = "monthly", currency = "USD", paymentMethod = "auto" } = req.body;

    const planConfig = PLANS[plan] || PLANS.monthly;

    // Determine target currency and amount:
    // UPI requires INR. If paymentMethod is "upi" or currency is "INR", charge in INR.
    const isUpiOrInr = currency.toUpperCase() === "INR" || paymentMethod.toLowerCase() === "upi";
    const targetCurrency = isUpiOrInr ? "INR" : "USD";
    const chargeAmount = isUpiOrInr ? planConfig.amountInrPaise : planConfig.amountUsdCents;
    const amountFormatted = isUpiOrInr
      ? `₹${(planConfig.amountInrPaise / 100).toLocaleString("en-IN")}`
      : `$${planConfig.baseAmountUsd.toFixed(2)}`;

    const orderOptions = {
      amount: chargeAmount,
      currency: targetCurrency,
      receipt: `rcpt_${userId.slice(0, 8)}_${Date.now()}`,
      notes: {
        userId,
        plan,
        baseAmountUsd: String(planConfig.baseAmountUsd),
        exchangeRate: String(EXCHANGE_RATE),
        targetCurrency,
        paymentMethodPreference: paymentMethod,
        label: planConfig.label,
      },
    };

    const order = await razorpayInstance.orders.create(orderOptions);

    // 1. Insert order record into `orders` table
    const orderRecordId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO orders (
           id, user_id, razorpay_order_id, plan, billing_cycle,
           base_currency, base_amount, exchange_rate, currency, amount, amount_formatted,
           payment_method_preference, status
         ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, 'created')`,
        [
          orderRecordId,
          userId,
          order.id,
          `pro_${plan}`,
          plan,
          planConfig.baseAmountUsd,
          EXCHANGE_RATE,
          targetCurrency,
          chargeAmount,
          amountFormatted,
          paymentMethod,
        ]
      );
    } catch (orderDbErr) {
      console.warn("[MySQL] Orders table insert warning:", orderDbErr.message);
    }

    // 2. Also keep legacy payments table in sync
    try {
      const paymentRecordId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO payments (id, user_id, order_id, amount, currency, plan, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [paymentRecordId, userId, order.id, chargeAmount, targetCurrency, plan, "created"]
      );
    } catch (dbErr) {
      console.warn("[MySQL] Legacy payment record insert warning:", dbErr.message);
    }

    return res.status(200).json({
      success: true,
      orderId: order.id,
      internalOrderId: orderRecordId,
      amount: order.amount,
      currency: order.currency,
      amountFormatted,
      baseAmountUsd: planConfig.baseAmountUsd,
      exchangeRate: EXCHANGE_RATE,
      keyId: RAZORPAY_CONFIG.keyId,
      plan,
      label: planConfig.label,
      isUpiSupported: targetCurrency === "INR",
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
 * 1. Cryptographically verifies Razorpay HMAC signature
 * 2. Marks order as `paid` in `orders` table
 * 3. Records successful transaction in `transactions` table
 * 4. Activates subscription in `subscriptions` table with exact expiration date
 * 5. Upgrades user plan to PRO in `users` table
 */
export const verifyPayment = async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      plan = "monthly",
      paymentMethod = "card",
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

    // 1. Retrieve the matching order from `orders` table
    let matchedOrder = null;
    try {
      const [orderRows] = await pool.query(
        `SELECT * FROM orders WHERE razorpay_order_id = ? LIMIT 1`,
        [razorpay_order_id]
      );
      if (orderRows.length > 0) {
        matchedOrder = orderRows[0];
      }
    } catch (orderFetchErr) {
      console.warn("Could not fetch matched order from DB:", orderFetchErr.message);
    }

    const planKey = matchedOrder?.billing_cycle || plan;
    const planConfig = PLANS[planKey] || PLANS.monthly;
    const daysToAdd = planConfig.durationDays;
    const chargedAmount = matchedOrder?.amount || (matchedOrder?.currency === "INR" ? planConfig.amountInrPaise : planConfig.amountUsdCents);
    const chargedCurrency = matchedOrder?.currency || "USD";
    const amountFormatted = matchedOrder?.amount_formatted || (chargedCurrency === "INR" ? `₹${(chargedAmount / 100).toLocaleString("en-IN")}` : `$${planConfig.baseAmountUsd.toFixed(2)}`);

    // 2. Mark order as PAID in `orders` table
    try {
      await pool.query(
        `UPDATE orders 
         SET status = 'paid', updated_at = NOW() 
         WHERE razorpay_order_id = ?`,
        [razorpay_order_id]
      );
    } catch (orderUpdateErr) {
      console.warn("[MySQL] Warning updating orders table status:", orderUpdateErr.message);
    }

    // 3. Create successful payment transaction in `transactions` table
    const transactionId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO transactions (
           id, order_id, user_id, razorpay_order_id, razorpay_payment_id,
           razorpay_signature, amount, currency, amount_formatted, payment_method, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')`,
        [
          transactionId,
          matchedOrder?.id || razorpay_order_id,
          userId,
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature,
          chargedAmount,
          chargedCurrency,
          amountFormatted,
          paymentMethod || matchedOrder?.payment_method_preference || "card",
        ]
      );
      console.log(`[MySQL] Successfully logged transaction ${transactionId} for payment ${razorpay_payment_id}`);
    } catch (txErr) {
      console.warn("[MySQL] Transactions table insert warning:", txErr.message);
    }

    // 4. Update legacy payments table
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

    // 5. Cancel any prior active subscriptions for this user
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

    // 6. Insert new active subscription into `subscriptions` table
    const subscriptionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO subscriptions (
         id, user_id, order_id, transaction_id, plan, billing_cycle,
         status, amount, currency, razorpay_order_id, razorpay_payment_id,
         current_period_start, current_period_end
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [
        subscriptionId,
        userId,
        matchedOrder?.id || null,
        transactionId,
        `pro_${planKey}`,
        planKey,
        chargedAmount,
        chargedCurrency,
        razorpay_order_id,
        razorpay_payment_id,
        daysToAdd,
      ]
    );

    // 7. Upgrade user account to PRO in MySQL `users` table
    await pool.query(
      `UPDATE users 
       SET plan = 'pro', pro_expires_at = DATE_ADD(NOW(), INTERVAL ? DAY)
       WHERE id = ?`,
      [daysToAdd, userId]
    );

    // 8. Fetch fresh user profile & newly created subscription
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

    console.log(`[Razorpay] Upgraded user ${userId} to PRO via transaction ${transactionId}. Expires: ${expiresAt}`);

    return res.status(200).json({
      success: true,
      message: `🎉 Payment verified! You are now upgraded to ResumeAI PRO.`,
      transactionId,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountFormatted,
      currency: chargedCurrency,
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
            amountFormatted,
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

    const amountFormatted = sub.currency === "INR"
      ? `₹${(sub.amount / 100).toLocaleString("en-IN")}`
      : `$${(sub.amount / 100).toFixed(2)}`;

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
        amountFormatted,
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
 * GET /api/payment/orders
 * Returns order history for current authenticated user
 */
export const getUserOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    return res.status(200).json({ success: true, orders: rows });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch orders", details: error.message });
  }
};

/**
 * GET /api/payment/transactions
 * Returns transaction records for current authenticated user
 */
export const getUserTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    return res.status(200).json({ success: true, transactions: rows });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch transactions", details: error.message });
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
