/* eslint-disable no-console */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const migrationsDir = path.join(__dirname, "..", "migrations");
const connectionString =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/booking_db";

function getDatabaseName(urlString) {
  const parsed = new URL(urlString);
  return parsed.pathname.replace(/^\//, "");
}

function withDatabase(urlString, databaseName) {
  const parsed = new URL(urlString);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function ensureDatabaseExists() {
  const databaseName = getDatabaseName(connectionString);
  if (!databaseName) return;

  const adminConnectionString = withDatabase(connectionString, "postgres");
  const adminPool = new Pool({ connectionString: adminConnectionString });

  try {
    const result = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1",
      [databaseName]
    );
    if (result.rowCount > 0) return;

    console.log(`Creating database ${databaseName} ...`);
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    console.log(`Created database ${databaseName}`);
  } finally {
    await adminPool.end();
  }
}

async function run() {
  const pool = new Pool({ connectionString });
  let client;
  let poolClosed = false;
  let inTransaction = false;
  let currentMigration = null;

  try {
    client = await pool.connect();
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const filename of files) {
      const check = await client.query(
        "SELECT 1 FROM _migrations WHERE filename = $1 LIMIT 1",
        [filename]
      );
      if (check.rowCount > 0) {
        console.log(`Skipping ${filename} (already applied)`);
        continue;
      }

      currentMigration = filename;
      console.log(`Applying ${filename} ...`);
      const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(sql);
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [filename]);
      await client.query("COMMIT");
      inTransaction = false;
      console.log(`Applied ${filename}`);
    }

    console.log("Migrations complete.");
  } catch (error) {
    if (error.code === "3D000") {
      await ensureDatabaseExists();
      await pool.end();
      poolClosed = true;
      return run();
    }
    if (client && inTransaction) {
      await client.query("ROLLBACK");
    }
    console.error(
      `Migration failed${currentMigration ? ` in ${currentMigration}` : ""}:`,
      error.message
    );
    process.exitCode = 1;
  } finally {
    if (client) {
      client.release();
    }
    if (!poolClosed) {
      await pool.end();
    }
  }
}

run();
