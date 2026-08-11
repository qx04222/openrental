import { describe, it, expect } from "vitest";
import {
  selectVersionAsOf,
  planVersionChange,
  type PriceVersionRow,
} from "../server/services/priceVersions";

const rates = (d: string): { dailyRate: string; weeklyRate: string; monthlyRate: string; twentyEightDayRate: null } => ({
  dailyRate: d,
  weeklyRate: String(Number(d) * 6),
  monthlyRate: String(Number(d) * 24),
  twentyEightDayRate: null,
});

function v(id: number, from: string, to: string | null, daily: string): PriceVersionRow {
  return { id, effectiveFrom: new Date(from), effectiveTo: to ? new Date(to) : null, ...rates(daily) };
}

describe("selectVersionAsOf", () => {
  const versions = [
    v(1, "2026-01-01", "2026-08-01", "230"),
    v(2, "2026-08-01", null, "250"),
  ];

  it("picks the version whose interval contains the date", () => {
    expect(selectVersionAsOf(versions, new Date("2026-03-15"))?.id).toBe(1);
    expect(selectVersionAsOf(versions, new Date("2026-09-15"))?.id).toBe(2);
  });

  it("treats effective_from as inclusive and effective_to as exclusive", () => {
    expect(selectVersionAsOf(versions, new Date("2026-08-01"))?.id).toBe(2); // boundary → new version
    expect(selectVersionAsOf(versions, new Date("2026-07-31"))?.id).toBe(1);
  });

  it("returns the open tail for any far-future date", () => {
    expect(selectVersionAsOf(versions, new Date("2030-01-01"))?.id).toBe(2);
  });

  it("returns null before the earliest version and for an empty chain", () => {
    expect(selectVersionAsOf(versions, new Date("2019-01-01"))).toBeNull();
    expect(selectVersionAsOf([], new Date("2026-01-01"))).toBeNull();
  });
});

describe("planVersionChange", () => {
  it("inserts an open tail when there are no versions", () => {
    const plan = planVersionChange([], new Date("2026-06-23"), rates("100"));
    expect(plan).toMatchObject({ action: "insert", insert: { effectiveTo: null } });
  });

  it("edits in place when the effective date equals the open tail's start", () => {
    const versions = [v(1, "2026-01-01", null, "230")];
    const plan = planVersionChange(versions, new Date("2026-01-01"), rates("240"));
    expect(plan).toMatchObject({ action: "update", id: 1 });
  });

  it("splits the open tail for a future change (closes old, opens new)", () => {
    const versions = [v(1, "2026-01-01", null, "230")];
    const plan = planVersionChange(versions, new Date("2026-08-01"), rates("250"));
    expect(plan).toMatchObject({
      action: "split",
      closeId: 1,
      closeTo: new Date("2026-08-01"),
      insert: { effectiveFrom: new Date("2026-08-01"), effectiveTo: null },
    });
  });

  it("splits a future closed interval without reopening it (two stacked schedules)", () => {
    // After scheduling Aug 1: [Jan1,Aug1)$230 closed, [Aug1,null)$250 open.
    const versions = [
      v(1, "2026-01-01", "2026-08-01", "230"),
      v(2, "2026-08-01", null, "250"),
    ];
    // Now schedule a change effective Sep 1 — falls in the open tail (v2).
    const plan = planVersionChange(versions, new Date("2026-09-01"), rates("260"));
    expect(plan).toMatchObject({ action: "split", closeId: 2, insert: { effectiveTo: null } });
  });

  it("splitting a bounded interval preserves its end date", () => {
    const versions = [
      v(1, "2026-01-01", "2026-08-01", "230"),
      v(2, "2026-08-01", null, "250"),
    ];
    // Insert a change effective Jun 1 — inside the bounded v1; the new slice must
    // keep v1's end (2026-08-01), not reopen the tail.
    const plan = planVersionChange(versions, new Date("2026-06-01"), rates("235"));
    expect(plan).toMatchObject({
      action: "split",
      closeId: 1,
      insert: { effectiveFrom: new Date("2026-06-01"), effectiveTo: new Date("2026-08-01") },
    });
  });

  it("edits a future scheduled version in place when dates match", () => {
    const versions = [
      v(1, "2026-01-01", "2026-08-01", "230"),
      v(2, "2026-08-01", null, "250"),
    ];
    const plan = planVersionChange(versions, new Date("2026-08-01"), rates("255"));
    expect(plan).toMatchObject({ action: "update", id: 2 });
  });
});
