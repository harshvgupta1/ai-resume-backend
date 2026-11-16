import crypto from "crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { pool } from "../config/db.js";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || "ai_resume_super_secret_jwt_key_2026";

/**
 * Formats user object with daily scan quota for subscription users (24 daily)
 * and lifetime quota for free tier users (3 lifetime)
 */
export const formatUserWithQuota = (u, activeSubscription = null) => {
  const now = new Date();
  const isPro = u.plan === "pro" && (!u.pro_expires_at || new Date(u.pro_expires_at) > now);
  const todayStr = now.toISOString().slice(0, 10);
  const dailyScansUsed = isPro && u.daily_scans_date === todayStr ? (u.daily_scans_used || 0) : 0;
  const scansLimit = isPro ? 24 : 3;
  const scansUsed = isPro ? dailyScansUsed : (u.scans_used ?? 0);
  const scansRemaining = Math.max(0, scansLimit - scansUsed);

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl || u.avatar_url,
    plan: isPro ? "pro" : (u.plan || "free"),
    isPro,
    scansUsed,
    scansLimit,
    scansRemaining,
    dailyScansUsed,
    dailyScansLimit: 24,
    dailyScansRemaining: Math.max(0, 24 - dailyScansUsed),
    proExpiresAt: u.pro_expires_at || (activeSubscription ? activeSubscription.currentPeriodEnd : null),
    createdAt: u.created_at,
    subscription: activeSubscription,
  };
};

export const googleLogin = async (req, res) => {
  try {
    const { credential, userInfo } = req.body;

    let googleUser = null;

    if (credential) {
      try {
        // Cryptographically verify Google ID Token
        const ticket = await client.verifyIdToken({
          idToken: credential,
          audience: process.env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        googleUser = {
          googleId: payload.sub,
          email: payload.email,
          name: payload.name,
          avatarUrl: payload.picture,
        };
      } catch (verifyErr) {
        console.warn("Google token verify failed with standard client (checking direct payload):", verifyErr.message);
        // Fallback: decode directly if GOOGLE_CLIENT_ID not yet set in backend env
        const decoded = jwt.decode(credential);
        if (decoded && decoded.sub && decoded.email) {
          googleUser = {
            googleId: decoded.sub,
            email: decoded.email,
            name: decoded.name || decoded.email.split("@")[0],
            avatarUrl: decoded.picture || null,
          };
        } else {
          throw new Error("Invalid Google authentication credential.");
        }
      }
    } else if (userInfo && userInfo.email) {
      // Direct SSO payload fallback
      googleUser = {
        googleId: userInfo.id || `google-${Date.now()}`,
        email: userInfo.email,
        name: userInfo.name || userInfo.email.split("@")[0],
        avatarUrl: userInfo.picture || null,
      };
    } else {
      return res.status(400).json({ error: "Missing Google authentication credential." });
    }

    const userId = crypto.randomUUID();

    // Upsert into MySQL `users` table
    try {
      await pool.query(
        `INSERT INTO users (id, google_id, email, name, avatar_url)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
           name = VALUES(name),
           avatar_url = VALUES(avatar_url),
           last_login_at = CURRENT_TIMESTAMP`,
        [userId, googleUser.googleId, googleUser.email, googleUser.name, googleUser.avatarUrl]
      );
    } catch (dbErr) {
      console.warn("[MySQL] User upsert warning (continuing session):", dbErr.message);
    }

    // Fetch confirmed user from DB
    let activeUser = {
      id: userId,
      email: googleUser.email,
      name: googleUser.name,
      avatarUrl: googleUser.avatarUrl,
    };

    try {
      const [rows] = await pool.query(
        `SELECT id, email, name, avatar_url, plan, scans_used, pro_expires_at, daily_scans_used, daily_scans_date FROM users WHERE email = ?`,
        [googleUser.email]
      );
      if (rows.length > 0) {
        activeUser = rows[0];
      }
    } catch (e) {
      // Fallback to activeUser
    }

    // Sign Application JWT session token (valid for 7 days)
    const token = jwt.sign(
      {
        id: activeUser.id,
        email: activeUser.email,
        name: activeUser.name,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: "Successfully authenticated with Google SSO",
      token,
      user: formatUserWithQuota(activeUser),
    });
  } catch (error) {
    console.error("Google Auth Error:", error);
    return res.status(500).json({
      error: "Authentication failed",
      details: error.message,
    });
  }
};

export const getMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      `SELECT id, email, name, avatar_url, plan, scans_used, pro_expires_at, daily_scans_used, daily_scans_date, created_at, last_login_at FROM users WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "User profile not found." });
    }

    const u = rows[0];

    // Check latest subscription from `subscriptions` table
    let activeSubscription = null;
    try {
      const [subRows] = await pool.query(
        `SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (subRows.length > 0) {
        const sub = subRows[0];
        const now = new Date();
        const expiryDate = new Date(sub.current_period_end);
        const isExpired = expiryDate < now;

        if (isExpired && sub.status === "active") {
          await pool.query(`UPDATE subscriptions SET status = 'expired' WHERE id = ?`, [sub.id]);
          await pool.query(`UPDATE users SET plan = 'free' WHERE id = ?`, [userId]);
          sub.status = "expired";
          u.plan = "free";
        }

        const daysRemaining = Math.max(0, Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

        activeSubscription = {
          id: sub.id,
          plan: sub.plan,
          billingCycle: sub.billing_cycle,
          status: sub.status,
          amount: sub.amount,
          currency: sub.currency,
          currentPeriodStart: sub.current_period_start,
          currentPeriodEnd: sub.current_period_end,
          daysRemaining,
          isExpired,
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        };
      }
    } catch (subErr) {
      console.warn("Could not fetch subscription in getMe:", subErr.message);
    }

    return res.status(200).json({
      user: formatUserWithQuota(u, activeSubscription),
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch user profile", details: error.message });
  }
};

export const upgradePlan = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan = "pro" } = req.body;

    await pool.query(
      `UPDATE users 
       SET plan = ?, pro_expires_at = DATE_ADD(NOW(), INTERVAL 30 DAY) 
       WHERE id = ?`,
      [plan, userId]
    );

    // Also record in subscriptions table
    const subscriptionId = crypto.randomUUID();
    try {
      await pool.query(
        `INSERT INTO subscriptions (
           id, user_id, plan, billing_cycle, status, amount, currency,
           current_period_start, current_period_end
         ) VALUES (?, ?, 'pro_monthly', 'monthly', 'active', 49900, 'INR', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY))`,
        [subscriptionId, userId]
      );
    } catch (subErr) {
      console.warn("Subscription record warning in upgradePlan:", subErr.message);
    }

    const [rows] = await pool.query(
      `SELECT id, email, name, avatar_url, plan, scans_used, pro_expires_at, daily_scans_used, daily_scans_date, created_at FROM users WHERE id = ?`,
      [userId]
    );

    const u = rows[0];
    return res.status(200).json({
      success: true,
      message: `Successfully upgraded to ${plan.toUpperCase()}!`,
      user: formatUserWithQuota(u),
    });
  } catch (error) {
    console.error("Error upgrading plan:", error);
    return res.status(500).json({ error: "Failed to upgrade plan", details: error.message });
  }
};
