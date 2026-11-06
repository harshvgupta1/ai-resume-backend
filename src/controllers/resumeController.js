import crypto from "crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

import { pool } from "../config/db.js";
import { getGeminiModel } from "../config/gemini.js";

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

    const resumeId = crypto.randomUUID();

    // Save to MySQL
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
    } catch (dbErr) {
      console.warn("[MySQL] Warning: Could not save resume record to database:", dbErr.message);
    }

    // If jobDescription was sent in the same multipart request, immediately run match analysis!
    if (req.body.jobDescription) {
      req.body.resumeText = extractedText;
      req.body.resumeId = resumeId;
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
