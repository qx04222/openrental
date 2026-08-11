import express, { Request, Response } from "express";
import { createAdminSession, getAdminSession, destroyAdminSession } from "./adminSession";
import { getDb } from "./db";
import { users, loginSessions } from "../drizzle/schema";
import { eq, or, and, isNull } from "drizzle-orm";
import bcrypt from "bcrypt";
import { logger } from "./_core/logger";
import { checkRateLimit, purgeExpiredEntries } from "../shared/rateLimiter";
import type { RateLimitEntry } from "../shared/rateLimiter";
import { ADMIN_COOKIE_NAME } from "../shared/const";

function parseUserAgent(ua: string) {
  let browser = "Unknown";
  let os = "Unknown";
  let deviceType = "desktop";

  // Browser detection
  if (/Edg\/(\d+[\d.]*)/.test(ua)) browser = `Edge ${RegExp.$1}`;
  else if (/Chrome\/(\d+[\d.]*)/.test(ua)) browser = `Chrome ${RegExp.$1}`;
  else if (/Firefox\/(\d+[\d.]*)/.test(ua)) browser = `Firefox ${RegExp.$1}`;
  else if (/Safari\/(\d+[\d.]*)/.test(ua) && /Version\/(\d+[\d.]*)/.test(ua)) browser = `Safari ${RegExp.$1}`;

  // OS detection
  if (/Windows NT 10/.test(ua)) os = "Windows 10";
  else if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Mac OS X ([\d_]+)/.test(ua)) os = `macOS ${RegExp.$1.replace(/_/g, ".")}`;
  else if (/Android ([\d.]+)/.test(ua)) os = `Android ${RegExp.$1}`;
  else if (/iPhone OS ([\d_]+)/.test(ua)) os = `iOS ${RegExp.$1.replace(/_/g, ".")}`;
  else if (/Linux/.test(ua)) os = "Linux";

  // Device type
  if (/Mobile|Android.*Mobile|iPhone/.test(ua)) deviceType = "mobile";
  else if (/iPad|Android(?!.*Mobile)|Tablet/.test(ua)) deviceType = "tablet";

  return { browser, os, deviceType };
}

const router = express.Router();

export function getErrorDetails(error: unknown) {
  const err = error instanceof Error ? error : new Error(String(error));
  const raw = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};

  return {
    message: err.message,
    name: err.name,
    code: typeof raw.code === "string" ? raw.code : undefined,
    detail: typeof raw.detail === "string" ? raw.detail : undefined,
    constraint: typeof raw.constraint === "string" ? raw.constraint : undefined,
    table: typeof raw.table === "string" ? raw.table : undefined,
    column: typeof raw.column === "string" ? raw.column : undefined,
    cause: err.cause instanceof Error ? err.cause.message : err.cause,
    stack: err.stack,
  };
}

// Admin login rate limiter: max 10 attempts per 5 minutes per IP
const adminLoginLimiter = new Map<string, RateLimitEntry>();
const ADMIN_LOGIN_WINDOW = 5 * 60 * 1000;
const ADMIN_LOGIN_MAX = 10;

export function purgeAdminLoginLimiterEntries() {
  purgeExpiredEntries(adminLoginLimiter);
}

setInterval(purgeAdminLoginLimiterEntries, 30 * 60 * 1000).unref();

/**
 * POST /api/admin-auth/password-login
 */
