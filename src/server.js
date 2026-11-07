import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import { testDbConnection } from "./config/db.js";

// Routes
import authRoutes from "./routes/authRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import resumeRoutes from "./routes/resumeRoutes.js";
import jobRoutes from "./routes/jobRoutes.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

// Middlewares
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(morgan("dev"));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Health Check Endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "AI Resume Screener Backend",
    timestamp: new Date().toISOString(),
    database: "MySQL (Connection Pool Ready)",
  });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/resume", resumeRoutes);
app.use("/api/jobs", jobRoutes);

// Centralized 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.url} not found` });
});

// Centralized Error Handler
app.use((err, req, res, next) => {
  console.error("[Server Error]:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`\n🚀 Backend API server is running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Connected to client origin: ${process.env.CLIENT_URL || "http://localhost:3000"}`);

  // Test MySQL DB connection
  await testDbConnection();
});
