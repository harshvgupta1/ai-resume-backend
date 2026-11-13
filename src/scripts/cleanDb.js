import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

const rawPwd = process.env.DB_PASSWORD || "";
const DB_PASSWORD = rawPwd.trim().replace(/^["']|["']$/g, "");

const pool = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER,
  password: DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Delete junk targetRole rows (raw JD text stored as role)
const [result] = await pool.execute(
  `DELETE FROM match_analyses WHERE target_role LIKE 'A fast-scaling%'`
);
console.log(`Deleted ${result.affectedRows} junk records.`);

// Show remaining
const [rows] = await pool.execute(
  `SELECT id, target_role, match_score, created_at FROM match_analyses ORDER BY created_at DESC`
);
console.log("Remaining analyses:");
rows.forEach(r => console.log(` - ${r.id.slice(0,8)} | ${r.target_role} | ${r.match_score}%`));

await pool.end();
