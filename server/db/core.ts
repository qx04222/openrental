import { eq, and, gte, desc, asc, or, lte, lt, gt, ne, like, ilike, sql, inArray, isNull, isNotNull } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { logger } from "../_core/logger";

let _db: ReturnType<typeof drizzle> | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

const isProduction = process.env.NODE_ENV === "production";

export function resolveDatabasePoolMax(_production: boolean) {
  return 10;
}

async function createConnection() {
  if (_sql) return _sql;

  if (!process.env.DATABASE_URL) {
    logger.warn("DATABASE_URL not configured");
    return null;
  }

  try {
    _sql = postgres(process.env.DATABASE_URL, {
      max: resolveDatabasePoolMax(isProduction),
      idle_timeout: 60,
      connect_timeout: 30,
      ssl: "prefer",
      prepare: false,
    });
    logger.info("PostgreSQL connection pool created");
    return _sql;
  } catch (error) {
    logger.error("Failed to create connection pool", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const sql = await createConnection();
      if (sql) {
        _db = drizzle(sql);
      }
    } catch (error) {
      logger.warn("Failed to connect", { error: error instanceof Error ? error.message : String(error) });
      _db = null;
    }
  }
  return _db;
}

export async function closePool() {
  if (_sql) {
    await _sql.end();
    _sql = null;
    _db = null;
    logger.info("Connection pool closed");
  }
}

export { eq, and, gte, desc, asc, or, lte, lt, gt, ne, like, ilike, sql, inArray, isNull, isNotNull };
