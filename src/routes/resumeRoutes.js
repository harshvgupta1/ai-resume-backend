import { Router } from "express";
import { uploadAndParseResume, getResumeById } from "../controllers/resumeController.js";
import { upload } from "../middleware/upload.js";

const router = Router();

// POST /api/resume/upload - Upload PDF and extract text
router.post("/upload", upload.single("resume"), uploadAndParseResume);

// GET /api/resume/:id - Fetch resume metadata
router.get("/:id", getResumeById);

export default router;
