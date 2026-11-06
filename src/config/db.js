import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

// Create connection pool for MySQL
export const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "ai_resume_screener",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Health check function to test database connectivity
export async function testDbConnection() {
  try {
    const connection = await pool.getConnection();
    console.log("✅ [MySQL] Successfully connected to database pool.");
    connection.release();
    return true;
  } catch (error) {
    console.warn("⚠️  [MySQL Warning] Could not connect to MySQL server:", error.message);
    console.warn("   -> Make sure MySQL is running on host:", process.env.DB_HOST || "localhost", "port:", process.env.DB_PORT || 3306);
    return false;
  }
}
