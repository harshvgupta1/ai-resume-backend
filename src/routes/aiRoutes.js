import { Router } from "express";
import { matchResume, getAnalysisHistory, deleteAnalysis } from "../controllers/aiController.js";
import { uploadAndParseResume } from "../controllers/resumeController.js";
import { upload } from "../middleware/upload.js";

const router = Router();

// GET /api/ai/history - Fetch past match analyses from MySQL
router.get("/history", getAnalysisHistory);

// DELETE /api/ai/history/:id - Delete a match analysis from MySQL
router.delete("/history/:id", deleteAnalysis);

// POST /api/ai/match - Run AI evaluation with text input
router.post("/match", matchResume);

// POST /api/ai/match-file - Multipart upload with file + JD
router.post("/match-file", upload.single("resume"), uploadAndParseResume);

export default router;
