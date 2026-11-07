import { Router } from "express";
import { googleLogin, getMe } from "../controllers/authController.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = Router();

// POST /api/auth/google - Authenticate or register with Google OAuth
router.post("/google", googleLogin);

// GET /api/auth/me - Get current logged-in user session profile
router.get("/me", authenticateToken, getMe);

export default router;
