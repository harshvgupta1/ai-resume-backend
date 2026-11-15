import crypto from "crypto";
import { razorpayInstance, RAZORPAY_CONFIG } from "../config/razorpay.js";
import { pool } from "../config/db.js";

// Standard exchange rate: 1 USD = 86.00 INR
const EXCHANGE_RATE = 86.0;

// Standard Statutory Tax Rate for SaaS Services in India: 18% GST
const GST_RATE = 0.18;

// Base Pricing Definition in USD
const PLANS = {
  monthly: {
    baseAmountUsd: 9.0, // $9.00 USD
    amountUsdCents: 900, // 900 cents
    durationDays: 30,
    label: "ResumeAI Pro Monthly",
  },
  yearly: {
    baseAmountUsd: 59.0, // $59.00 USD
    amountUsdCents: 5900, // 5900 cents
    durationDays: 365,
    label: "ResumeAI Pro Annual (Save ~45%)",
  },
};

/**
 * Helper to compute subtotal, 18% GST, and total payable amount
 */
export const calculatePricingWithGST = (plan = "monthly", currency = "USD", paymentMethod = "auto") => {
  const planConfig = PLANS[plan] || PLANS.monthly;
  const isUpiOrInr = currency.toUpperCase() === "INR" || paymentMethod.toLowerCase() === "upi";

  if (isUpiOrInr) {
    const subtotalInr = Math.round(planConfig.baseAmountUsd * EXCHANGE_RATE); // ₹774 or ₹5,074
    const gstInr = Math.round(subtotalInr * GST_RATE); // 18% GST: ₹139 or ₹913
    const totalInr = subtotalInr + gstInr; // Total: ₹913 or ₹5,987

    return {
      currency: "INR",
      baseAmountUsd: planConfig.baseAmountUsd,
      exchangeRate: EXCHANGE_RATE,
      subtotal: subtotalInr * 100, // in paise
      subtotalFormatted: `₹${subtotalInr.toLocaleString("en-IN")}`,
      taxRate: 18.0,
      taxAmount: gstInr * 100, // in paise
      taxAmountFormatted: `₹${gstInr.toLocaleString("en-IN")}`,
      totalAmount: totalInr * 100, // in paise
      totalAmountFormatted: `₹${totalInr.toLocaleString("en-IN")}`,
      durationDays: planConfig.durationDays,
      label: planConfig.label,
      isUpiSupported: true,
    };
  } else {
    const subtotalCents = planConfig.amountUsdCents; // 900 or 5900 cents ($9 or $59)
    const gstCents = Math.round(subtotalCents * GST_RATE); // 18% GST: 162 or 1062 cents ($1.62 or $10.62)
    const totalCents = subtotalCents + gstCents; // Total: 1062 or 6962 cents ($10.62 or $69.62)

    return {
      currency: "USD",
      baseAmountUsd: planConfig.baseAmountUsd,
      exchangeRate: EXCHANGE_RATE,
      subtotal: subtotalCents,
      subtotalFormatted: `$${(subtotalCents / 100).toFixed(2)}`,
      taxRate: 18.0,
      taxAmount: gstCents,
      taxAmountFormatted: `$${(gstCents / 100).toFixed(2)}`,
      totalAmount: totalCents,
      totalAmountFormatted: `$${(totalCents / 100).toFixed(2)}`,
      durationDays: planConfig.durationDays,
      label: planConfig.label,
      isUpiSupported: false,
    };
  }
};

/**
 * POST /api/payment/create-order
 * 1. Computes base subtotal + 18% GST tax
 * 2. Creates Razorpay Order with total amount (Subtotal + 18% GST)
 * 3. Records new order in the `orders` database table with itemized GST breakdown
 */
