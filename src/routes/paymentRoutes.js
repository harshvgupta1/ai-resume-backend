import { Router } from "express";
import {
  createOrder,
  verifyPayment,
  getSubscription,
  cancelSubscription,
} from "../controllers/paymentController.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = Router();

// POST /api/payment/create-order - Initialize Razorpay Order (Authenticated)
router.post("/create-order", authenticateToken, createOrder);

// POST /api/payment/verify - Verify HMAC signature & activate PRO status (Authenticated)
router.post("/verify", authenticateToken, verifyPayment);

// GET /api/payment/subscription - Get active subscription & expiry details (Authenticated)
router.get("/subscription", authenticateToken, getSubscription);

// POST /api/payment/cancel - Cancel auto-renewal at period end (Authenticated)
router.post("/cancel", authenticateToken, cancelSubscription);

export default router;
