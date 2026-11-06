import { Router } from "express";
import { getJobs, createJob, updateJobStatus, deleteJob } from "../controllers/jobController.js";

const router = Router();

// GET /api/jobs - List all tracked job applications
router.get("/", getJobs);

// POST /api/jobs - Add a new application
router.post("/", createJob);

// PATCH /api/jobs/:id/status - Move Kanban status
router.patch("/:id/status", updateJobStatus);

// DELETE /api/jobs/:id - Remove application
router.delete("/:id", deleteJob);

export default router;
