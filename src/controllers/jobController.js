import crypto from "crypto";
import { pool } from "../config/db.js";

export const getJobs = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM job_applications ORDER BY created_at DESC`
    );
    return res.status(200).json(rows);
  } catch (error) {
    console.warn("[MySQL] Warning retrieving jobs from DB:", error.message);
    // Return empty list if DB is initializing
    return res.status(200).json([]);
  }
};

export const createJob = async (req, res) => {
  try {
    const { company, role, salary, location, status, matchScore, appliedDate } = req.body;

    if (!company || !role) {
      return res.status(400).json({ error: "Company and role are required." });
    }

    const id = crypto.randomUUID();
    const query = `
      INSERT INTO job_applications (id, company, role, salary, location, status, match_score, applied_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await pool.query(query, [
      id,
      company,
      role,
      salary || null,
      location || null,
      status || "applied",
      matchScore || null,
      appliedDate || new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    ]);

    return res.status(201).json({
      id,
      company,
      role,
      salary,
      location,
      status: status || "applied",
      matchScore,
      appliedDate,
    });
  } catch (error) {
    console.error("Error creating job application:", error);
    return res.status(500).json({ error: "Failed to create job application.", details: error.message });
  }
};

export const updateJobStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = ["applied", "interviewing", "offered", "rejected"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status provided." });
    }

    await pool.query(`UPDATE job_applications SET status = ? WHERE id = ?`, [status, id]);
    return res.status(200).json({ success: true, id, status });
  } catch (error) {
    return res.status(500).json({ error: "Failed to update job status.", details: error.message });
  }
};

export const deleteJob = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(`DELETE FROM job_applications WHERE id = ?`, [id]);
    return res.status(200).json({ success: true, message: "Job application deleted." });
  } catch (error) {
    return res.status(500).json({ error: "Failed to delete job application.", details: error.message });
  }
};
