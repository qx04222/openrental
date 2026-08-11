import { getDb, eq } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";

// In-memory cache with 60s TTL. Flags are read on almost every request,
// so a cache avoids a DB round-trip per call. Invalidated by setFlag().
const cache = new Map<string, { value: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export async function isFeatureEnabled(key: string): Promise<boolean> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const db = await getDb();
  if (!db) return false;

  try {
    const [row] = await db
      .select({ enabled: schema.featureFlags.enabled })
      .from(schema.featureFlags)
      .where(eq(schema.featureFlags.key, key))
      .limit(1);

    const value = row?.enabled ?? false;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    logger.error("[FeatureFlags] read failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function listFlags() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(schema.featureFlags).orderBy(schema.featureFlags.key);
}

// In-memory snapshot of all flags. Single 60s-TTL cache entry so the
// per-key isEnabled cache and this one stay coherent (setFlag clears
// both maps below).
let allFlagsCache: { value: Record<string, boolean>; expiresAt: number } | null = null;

export async function listAllEnabled(): Promise<Record<string, boolean>> {
  if (allFlagsCache && allFlagsCache.expiresAt > Date.now()) return allFlagsCache.value;
  const db = await getDb();
  if (!db) return {};
  try {
    const rows = await db
      .select({ key: schema.featureFlags.key, enabled: schema.featureFlags.enabled })
      .from(schema.featureFlags);
    const map: Record<string, boolean> = {};
    for (const r of rows) map[r.key] = r.enabled;
    allFlagsCache = { value: map, expiresAt: Date.now() + CACHE_TTL_MS };
    return map;
  } catch (err) {
    logger.error("[FeatureFlags] listAllEnabled failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

export async function setFlag(key: string, enabled: boolean) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(schema.featureFlags)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(schema.featureFlags.key, key));

  cache.delete(key);
  allFlagsCache = null;
}

export function clearFeatureFlagCache() {
  cache.clear();
  allFlagsCache = null;
}
