import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

async function initDatabase() {
  console.log("🔄 Initializing MySQL Database & Tables...");

  const dbHost = process.env.DB_HOST || "localhost";
  const dbPort = Number(process.env.DB_PORT) || 3306;
  const dbUser = process.env.DB_USER || "root";
  const dbPassword = (process.env.DB_PASSWORD || "").trim().replace(/^["']|["']$/g, "");
  const dbName = process.env.DB_NAME || "ai_resume_screener";

  try {
    const rootConn = await mysql.createConnection({
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword,
    });

    await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    console.log(`✅ Database \`${dbName}\` ensured.`);
    await rootConn.end();

    const dbConn = await mysql.createConnection({
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword,
      database: dbName,
    });

    // 1. Users table (for Google SSO OAuth)
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        avatar_url TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Table `users` created or verified.");

    // 2. Resumes table
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS resumes (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NULL,
        candidate_name VARCHAR(255) NULL,
        file_name VARCHAR(255) NULL,
        file_size INT NULL,
        raw_text LONGTEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Table `resumes` created or verified.");

    // 3. Match Analyses table
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS match_analyses (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NULL,
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
        INDEX idx_user (user_id),
        INDEX idx_resume (resume_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Table `match_analyses` created or verified.");

    // 4. Job Applications table
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS job_applications (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NULL,
        company VARCHAR(255) NOT NULL,
        role VARCHAR(255) NOT NULL,
        salary VARCHAR(100) NULL,
        location VARCHAR(100) NULL,
        status ENUM('applied', 'interviewing', 'offered', 'rejected') DEFAULT 'applied',
        match_score INT NULL,
        applied_date VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Table `job_applications` created or verified.");

    // 5. Payments table
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        order_id VARCHAR(255) NOT NULL,
        payment_id VARCHAR(255) NULL,
        signature VARCHAR(255) NULL,
        amount INT NOT NULL,
        currency VARCHAR(10) DEFAULT 'INR',
        plan VARCHAR(20) DEFAULT 'monthly',
        status VARCHAR(50) DEFAULT 'created',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id),
        INDEX idx_order (order_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Table `payments` created or verified.");

    // 6. Subscriptions table (track recurring Pro plans and expiration dates)
    await dbConn.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(36) NOT NULL,
        plan VARCHAR(50) NOT NULL DEFAULT 'pro_monthly',
        billing_cycle ENUM('monthly', 'yearly') NOT NULL DEFAULT 'monthly',
        status ENUM('active', 'expired', 'cancelled', 'past_due') NOT NULL DEFAULT 'active',
        amount INT NOT NULL DEFAULT 49900,
        currency VARCHAR(10) NOT NULL DEFAULT 'INR',
        razorpay_order_id VARCHAR(255) NULL,
        razorpay_payment_id VARCHAR(255) NULL,
        razorpay_subscription_id VARCHAR(255) NULL,
        current_period_start TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        current_period_end TIMESTAMP NOT NULL,
        cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
        cancelled_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_status (status),
        INDEX idx_period_end (current_period_end)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("✅ Table `subscriptions` created or verified.");

    await dbConn.end();
    console.log("🎉 All MySQL schema migrations executed successfully!");
  } catch (err) {
    console.error("❌ Failed to initialize database:", err.message);
  }
}

initDatabase();
