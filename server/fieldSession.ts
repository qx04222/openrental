import { randomUUID } from "crypto";
import { logger } from "./_core/logger";
import { getDb, eq, and } from "./db";
import { sessions } from "../drizzle/schema";
import { lte } from "drizzle-orm";

/** How long a field session lives (30 days max) */
const MAX_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Create a new field staff session and return the opaque token.
 */
export async function createFieldSession(userId: number, durationMs?: number): Promise<string> {
  const token = randomUUID();
  const duration = durationMs ?? MAX_SESSION_DURATION_MS;
  const expiresAt = new Date(Date.now() + duration);

  // Persist to database BEFORE returning token
  await persistFieldSession(token, userId, expiresAt);

  logger.info(`[FieldSession] Created session for userId=${userId}`);
  return token;
}

async function persistFieldSession(token: string, userId: number, expiresAt: Date) {
  const db = await getDb();
  if (!db) throw new Error("Database not available for session creation");
  await db.insert(sessions).values({
    token,
    sessionType: "field",
    userId,
    expiresAt,
  });
}

/**
 * Look up the userId for a field session token. Returns undefined if invalid/expired.
 */
export async function getFieldSessionUserId(token: string): Promise<number | undefined> {
  try {
    const db = await getDb();
    if (!db) return undefined;

    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.token, token), eq(sessions.sessionType, "field")))
      .limit(1);

    if (!session) return undefined;
    if (Date.now() > session.expiresAt.getTime()) {
      await db.delete(sessions).where(eq(sessions.token, token));
      return undefined;
    }

    return session.userId;
  } catch (err) {
    logger.error("[FieldSession] Failed to read session", { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/**
 * Destroy a field session (logout).
 */
export async function destroyFieldSession(token: string): Promise<void> {
  try {
    const db = await getDb();
    if (db) {
      await db.delete(sessions).where(eq(sessions.token, token));
    }
  } catch (err) {
    logger.error("[FieldSession] Failed to delete session", { error: err instanceof Error ? err.message : String(err) });
  }
  logger.info("[FieldSession] Session destroyed");
}

/** Cleanup expired field sessions. Exported for testing. */
export async function cleanupExpiredSessions(): Promise<void> {
  try {
    const db = await getDb();
    if (db) {
      await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
    }
  } catch (err) {
    logger.error("[FieldSession] Cleanup error", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Cleanup expired sessions every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000).unref();
