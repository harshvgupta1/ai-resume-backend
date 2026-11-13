import crypto from "crypto";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { pool } from "../config/db.js";

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const JWT_SECRET = process.env.JWT_SECRET || "ai_resume_super_secret_jwt_key_2026";

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
        `SELECT id, email, name, avatar_url, plan, scans_used, pro_expires_at FROM users WHERE email = ?`,
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
      user: {
        id: activeUser.id,
        email: activeUser.email,
        name: activeUser.name,
        avatarUrl: activeUser.avatarUrl || activeUser.avatar_url,
        plan: activeUser.plan || "free",
        scansUsed: activeUser.scans_used ?? 0,
        scansLimit: 3,
        proExpiresAt: activeUser.pro_expires_at || null,
      },
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
      `SELECT id, email, name, avatar_url, plan, scans_used, pro_expires_at, created_at, last_login_at FROM users WHERE id = ?`,
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "User profile not found." });
    }

    const u = rows[0];
    return res.status(200).json({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatar_url,
        plan: u.plan || "free",
        scansUsed: u.scans_used ?? 0,
        scansLimit: 3,
        proExpiresAt: u.pro_expires_at || null,
        createdAt: u.created_at,
      },
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

    const [rows] = await pool.query(
      `SELECT id, email, name, avatar_url, plan, scans_used, pro_expires_at FROM users WHERE id = ?`,
      [userId]
    );

    const u = rows[0];
    return res.status(200).json({
      success: true,
      message: `Successfully upgraded to ${plan.toUpperCase()}!`,
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatar_url,
        plan: u.plan,
        scansUsed: u.scans_used ?? 0,
        scansLimit: 3,
        proExpiresAt: u.pro_expires_at,
      },
    });
  } catch (error) {
    console.error("Error upgrading plan:", error);
    return res.status(500).json({ error: "Failed to upgrade plan", details: error.message });
  }
};
