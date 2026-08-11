import { nanoid } from "nanoid";
import { getDb, eq, lte } from "../db";
import { customerSessions } from "../../drizzle/schema";
import { logger } from "../_core/logger";

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Create a new customer session with a 30-day expiry.
 * Returns the opaque session token.
 */
export async function createCustomerSession(customerId: number): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const token = nanoid(64);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  await db.insert(customerSessions).values({
    customerId,
    token,
    expiresAt,
  });

  return token;
}

/**
 * Look up a customer session by token. Returns the session if valid and not expired, null otherwise.
 */
export async function getCustomerSession(token: string) {
  const db = await getDb();
  if (!db) return null;

  const [session] = await db
    .select()
    .from(customerSessions)
    .where(eq(customerSessions.token, token))
    .limit(1);

  if (!session) return null;
  if (new Date() > session.expiresAt) {
    // Expired — clean up
    await db.delete(customerSessions).where(eq(customerSessions.id, session.id));
    return null;
  }

  return session;
}

/**
 * Destroy a customer session by token.
 */
export async function destroyCustomerSession(token: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await db.delete(customerSessions).where(eq(customerSessions.token, token));
}

/**
 * Delete all expired customer sessions.
 */
export async function cleanupExpiredSessions(): Promise<void> {
  try {
    const db = await getDb();
    if (db) {
      await db.delete(customerSessions).where(lte(customerSessions.expiresAt, new Date()));
    }
  } catch (err) {
    logger.error("[CustomerSession] Cleanup error", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Cleanup expired sessions every 30 minutes
setInterval(cleanupExpiredSessions, 30 * 60 * 1000).unref();
