import type { Request, Response } from "express";
import { randomBytes } from "crypto";
import { logger } from "./_core/logger";
import { ADMIN_COOKIE_NAME } from "../shared/const";
import { getDb, eq, and } from "./db";
import { sessions } from "../drizzle/schema";
import { lte } from "drizzle-orm";

const DEFAULT_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const REMEMBER_ME_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdminSessionData {
  sessionId: string;
  userId: number;
  email: string;
  role: "admin" | "super_admin" | "accountant";
  createdAt: Date;
  expiresAt: Date;
  rememberMe: boolean;
}

export async function createAdminSession(
  res: Response,
  payload: { email: string; role?: "admin" | "super_admin" | "accountant"; userId?: number },
  options?: { rememberMe?: boolean; durationMs?: number }
): Promise<string> {
  const sessionId = randomBytes(32).toString("hex");
  const rememberMe = options?.rememberMe ?? false;
  const durationMs = options?.durationMs ?? (rememberMe ? REMEMBER_ME_DURATION_MS : DEFAULT_SESSION_DURATION_MS);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);

  // Persist session to database BEFORE setting cookie
  if (payload.userId) {
    await persistSession(sessionId, payload.userId, payload.email, payload.role || "admin", expiresAt);
  }

  const isProduction = process.env.NODE_ENV === "production";
  res.cookie(ADMIN_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: durationMs,
    expires: expiresAt,
  });

  logger.info(`[AdminSession] Created session for ${payload.email}`);
  return sessionId;
}

async function persistSession(token: string, userId: number, email: string, role: string, expiresAt: Date) {
  const db = await getDb();
  if (!db) throw new Error("Database not available for session creation");
  await db.insert(sessions).values({
    token,
    sessionType: "admin",
    userId,
    email,
    role,
    expiresAt,
  });
}

export async function getAdminSession(req: Request): Promise<AdminSessionData | null> {
  const sessionId = req.cookies[ADMIN_COOKIE_NAME];
  if (!sessionId) return null;

  try {
    const db = await getDb();
    if (!db) return null;

    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.token, sessionId), eq(sessions.sessionType, "admin")))
      .limit(1);

    if (!session) return null;
    if (new Date() > session.expiresAt) {
      // Clean up expired
      await db.delete(sessions).where(eq(sessions.token, sessionId));
      return null;
    }

    return {
      sessionId: session.token,
      userId: session.userId,
      email: session.email || "",
      role: (session.role as "admin" | "super_admin" | "accountant") || "admin",
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      rememberMe: false,
    };
  } catch (err) {
    logger.error("[AdminSession] Failed to read session", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function destroyAdminSession(req: Request, res: Response): Promise<void> {
  const sessionId = req.cookies[ADMIN_COOKIE_NAME];
  if (sessionId) {
    try {
      const db = await getDb();
      if (db) {
        await db.delete(sessions).where(eq(sessions.token, sessionId));
      }
    } catch (err) {
      logger.error("[AdminSession] Failed to delete session", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  res.clearCookie(ADMIN_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  logger.info("[AdminSession] Session destroyed");
}

/** Cleanup expired admin sessions. Exported for testing. */
export async function cleanupExpiredSessions(): Promise<void> {
  try {
    const db = await getDb();
    if (db) {
      await db.delete(sessions).where(lte(sessions.expiresAt, new Date()));
    }
  } catch (err) {
    logger.error("[AdminSession] Cleanup error", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Cleanup expired sessions every hour
setInterval(cleanupExpiredSessions, 60 * 60 * 1000).unref();
