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
 * Cryptographically verifies Razorpay HMAC signature & upgrades user plan
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

    // 2. Upgrade user account to PRO with expiry in MySQL
    await pool.query(
      `UPDATE users 
       SET plan = 'pro', pro_expires_at = DATE_ADD(NOW(), INTERVAL ? DAY)
       WHERE id = ?`,
      [daysToAdd, userId]
    );

    // 3. Fetch fresh user profile
    const [rows] = await pool.query(
      `SELECT id, email, name, avatar_url, plan, scans_used, pro_expires_at FROM users WHERE id = ?`,
      [userId]
    );

    const updatedUser = rows[0] || {};

    console.log(`[Razorpay] Successfully upgraded user ${userId} to PRO via ${razorpay_payment_id}`);

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
    });
  } catch (error) {
    console.error("Payment verification server error:", error);
    return res.status(500).json({
      error: "Payment verification failed on server.",
      details: error.message,
    });
  }
};