export const createOrder = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan = "monthly", currency = "USD", paymentMethod = "auto" } = req.body;

    const pricing = calculatePricingWithGST(plan, currency, paymentMethod);

    const orderOptions = {
      amount: pricing.totalAmount, // Charge amount includes 18% GST
      currency: pricing.currency,
      receipt: `rcpt_${userId.slice(0, 8)}_${Date.now()}`,
      notes: {
        userId,
        plan,
        baseAmountUsd: String(pricing.baseAmountUsd),
        subtotal: pricing.subtotalFormatted,
        gstRate: "18%",
        gstAmount: pricing.taxAmountFormatted,
        totalPayable: pricing.totalAmountFormatted,
        exchangeRate: String(pricing.exchangeRate),
        targetCurrency: pricing.currency,
        paymentMethodPreference: paymentMethod,
        label: pricing.label,
      },
    };

    const order = await razorpayInstance.orders.create(orderOptions);

    // 1. Insert order record into `orders` table with 18% GST columns
    const orderRecordId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO orders (
           id, user_id, razorpay_order_id, plan, billing_cycle,
           base_currency, base_amount, exchange_rate, currency,
           subtotal, tax_rate, tax_amount, amount, amount_formatted,
           payment_method_preference, status
         ) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created')`,
        [
          orderRecordId,
          userId,
          order.id,
          `pro_${plan}`,
          plan,
          pricing.baseAmountUsd,
          pricing.exchangeRate,
          pricing.currency,
          pricing.subtotal,
          pricing.taxRate,
          pricing.taxAmount,
          pricing.totalAmount,
          pricing.totalAmountFormatted,
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
        [paymentRecordId, userId, order.id, pricing.totalAmount, pricing.currency, plan, "created"]
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
      subtotalFormatted: pricing.subtotalFormatted,
      taxRate: "18% GST",
      taxAmountFormatted: pricing.taxAmountFormatted,
      amountFormatted: pricing.totalAmountFormatted,
      baseAmountUsd: pricing.baseAmountUsd,
      exchangeRate: pricing.exchangeRate,
      keyId: RAZORPAY_CONFIG.keyId,
      plan,
      label: pricing.label,
      isUpiSupported: pricing.isUpiSupported,
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
 * 3. Records successful transaction in `transactions` table with 18% GST breakdown
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
    const chargedAmount = matchedOrder?.amount || (matchedOrder?.currency === "INR" ? 91300 : 1062);
    const chargedCurrency = matchedOrder?.currency || "USD";
    const amountFormatted = matchedOrder?.amount_formatted || (chargedCurrency === "INR" ? `₹913` : `$10.62`);
    const subtotal = matchedOrder?.subtotal || (chargedCurrency === "INR" ? 77400 : 900);
    const taxAmount = matchedOrder?.tax_amount || (chargedCurrency === "INR" ? 13900 : 162);
    const taxRate = matchedOrder?.tax_rate || 18.0;

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

    // 3. Create successful payment transaction in `transactions` table with GST tax breakdown
    const transactionId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO transactions (
           id, order_id, user_id, razorpay_order_id, razorpay_payment_id,
           razorpay_signature, currency, subtotal, tax_rate, tax_amount,
           amount, amount_formatted, payment_method, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')`,
        [
          transactionId,
          matchedOrder?.id || razorpay_order_id,
          userId,
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature,
          chargedCurrency,
          subtotal,
          taxRate,
          taxAmount,
          chargedAmount,
          amountFormatted,
          paymentMethod || matchedOrder?.payment_method_preference || "card",
        ]
      );
      console.log(`[MySQL] Logged transaction ${transactionId} (including 18% GST) for payment ${razorpay_payment_id}`);
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

    return res.status(200).json({
      success: true,
      message: `🎉 Payment verified! You are now upgraded to ResumeAI PRO.`,
      transactionId,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountFormatted,
      currency: chargedCurrency,
      taxBreakdown: {
        subtotal: chargedCurrency === "INR" ? `₹${(subtotal / 100).toLocaleString("en-IN")}` : `$${(subtotal / 100).toFixed(2)}`,
        gstRate: "18%",
        gstAmount: chargedCurrency === "INR" ? `₹${(taxAmount / 100).toLocaleString("en-IN")}` : `$${(taxAmount / 100).toFixed(2)}`,
        total: amountFormatted,
      },
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
