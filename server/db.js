/* Postgres pool. Works without DATABASE_URL (local demo falls back to memory). */
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function q(text, params) {
  if (!pool) {
    const err = new Error("database not configured");
    err.code = "NO_DATABASE";
    throw err;
  }
  return pool.query(text, params);
}

module.exports = { q, hasDb: !!pool };
