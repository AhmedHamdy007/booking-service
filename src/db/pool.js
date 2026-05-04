const { Pool } = require("pg");
const config = require("../config");

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: parseInt(process.env.PG_POOL_MAX || "20", 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
  allowExitOnIdle: true,
});

pool.on("error", (err) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "booking-service",
    level: "ERROR",
    message: "Unexpected pool error",
    error: err.message,
  }));
});

async function query(text, params) {
  return pool.query(text, params);
}

async function healthCheck() {
  await query("SELECT 1");
}

function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}

module.exports = {
  pool,
  query,
  healthCheck,
  getPoolStats,
};
