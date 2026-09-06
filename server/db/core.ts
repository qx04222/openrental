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

/** Reserve one physical connection: a session advisory lock must not move
 * between pooled connections. It prevents overlapping healthy runners; business
 * idempotency still handles crashes and retries. No schema migration required. */
export async function withDatabaseJobLock(name: string, work: () => Promise<unknown>): Promise<boolean> {
  const pool = await createConnection();
  if (!pool) throw new Error("Database unavailable for scheduled job");
  const connection = await pool.reserve();
  let acquired = false;
  try {
    const [row] = await connection`SELECT pg_try_advisory_lock(hashtextextended(${"openrental:job:" + name}, 0)) AS acquired`;
    acquired = row.acquired === true;
    if (!acquired) return false;
    await work();
    return true;
  } finally {
    try {
      if (acquired) await connection`SELECT pg_advisory_unlock(hashtextextended(${"openrental:job:" + name}, 0))`;
    } finally { connection.release(); }
  }
}

export { eq, and, gte, desc, asc, or, lte, lt, gt, ne, like, ilike, sql, inArray, isNull, isNotNull };
