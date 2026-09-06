import type { Request, Response } from "express";
import { getDb, sql } from "../db";
import { logger } from "./logger";
import pkg from "../../package.json";

const startedAt = Date.now();
const version = pkg.version;
const revision = process.env.APP_REVISION || process.env.RAILWAY_GIT_COMMIT_SHA || "local";

export function livenessHandler(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ status: "ok", version, revision, uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
}

// Collapse concurrent probes so a database outage cannot fill the connection pool.
let pending: Promise<void> | undefined;
export async function probeDatabase() {
  if (!pending) {
    pending = (async () => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      // Test a required table as well as the connection: an empty DB is not ready.
      await db.execute(sql`SELECT id FROM users LIMIT 1`);
    })().finally(() => { pending = undefined; });
  }
  return pending;
}

export async function readinessHandler(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([probeDatabase(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Readiness timeout")), 3000);
    })]);
    res.json({ status: "ready", version, revision });
  } catch {
    logger.warn("health.not_ready");
    res.status(503).json({ status: "not_ready", version, revision });
  } finally {
    clearTimeout(timer);
  }
}
