import { Router } from "express";
import {
  createOrder,
  verifyPayment,
  getSubscription,
  cancelSubscription,
  getUserOrders,
  getUserTransactions,
} from "../controllers/paymentController.js";
import { authenticateToken } from "../middleware/authMiddleware.js";

const router = Router();

// POST /api/payment/create-order - Initialize Razorpay Order (Authenticated)
router.post("/create-order", authenticateToken, createOrder);

// POST /api/payment/verify - Verify HMAC signature & activate PRO status (Authenticated)
router.post("/verify", authenticateToken, verifyPayment);

// GET /api/payment/subscription - Get active subscription & expiry details (Authenticated)
router.get("/subscription", authenticateToken, getSubscription);

// GET /api/payment/orders - Order history (Authenticated)
router.get("/orders", authenticateToken, getUserOrders);

// GET /api/payment/transactions - Transaction records (Authenticated)
router.get("/transactions", authenticateToken, getUserTransactions);

// POST /api/payment/cancel - Cancel auto-renewal at period end (Authenticated)
router.post("/cancel", authenticateToken, cancelSubscription);

export default router;
