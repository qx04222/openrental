import { createHash, randomInt } from "crypto";
import { getDb, eq, and, lte, sql } from "../db";
import { otpCodes } from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { gte } from "drizzle-orm";

// ─── Constants ────────────────────────────────────────────────
const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const OTP_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const OTP_RATE_MAX = 3; // max OTPs per phone per window
const OTP_MAX_ATTEMPTS = 3; // max verify attempts per code

// ─── Helpers ──────────────────────────────────────────────────

/** Generate a 6-digit OTP code */
export function generateOTP(): string {
  return String(randomInt(100000, 999999));
}

/** SHA-256 hash a code */
export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Normalize phone: strip spaces/dashes, ensure + prefix */
export function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-()]/g, "");
  if (!cleaned.startsWith("+")) {
    // Assume North American if 10 digits
    if (cleaned.length === 10) {
      cleaned = "+1" + cleaned;
    } else {
      cleaned = "+" + cleaned;
    }
  }
  return cleaned;
}

// ─── Core OTP Operations ──────────────────────────────────────

/**
 * Create an OTP for the given phone. Enforces rate limiting.
 * Returns the plain-text code (caller sends it via SMS).
 */
export async function createOTP(phone: string): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Rate limit: max 3 OTPs per phone in last 15 minutes
  const windowStart = new Date(Date.now() - OTP_RATE_WINDOW_MS);
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.phone, phone),
        gte(otpCodes.createdAt, windowStart)
      )
    );

  if (countResult && countResult.count >= OTP_RATE_MAX) {
    throw new Error("TOO_MANY_OTP_REQUESTS");
  }

  const code = generateOTP();
  const hashed = hashCode(code);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  await db.insert(otpCodes).values({
    phone,
    codeHash: hashed,
    expiresAt,
    attempts: 0,
    used: false,
  });

  return code;
}

/**
 * Verify an OTP code for the given phone.
 * Returns true if valid, false otherwise.
 */
export async function verifyOTP(phone: string, code: string): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const hashed = hashCode(code);
  const now = new Date();

  // Find matching unexpired, unused OTP for this phone
  const [otp] = await db
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.phone, phone),
        eq(otpCodes.codeHash, hashed),
        eq(otpCodes.used, false),
        gte(otpCodes.expiresAt, now)
      )
    )
    .limit(1);

  if (!otp) {
    // Also increment attempts on any unexpired OTP for this phone (brute force protection)
    await db
      .update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(
        and(
          eq(otpCodes.phone, phone),
          eq(otpCodes.used, false),
          gte(otpCodes.expiresAt, now)
        )
      );
    return false;
  }

  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    // Mark as used (burned) to prevent further attempts
    await db.update(otpCodes).set({ used: true }).where(eq(otpCodes.id, otp.id));
    return false;
  }

  // Mark as used (success)
  await db.update(otpCodes).set({ used: true }).where(eq(otpCodes.id, otp.id));
  return true;
}

/**
 * Delete expired OTP codes.
 */
export async function cleanupExpiredOTPs(): Promise<void> {
  try {
    const db = await getDb();
    if (db) {
      await db.delete(otpCodes).where(lte(otpCodes.expiresAt, new Date()));
    }
  } catch (err) {
    logger.error("[OTP] Cleanup error", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Cleanup expired OTPs every 30 minutes
setInterval(cleanupExpiredOTPs, 30 * 60 * 1000).unref();

// ─── SMS Sending ──────────────────────────────────────────────

/**
 * Send an SMS message. In development, logs through the application logger.
 * In production, uses Telnyx.
 */
export async function sendSMS(phone: string, message: string): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    logger.info(`[OTP/SMS] DEV MODE — To: ${phone} — Message: ${message}`);
    return;
  }

  // Production: Telnyx
  const apiKey = process.env.TELNYX_API_KEY;
  const fromNumber = process.env.TELNYX_PHONE_NUMBER;

  if (!apiKey || !fromNumber) {
    logger.error("[OTP/SMS] Telnyx credentials not configured");
    throw new Error("SMS service not configured");
  }

  try {
    const Telnyx = (await import("telnyx")).default;
    const telnyx = new Telnyx({ apiKey });
    await telnyx.messages.send({
      from: fromNumber,
      to: phone,
      text: message,
    });
    logger.info(`[OTP/SMS] Sent to ${phone}`);
  } catch (err) {
    logger.error("[OTP/SMS] Failed to send", { error: err instanceof Error ? err.message : String(err) });
    throw new Error("Failed to send SMS", { cause: err });
  }
}
