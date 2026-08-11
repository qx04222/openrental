/**
 * Feature flags service — cache + DB lookup behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, selectResultRef } = vi.hoisted(() => {
  const selectResultRef: { value: unknown[] } = { value: [] };
  const mockDb = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResultRef.value),
        }),
        orderBy: () => Promise.resolve(selectResultRef.value),
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    })),
  };
  return { mockDb, selectResultRef };
});

vi.mock("../server/db", () => ({
  getDb: async () => mockDb,
  eq: vi.fn(),
}));

vi.mock("../server/_core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  isFeatureEnabled,
  setFlag,
  listFlags,
  clearFeatureFlagCache,
} from "../server/services/featureFlags";

describe("featureFlags", () => {
  beforeEach(() => {
    clearFeatureFlagCache();
    selectResultRef.value = [];
    vi.clearAllMocks();
  });

  it("returns false when flag does not exist", async () => {
    selectResultRef.value = [];
    expect(await isFeatureEnabled("does_not_exist")).toBe(false);
  });

  it("returns flag enabled state from DB", async () => {
    selectResultRef.value = [{ enabled: true }];
    expect(await isFeatureEnabled("some_flag")).toBe(true);
  });

  it("caches result for subsequent reads", async () => {
    selectResultRef.value = [{ enabled: true }];
    await isFeatureEnabled("cached_flag");
    await isFeatureEnabled("cached_flag");
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("setFlag invalidates cache for that key", async () => {
    selectResultRef.value = [{ enabled: false }];
    await isFeatureEnabled("toggle_me");
    await setFlag("toggle_me", true);
    selectResultRef.value = [{ enabled: true }];
    expect(await isFeatureEnabled("toggle_me")).toBe(true);
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it("listFlags returns all rows from DB", async () => {
    selectResultRef.value = [
      { key: "a", enabled: false },
      { key: "b", enabled: true },
    ];
    const rows = await listFlags();
    expect(rows).toHaveLength(2);
  });
});
