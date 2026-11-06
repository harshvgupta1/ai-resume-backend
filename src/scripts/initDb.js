import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function initDatabase() {
  console.log("🔄 Initializing MySQL Database & Tables...");

  // First connect without specifying the database to ensure it exists
  const rootConn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
  });

  const dbName = process.env.DB_NAME || "ai_resume_screener";

  try {
    await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    console.log(`✅ Database \`${dbName}\` ensured.`);
    await rootConn.end();

    // Now connect to the database to create tables
    const dbConn = await mysql.createConnection({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: dbName,
    });

    // 1. Resumes table
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS resumes (
        id VARCHAR(36) PRIMARY KEY,
        candidate_name VARCHAR(255) NULL,
        file_name VARCHAR(255) NULL,
        file_size INT NULL,
        raw_text LONGTEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Table `resumes` created or verified.");

    // 2. Match Analyses table
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS match_analyses (
        id VARCHAR(36) PRIMARY KEY,
        resume_id VARCHAR(36) NULL,
        target_role VARCHAR(255) NULL,
        job_description LONGTEXT NOT NULL,
        match_score INT NOT NULL,
        verdict VARCHAR(50) NOT NULL,
        matching_skills JSON NOT NULL,
        missing_skills JSON NOT NULL,
        strengths JSON NOT NULL,
        improvements JSON NOT NULL,
        suggested_edits JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_resume (resume_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Table `match_analyses` created or verified.");

    // 3. Job Applications table
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS job_applications (
        id VARCHAR(36) PRIMARY KEY,
        company VARCHAR(255) NOT NULL,
        role VARCHAR(255) NOT NULL,
        salary VARCHAR(100) NULL,
        location VARCHAR(100) NULL,
        status ENUM('applied', 'interviewing', 'offered', 'rejected') DEFAULT 'applied',
        match_score INT NULL,
        applied_date VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Table `job_applications` created or verified.");

    await dbConn.end();
    console.log("🎉 All MySQL schema migrations executed successfully!");
  } catch (err) {
    console.error("❌ Failed to initialize database:", err.message);
    process.exit(1);
  }
}

initDatabase();
