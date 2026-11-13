import { Router } from "express";
import { createOrder, verifyPayment } from "../controllers/paymentController.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = Router();

// POST /api/payment/create-order - Initialize Razorpay Order (Authenticated)
router.post("/create-order", authenticateToken, createOrder);

// POST /api/payment/verify - Verify HMAC signature & activate PRO status (Authenticated)
router.post("/verify", authenticateToken, verifyPayment);

export default router;
