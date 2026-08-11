import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { checkRateLimit, purgeExpiredEntries } from "../shared/rateLimiter";
import type { RateLimitEntry } from "../shared/rateLimiter";

// Token validation logic (extracted from inspections.router.ts createWithToken)
interface TokenRecord {
  tokenHash: string;
  isUsed: boolean;
  expiresAt: Date;
  inspectionType: string;
  rentalId: number | null;
  rentalFleetId: number | null;
}

interface TokenSubmission {
  token: string;
  type: string;
  rentalId?: number;
  rentalFleetId?: number;
}

type TokenValidationResult =
  | { valid: true }
  | { valid: false; code: string; message: string };

function validateToken(record: TokenRecord | null, submission: TokenSubmission): TokenValidationResult {
  const expectedHash = createHash("sha256").update(submission.token).digest("hex");

  if (!record) {
    return { valid: false, code: "NOT_FOUND", message: "Invalid or expired inspection token" };
  }

  if (record.tokenHash !== expectedHash) {
    return { valid: false, code: "NOT_FOUND", message: "Invalid or expired inspection token" };
  }

  if (record.isUsed) {
    return { valid: false, code: "CONFLICT", message: "This inspection token has already been used" };
  }

  if (new Date() > record.expiresAt) {
    return { valid: false, code: "BAD_REQUEST", message: "This inspection token has expired" };
  }

  if (record.inspectionType !== submission.type) {
    return { valid: false, code: "BAD_REQUEST", message: "Token inspection type mismatch" };
  }

  if (record.rentalId && submission.rentalId && record.rentalId !== submission.rentalId) {
    return { valid: false, code: "BAD_REQUEST", message: "Token rental ID mismatch" };
  }

  if (record.rentalFleetId && submission.rentalFleetId && record.rentalFleetId !== submission.rentalFleetId) {
    return { valid: false, code: "BAD_REQUEST", message: "Token fleet ID mismatch" };
  }

  return { valid: true };
}

describe("Token Validation", () => {
  const validToken = "test-token-123";
  const validHash = createHash("sha256").update(validToken).digest("hex");
  const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const baseRecord: TokenRecord = {
    tokenHash: validHash,
    isUsed: false,
    expiresAt: futureDate,
    inspectionType: "dispatch",
    rentalId: 1,
    rentalFleetId: 10,
  };

  const baseSubmission: TokenSubmission = {
    token: validToken,
    type: "dispatch",
    rentalId: 1,
    rentalFleetId: 10,
  };

  it("accepts valid token", () => {
    const result = validateToken(baseRecord, baseSubmission);
    expect(result.valid).toBe(true);
  });

  it("rejects null record", () => {
    const result = validateToken(null, baseSubmission);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("NOT_FOUND");
  });

  it("rejects used token", () => {
    const result = validateToken({ ...baseRecord, isUsed: true }, baseSubmission);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("CONFLICT");
  });

  it("rejects expired token", () => {
    const result = validateToken({ ...baseRecord, expiresAt: pastDate }, baseSubmission);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe("BAD_REQUEST");
  });

  it("rejects type mismatch", () => {
    const result = validateToken(baseRecord, { ...baseSubmission, type: "return" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message).toContain("type mismatch");
  });

  it("rejects rental ID mismatch", () => {
    const result = validateToken(baseRecord, { ...baseSubmission, rentalId: 999 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message).toContain("rental ID");
  });

  it("rejects fleet ID mismatch", () => {
    const result = validateToken(baseRecord, { ...baseSubmission, rentalFleetId: 999 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.message).toContain("fleet ID");
  });

  it("allows null rental constraints on token (general token)", () => {
    const generalRecord = { ...baseRecord, rentalId: null, rentalFleetId: null };
    const result = validateToken(generalRecord, baseSubmission);
    expect(result.valid).toBe(true);
  });
});

describe("Rate Limiter (shared module)", () => {
  const WINDOW = 15 * 60 * 1000;
  const MAX = 10;
  let store: Map<string, RateLimitEntry>;

  beforeEach(() => {
    store = new Map();
  });

  it("allows first request", () => {
    expect(checkRateLimit(store, "192.168.1.1", WINDOW, MAX)).toBe(true);
    expect(store.get("192.168.1.1")?.count).toBe(1);
  });

  it("allows up to MAX requests", () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < MAX; i++) {
      expect(checkRateLimit(store, ip, WINDOW, MAX)).toBe(true);
    }
  });

  it("blocks after MAX requests", () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < MAX; i++) checkRateLimit(store, ip, WINDOW, MAX);
    expect(checkRateLimit(store, ip, WINDOW, MAX)).toBe(false);
  });

  it("resets after window expires", () => {
    const ip = "10.0.0.3";
    // Fill up
    for (let i = 0; i < MAX; i++) checkRateLimit(store, ip, WINDOW, MAX);
    expect(checkRateLimit(store, ip, WINDOW, MAX)).toBe(false);

    // Manually expire the entry
    const entry = store.get(ip)!;
    entry.resetAt = Date.now() - 1;

    // Should allow again
    expect(checkRateLimit(store, ip, WINDOW, MAX)).toBe(true);
  });

  it("tracks different IPs independently", () => {
    for (let i = 0; i < MAX; i++) checkRateLimit(store, "ip-a", WINDOW, MAX);
    expect(checkRateLimit(store, "ip-a", WINDOW, MAX)).toBe(false);
    expect(checkRateLimit(store, "ip-b", WINDOW, MAX)).toBe(true);
  });
});

describe("purgeExpiredEntries (shared module)", () => {
  it("removes expired entries", () => {
    const store = new Map<string, RateLimitEntry>();
    store.set("expired", { count: 5, resetAt: Date.now() - 1000 });
    store.set("active", { count: 3, resetAt: Date.now() + 60000 });

    const purged = purgeExpiredEntries(store);
    expect(purged).toBe(1);
    expect(store.has("expired")).toBe(false);
    expect(store.has("active")).toBe(true);
  });

  it("returns 0 when nothing to purge", () => {
    const store = new Map<string, RateLimitEntry>();
    store.set("active", { count: 1, resetAt: Date.now() + 60000 });
    expect(purgeExpiredEntries(store)).toBe(0);
  });

  it("handles empty store", () => {
    const store = new Map<string, RateLimitEntry>();
    expect(purgeExpiredEntries(store)).toBe(0);
  });
});
