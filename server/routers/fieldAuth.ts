import { z } from "zod";
import { router, publicProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, isNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import bcrypt from "bcrypt";
import { createHash } from "crypto";
import { nanoid } from "nanoid";
import { logger } from "../_core/logger";
import { FIELD_COOKIE_NAME, COOKIE_NAME } from "../../shared/const";
import { createFieldSession, destroyFieldSession } from "../fieldSession";
import { checkRateLimit, purgeExpiredEntries } from "../../shared/rateLimiter";
import type { RateLimitEntry } from "../../shared/rateLimiter";
import { normalizePhone, createOTP, verifyOTP as verifyOTPService, sendSMS } from "../services/otp";

// Login rate limiter: max 5 attempts per 15 minutes per IP
const loginLimiter = new Map<string, RateLimitEntry>();
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX = 5;

export function purgeFieldLoginLimiterEntries() {
  purgeExpiredEntries(loginLimiter);
}

setInterval(purgeFieldLoginLimiterEntries, 30 * 60 * 1000).unref();

export const fieldAuthRouter = router({
  login: publicProcedure
    .input(z.object({
      identifier: z.string().min(1),
      password: z.string().min(1),
      rememberMe: z.boolean().optional().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      // Rate limit by IP to prevent brute force
      const ip = ctx.req?.ip || "unknown";
      if (!checkRateLimit(loginLimiter, ip, LOGIN_WINDOW, LOGIN_MAX)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many login attempts. Please try again later." });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Find user by username or email (exclude soft-deleted)
      const [user] = await db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.username, input.identifier), isNull(schema.users.deletedAt)))
        .limit(1);

      const matchedUser = user || (
        await db.select().from(schema.users).where(and(eq(schema.users.email, input.identifier), isNull(schema.users.deletedAt))).limit(1)
      )[0];

      if (!matchedUser) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }
      if (matchedUser.role !== "field_staff" && matchedUser.role !== "admin" && matchedUser.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Field staff access required" });
      }
      if (!matchedUser.isActive) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Account is inactive" });
      }
      if (!matchedUser.passwordHash) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Password not set" });
      }

      const isValid = await bcrypt.compare(input.password, matchedUser.passwordHash);
      if (!isValid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      }

      // Generate refresh token
      const refreshToken = nanoid(64);
      const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
      const expiresAt = new Date(Date.now() + (input.rememberMe ? 30 : 7) * 24 * 60 * 60 * 1000);

      await db.insert(schema.refreshTokens).values({
        userId: matchedUser.id,
        tokenHash,
        authType: "field_password",
        deviceName: "Field App",
        expiresAt,
      });

      // Create secure session (opaque token) — awaits DB write before setting cookies
      const sessionDurationMs = (input.rememberMe ? 30 : 7) * 24 * 60 * 60 * 1000;
      const sessionToken = await createFieldSession(matchedUser.id, sessionDurationMs);

      // Set session cookie
      ctx.res.cookie(FIELD_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: sessionDurationMs,
      });

      // Also set main app session for tRPC context
      ctx.res.cookie(COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: sessionDurationMs,
      });

      logger.info(`[FieldAuth] Login: ${matchedUser.username || matchedUser.email}`);

      return {
        success: true,
        user: {
          id: matchedUser.id,
          name: matchedUser.name,
          username: matchedUser.username,
          email: matchedUser.email,
          role: matchedUser.role,
        },
        refreshToken,
      };
    }),

  requestOTP: publicProcedure
    .input(z.object({
      phone: z.string().min(10).max(20),
    }))
    .mutation(async ({ input }) => {
      const phone = normalizePhone(input.phone);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Look up user by phone — don't leak whether phone exists
      const [user] = await db
        .select()
        .from(schema.users)
        // Match on the last 10 digits: users.phone is stored un-normalized
        // (users.create persists raw input) while this lookup normalizes — an
        // exact match would lock out staff whose number lacks a leading "+1".
        // Same fix as customerAuth ([[openrental-real-path-test-campaign]] R3-02).
        .where(and(
          sql`right(regexp_replace(coalesce(${schema.users.phone}, ''), '[^0-9]', '', 'g'), 10) = ${phone.replace(/\D/g, "").slice(-10)}`,
          isNull(schema.users.deletedAt),
        ))
        .limit(1);

      // Always return success to avoid phone enumeration
      if (!user || !user.isActive || (user.role !== "field_staff" && user.role !== "admin" && user.role !== "super_admin")) {
        logger.warn(`[FieldAuth] OTP requested for unknown/ineligible phone: ${phone}`);
        return { success: true, message: "If this phone is registered, you will receive a code." };
      }

      try {
        const code = await createOTP(phone);
        await sendSMS(phone, `Your OpenRental login code is: ${code}. It expires in 5 minutes.`);
      } catch (err) {
        if (err instanceof Error && err.message === "TOO_MANY_OTP_REQUESTS") {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many code requests. Please wait and try again." });
        }
        logger.error("[FieldAuth] OTP send error", { error: err instanceof Error ? err.message : String(err) });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to send verification code" });
      }

      return { success: true, message: "If this phone is registered, you will receive a code." };
    }),

  verifyOTP: publicProcedure
    .input(z.object({
      phone: z.string().min(10).max(20),
      code: z.string().length(6),
    }))
    .mutation(async ({ input, ctx }) => {
      const phone = normalizePhone(input.phone);

      const isValid = await verifyOTPService(phone, input.code);
      if (!isValid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired code" });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [user] = await db
        .select()
        .from(schema.users)
        // Match on the last 10 digits: users.phone is stored un-normalized
        // (users.create persists raw input) while this lookup normalizes — an
        // exact match would lock out staff whose number lacks a leading "+1".
        // Same fix as customerAuth ([[openrental-real-path-test-campaign]] R3-02).
        .where(and(
          sql`right(regexp_replace(coalesce(${schema.users.phone}, ''), '[^0-9]', '', 'g'), 10) = ${phone.replace(/\D/g, "").slice(-10)}`,
          isNull(schema.users.deletedAt),
        ))
        .limit(1);

      if (!user || !user.isActive || (user.role !== "field_staff" && user.role !== "admin" && user.role !== "super_admin")) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired code" });
      }

      // Create field session (7 days)
      const sessionDurationMs = 7 * 24 * 60 * 60 * 1000;
      const sessionToken = await createFieldSession(user.id, sessionDurationMs);

      // Set session cookies
      ctx.res.cookie(FIELD_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: sessionDurationMs,
      });

      ctx.res.cookie(COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: sessionDurationMs,
      });

      logger.info(`[FieldAuth] OTP Login: ${user.username || user.phone}`);

      return {
        success: true,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          email: user.email,
          role: user.role,
        },
      };
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    // Invalidate server-side session
    const token = ctx.req.cookies[FIELD_COOKIE_NAME] || ctx.req.cookies[COOKIE_NAME];
    if (token) {
      await destroyFieldSession(token);
    }

    ctx.res.clearCookie(FIELD_COOKIE_NAME, { path: "/" });
    ctx.res.clearCookie(COOKIE_NAME, { path: "/" });
    return { success: true };
  }),
});
