/**
 * Signature Evidence Chain — pure helpers
 * Provides SHA-256 document hashing and client metadata extraction
 * for legally defensible e-signature audit trails.
 */

import { createHash } from "crypto";

/**
 * Compute a SHA-256 hex digest of the provided content.
 * Deterministic: same input always produces same output.
 */
export function hashDocument(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface ClientMetadata {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Extract IP and user-agent from an Express-compatible request object.
 * Honors x-forwarded-for (takes the first, leftmost IP) when present,
 * otherwise falls back to req.ip. Returns null for missing values.
 */
export function extractClientMetadata(req: {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}): ClientMetadata {
  const headers = req.headers ?? {};

  // x-forwarded-for may contain a comma-separated list; take the first entry
  const forwarded = headers["x-forwarded-for"];
  let ip: string | null = null;
  if (forwarded) {
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    ip = raw.split(",")[0].trim() || null;
  } else {
    ip = req.ip ?? null;
  }

  const ua = headers["user-agent"];
  const userAgent: string | null = ua
    ? (Array.isArray(ua) ? ua[0] : ua) || null
    : null;

  return { ip, userAgent };
}
