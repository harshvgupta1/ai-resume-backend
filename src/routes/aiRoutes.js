import { Router } from "express";
import { matchResume } from "../controllers/aiController.js";
import { uploadAndParseResume } from "../controllers/resumeController.js";
import { upload } from "../middleware/upload.js";

const router = Router();

// POST /api/ai/match - Run AI evaluation with text input
router.post("/match", matchResume);

// POST /api/ai/match-file - Multipart upload with file + JD
router.post("/match-file", upload.single("resume"), uploadAndParseResume);

export default router;