router.post("/password-login", async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  // Rate limit by actual TCP connection IP (not X-Forwarded-For which can be spoofed)
  const ip = req.socket?.remoteAddress || req.ip || "unknown";
  if (!checkRateLimit(adminLoginLimiter, ip, ADMIN_LOGIN_WINDOW, ADMIN_LOGIN_MAX)) {
    const entry = adminLoginLimiter.get(ip);
    const retryAfterSec = entry ? Math.ceil((entry.resetAt - Date.now()) / 1000) : Math.ceil(ADMIN_LOGIN_WINDOW / 1000);
    res.set("Retry-After", String(retryAfterSec));
    return res.status(429).json({
      error: "TOO_MANY_ATTEMPTS",
      retryAfterSeconds: retryAfterSec,
    });
  }

  try {
    const db = await getDb();
    if (!db) return res.status(500).json({ error: "Database not available" });

    const [user] = await db
      .select()
      .from(users)
      .where(and(or(eq(users.username, username), eq(users.email, username)), isNull(users.deletedAt)))
      .limit(1);

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) return res.status(401).json({ error: "Invalid credentials" });

    if (user.role !== "admin" && user.role !== "super_admin" && user.role !== "accountant") {
      return res.status(403).json({ error: "Admin access required" });
    }
    if (!user.isActive) {
      return res.status(403).json({ error: "Account is inactive" });
    }

    await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

    // Login succeeded — clear rate limit for this IP so legitimate users aren't blocked
    adminLoginLimiter.delete(ip);

    const userRole = (user.role as "admin" | "super_admin" | "accountant") || "admin";
    const sessionToken = await createAdminSession(res, { email: user.email || username, role: userRole, userId: user.id });

    // Auto-close any previous unclosed sessions for this user
    try {
      const _now = new Date();
      const staleRows = await db
        .select({ id: loginSessions.id, loginAt: loginSessions.loginAt, lastActiveAt: loginSessions.lastActiveAt })
        .from(loginSessions)
        .where(and(eq(loginSessions.userId, user.id), isNull(loginSessions.logoutAt)));
      for (const row of staleRows) {
        const endTime = row.lastActiveAt || row.loginAt;
        const dur = Math.round((endTime.getTime() - row.loginAt.getTime()) / 1000);
        await db.update(loginSessions)
          .set({ logoutAt: endTime, durationSeconds: dur })
          .where(eq(loginSessions.id, row.id));
      }
      if (staleRows.length > 0) {
        logger.info(`[AdminAuth] Auto-closed ${staleRows.length} stale session(s) for user ${user.id}`);
      }
    } catch (closeErr) {
      logger.error("[AdminAuth] Failed to auto-close stale sessions", { error: closeErr instanceof Error ? closeErr.message : String(closeErr) });
    }

    // Record login session
    try {
      const rawUA = req.headers["user-agent"] || "";
      const parsed = parseUserAgent(rawUA);

      await db.insert(loginSessions).values({
        userId: user.id,
        sessionToken,
        loginAt: new Date(),
        lastActiveAt: new Date(),
        ipAddress: req.socket?.remoteAddress || req.ip || null,
        userAgent: rawUA || null,
        browser: parsed.browser,
        os: parsed.os,
        deviceType: parsed.deviceType,
      });
    } catch (lsErr) {
      logger.error("[AdminAuth] Failed to record login session", { error: lsErr instanceof Error ? lsErr.message : String(lsErr) });
    }

    logger.info(`[AdminAuth] Login: ${user.email || username}, role: ${userRole}`);
    res.json({ success: true, email: user.email, username: user.username });
  } catch (error) {
    logger.error("[AdminAuth] Login error", {
      username,
      ...getErrorDetails(error),
    });
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * GET /api/admin-auth/verify-session
 */
router.get("/verify-session", async (req: Request, res: Response) => {
  const session = await getAdminSession(req);
  if (!session) return res.status(401).json({ error: "No valid session" });

  res.json({
    isAuthenticated: true,
    email: session.email,
    role: session.role,
    expiresAt: session.expiresAt.toISOString(),
  });
});

/**
 * POST /api/admin-auth/logout
 */
router.post("/logout", async (req: Request, res: Response) => {
  // Close login session before destroying the auth session
  const sessionId = req.cookies[ADMIN_COOKIE_NAME];
  if (sessionId) {
    try {
      const db = await getDb();
      if (db) {
        const [ls] = await db
          .select()
          .from(loginSessions)
          .where(and(eq(loginSessions.sessionToken, sessionId), isNull(loginSessions.logoutAt)))
          .limit(1);
        if (ls) {
          const now = new Date();
          const durationSeconds = Math.round((now.getTime() - ls.loginAt.getTime()) / 1000);
          await db.update(loginSessions)
            .set({ logoutAt: now, lastActiveAt: now, durationSeconds })
            .where(eq(loginSessions.id, ls.id));
        }
      }
    } catch (err) {
      logger.error("[AdminAuth] Failed to close login session", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  await destroyAdminSession(req, res);
  res.json({ success: true });
});

/**
 * POST /api/admin-auth/heartbeat
 * Lightweight endpoint for interval heartbeat
 */
router.post("/heartbeat", async (req: Request, res: Response) => {
  const sessionId = req.cookies[ADMIN_COOKIE_NAME];
  // Heartbeat is also sent via navigator.sendBeacon on visibilitychange,
  // which has no response callback. After the session is gone the beacon
  // keeps firing for a while and the resulting 401s flood the prod log.
  // Treat unauthenticated heartbeats as no-op 204 — nothing to update,
  // nothing to fail. The 401 path was never read by anything anyway.
  if (!sessionId) return res.status(204).end();

  try {
    const db = await getDb();
    if (!db) return res.status(500).json({ error: "Database not available" });

    await db.update(loginSessions)
      .set({ lastActiveAt: new Date() })
      .where(and(eq(loginSessions.sessionToken, sessionId), isNull(loginSessions.logoutAt)));

    res.json({ ok: true });
  } catch (err) {
    logger.error("[AdminAuth] Heartbeat error", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Heartbeat failed" });
  }
});

/**
 * POST /api/admin-auth/beacon-logout
 * Called via sendBeacon on page close — closes the login session gracefully
 */
router.post("/beacon-logout", async (req: Request, res: Response) => {
  const sessionId = req.cookies[ADMIN_COOKIE_NAME];
  if (!sessionId) return res.status(200).end();

  try {
    const db = await getDb();
    if (!db) return res.status(200).end();

    const [ls] = await db
      .select()
      .from(loginSessions)
      .where(and(eq(loginSessions.sessionToken, sessionId), isNull(loginSessions.logoutAt)))
      .limit(1);

    if (ls) {
      const now = new Date();
      const durationSeconds = Math.round((now.getTime() - ls.loginAt.getTime()) / 1000);
      await db.update(loginSessions)
        .set({ logoutAt: now, lastActiveAt: now, durationSeconds })
        .where(eq(loginSessions.id, ls.id));
    }
  } catch (err) {
    logger.error("[AdminAuth] Beacon logout error", { error: err instanceof Error ? err.message : String(err) });
  }

  res.status(200).end();
});

export default router;
