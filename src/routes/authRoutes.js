import { Router } from "express";
import { googleLogin, getMe, upgradePlan } from "../controllers/authController.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = Router();

// POST /api/auth/google - Authenticate or register with Google OAuth
router.post("/google", googleLogin);

// GET /api/auth/me - Get current logged-in user session profile
router.get("/me", authenticateToken, getMe);

// POST /api/auth/upgrade - Upgrade user plan (Free -> Pro)
router.post("/upgrade", authenticateToken, upgradePlan);

export default router;
