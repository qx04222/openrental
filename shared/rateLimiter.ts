/**
 * In-memory rate limiter — shared between server endpoints and tests.
 * Sliding window counter pattern: tracks request count per key within a time window.
 */

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Check if a request is within rate limit. Returns true if allowed, false if blocked.
 * Automatically increments the counter and resets expired windows.
 */
export function checkRateLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  windowMs: number,
  maxRequests: number,
): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) return false;

  entry.count++;
  return true;
}

/**
 * Purge expired entries from the store. Call periodically to prevent memory leaks.
 */
export function purgeExpiredEntries(store: Map<string, RateLimitEntry>): number {
  const now = Date.now();
  let purged = 0;
  for (const [key, val] of store) {
    if (val.resetAt <= now) {
      store.delete(key);
      purged++;
    }
  }
  return purged;
}
