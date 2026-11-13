import crypto from "crypto";
import jwt from "jsonwebtoken";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

import { pool } from "../config/db.js";
import { getGeminiModel } from "../config/gemini.js";

const JWT_SECRET = process.env.JWT_SECRET || "ai_resume_super_secret_jwt_key_2026";

export const uploadAndParseResume = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No resume file was uploaded." });
    }

    let extractedText = "";

    if (req.file.mimetype === "application/pdf") {
      const parsed = await pdfParse(req.file.buffer);
      extractedText = parsed.text;
    } else {
      // Plain text or utf-8 fallback
      extractedText = req.file.buffer.toString("utf-8");
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: "Could not extract text from the provided document." });
    }

    // Extract user from token
    const authHeader = req.headers.authorization;
    let userId = null;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      try {
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.id;
      } catch (e) {}
    }

    // Require sign in so we can accurately track the 3 free scans
    if (!userId) {
      return res.status(401).json({
        error: "Please sign in to scan your resume and claim your 3 free AI analyses.",
        requiresAuth: true,
      });
    }

    // Check user plan and quota
    const [userRows] = await pool.query(
      "SELECT plan, scans_used, pro_expires_at FROM users WHERE id = ?",
      [userId]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ error: "User account not found." });
    }

    const userRecord = userRows[0];
    const isPro = userRecord.plan === "pro";
    const scansUsed = userRecord.scans_used || 0;
    const FREE_LIMIT = 3;

    if (!isPro && scansUsed >= FREE_LIMIT) {
      return res.status(403).json({
        error: `You have reached your limit of ${FREE_LIMIT} free scans. Upgrade to Pro for unlimited AI scans!`,
        upgradeRequired: true,
        scansUsed,
        scansLimit: FREE_LIMIT,
      });
    }

    const resumeId = crypto.randomUUID();

    // Save resume to MySQL
    try {
      await pool.query(
        `INSERT INTO resumes (id, user_id, candidate_name, file_name, file_size, raw_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          resumeId,
          userId,
          req.body.candidateName || null,
          req.file.originalname,
          req.file.size,
          extractedText,
        ]
      );
    } catch (dbErr) {
      try {
        await pool.query(
          `INSERT INTO resumes (id, candidate_name, file_name, file_size, raw_text)
           VALUES (?, ?, ?, ?, ?)`,
          [
            resumeId,
            req.body.candidateName || null,
            req.file.originalname,
            req.file.size,
            extractedText,
          ]
        );
      } catch (fallbackErr) {
        console.warn("[MySQL] Warning: Could not save resume record to database:", fallbackErr.message);
      }
    }

    // If jobDescription was sent in the same multipart request, immediately run match analysis!
    if (req.body.jobDescription) {
      req.body.resumeText = extractedText;
      req.body.resumeId = resumeId;
      req.userId = userId;
      req.userPlan = userRecord.plan || "free";
      req.scansUsed = scansUsed;
      const { matchResume } = await import("./aiController.js");
      return matchResume(req, res);
    }

    return res.status(200).json({
      success: true,
      resumeId,
      fileName: req.file.originalname,
      characterCount: extractedText.length,
      extractedSnippet: extractedText.slice(0, 300) + "...",
    });
  } catch (error) {
    console.error("Error processing resume upload:", error);
    return res.status(500).json({
      error: "Failed to parse resume document.",
      details: error.message,
    });
  }
};

export const getResumeById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(`SELECT id, candidate_name, file_name, file_size, created_at FROM resumes WHERE id = ?`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Resume not found." });
    }
    return res.status(200).json(rows[0]);
  } catch (error) {
    return res.status(500).json({ error: "Failed to retrieve resume.", details: error.message });
  }
};
