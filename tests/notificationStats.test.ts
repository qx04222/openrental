/**
 * Notification stats must never bind a JS Date into a raw sql`` fragment.
 *
 * Regression (production, found 2026-08-07): getNotificationStats() built its
 * last24h / last7d counters as sql`... >= ${jsDate}`. postgres.js cannot
 * serialize a Date as a bind parameter inside a raw fragment — it throws
 * ERR_INVALID_ARG_TYPE, which took the WHOLE stats query down. The settings
 * page renders `stats?.x ?? 0`, so the crash surfaced as six confident zeroes
 * ("0 total sent, 0 total failed") while the log table actually held 2 sent
 * and 15 failed rows. A silent wrong number is worse than a visible error.
 *
 * This test inspects the query the service builds, without a database.
 */
import { describe, it, expect, vi } from "vitest";

const capturedFields: Record<string, unknown>[] = [];

vi.mock("../server/db", async () => {
  const actual = await vi.importActual<typeof import("../server/db")>("../server/db");
  return {
    ...actual,
    getDb: async () => ({
      select: (fields: Record<string, unknown>) => {
        capturedFields.push(fields);
        return { from: async () => [{}] };
      },
    }),
  };
});

import { getNotificationStats } from "../server/services/notifications";

/** Walk any drizzle SQL structure and collect every embedded Date. */
function findDates(node: unknown, seen = new Set<unknown>()): Date[] {
  if (node === null || typeof node !== "object") return [];
  if (seen.has(node)) return [];
  seen.add(node);
  if (node instanceof Date) return [node];
  if (Array.isArray(node)) return node.flatMap((n) => findDates(n, seen));
  return Object.values(node as Record<string, unknown>).flatMap((n) => findDates(n, seen));
}

describe("getNotificationStats query construction", () => {
  it("passes no raw Date objects into the SQL fragments", async () => {
    capturedFields.length = 0;
    await getNotificationStats();

    expect(capturedFields.length).toBe(1);
    const dates = findDates(capturedFields[0]);
    expect(dates).toEqual([]);
  });

  it("still constrains last24h / last7d to a time window", async () => {
    capturedFields.length = 0;
    await getNotificationStats();

    // The ISO strings must actually be in the query — a "fix" that simply
    // dropped the time filters would pass the test above.
    const isoLike = findIsoStrings(capturedFields[0]);
    expect(isoLike.length).toBeGreaterThanOrEqual(2);
  });
});

function findIsoStrings(node: unknown, seen = new Set<unknown>()): string[] {
  if (typeof node === "string") {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(node) ? [node] : [];
  }
  if (node === null || typeof node !== "object") return [];
  if (seen.has(node)) return [];
  seen.add(node);
  if (Array.isArray(node)) return node.flatMap((n) => findIsoStrings(n, seen));
  return Object.values(node as Record<string, unknown>).flatMap((n) => findIsoStrings(n, seen));
}
