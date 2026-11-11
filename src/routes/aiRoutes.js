import { Router } from "express";
import { matchResume, getAnalysisHistory } from "../controllers/aiController.js";
import { uploadAndParseResume } from "../controllers/resumeController.js";
import { upload } from "../middleware/upload.js";

const router = Router();

// GET /api/ai/history - Fetch past match analyses from MySQL
router.get("/history", getAnalysisHistory);

// POST /api/ai/match - Run AI evaluation with text input
router.post("/match", matchResume);

// POST /api/ai/match-file - Multipart upload with file + JD
router.post("/match-file", upload.single("resume"), uploadAndParseResume);

export default router;
