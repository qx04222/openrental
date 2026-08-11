/**
 * Pure unit tests for computeLateFee — no DB, no mocks needed.
 */
import { describe, it, expect } from "vitest";
import { computeLateFee } from "../server/services/lateFee";

const BASE_SETTINGS = {
  lateFeeDailyRatePct: 150,
  lateFeeGraceHours: 24,
};

const END_DATE = new Date("2025-06-10T12:00:00Z");
const DAILY_BASE_RATE = 100; // $100/day

// ── No late (returned before or on endDate) ──────────────────────────────
describe("computeLateFee — not late", () => {
  it("returns 0 when returned exactly at endDate", () => {
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: END_DATE,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
    });
    expect(result.lateDays).toBe(0);
    expect(result.lateFeeAmount).toBe(0);
  });

  it("returns 0 when returned before endDate", () => {
    const earlyReturn = new Date("2025-06-08T12:00:00Z");
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: earlyReturn,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
    });
    expect(result.lateDays).toBe(0);
    expect(result.lateFeeAmount).toBe(0);
  });
});

// ── Within grace period ──────────────────────────────────────────────────
describe("computeLateFee — within grace period", () => {
  it("returns 0 when returned exactly at end of grace period", () => {
    // 24h grace → return exactly at endDate + 24h still = 0 late days
    const graceEnd = new Date(END_DATE.getTime() + 24 * 60 * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: graceEnd,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
    });
    // overdueMs = 24h - 24h grace = 0 → floor(0/24h) = 0
    expect(result.lateDays).toBe(0);
    expect(result.lateFeeAmount).toBe(0);
  });

  it("returns 0 when returned 1 minute before grace expires (23h59m late)", () => {
    const almostGrace = new Date(END_DATE.getTime() + (24 * 60 - 1) * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: almostGrace,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
    });
    expect(result.lateDays).toBe(0);
    expect(result.lateFeeAmount).toBe(0);
  });

  it("returns 0 with 48h grace and 47h overdue", () => {
    const settings = { lateFeeDailyRatePct: 150, lateFeeGraceHours: 48 };
    const returnDate = new Date(END_DATE.getTime() + 47 * 60 * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings,
    });
    expect(result.lateDays).toBe(0);
    expect(result.lateFeeAmount).toBe(0);
  });
});

// ── 1 day late ───────────────────────────────────────────────────────────
describe("computeLateFee — 1 day late", () => {
  it("charges 1 day with standard settings", () => {
    // 48h after endDate = 24h overdue after grace → 1 late day
    const returnDate = new Date(END_DATE.getTime() + 48 * 60 * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
    });
    expect(result.lateDays).toBe(1);
    // 1 day × $100 × 150% = $150
    expect(result.lateFeeAmount).toBeCloseTo(150, 5);
  });

  it("charges 1 day with 0h grace (no grace)", () => {
    const settings = { lateFeeDailyRatePct: 150, lateFeeGraceHours: 0 };
    // 25h after endDate → 1 late day (floor(25h / 24h) = 1)
    const returnDate = new Date(END_DATE.getTime() + 25 * 60 * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings,
    });
    expect(result.lateDays).toBe(1);
    expect(result.lateFeeAmount).toBeCloseTo(150, 5);
  });
});

// ── 10 days late ─────────────────────────────────────────────────────────
describe("computeLateFee — 10 days late", () => {
  it("charges 10 days correctly", () => {
    // 10 days + 24h grace = 11 days after endDate
    const returnDate = new Date(END_DATE.getTime() + 11 * 24 * 60 * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
    });
    expect(result.lateDays).toBe(10);
    expect(result.lateFeeAmount).toBeCloseTo(1500, 5);
  });
});

// ── 100 days late ────────────────────────────────────────────────────────
describe("computeLateFee — 100 days late", () => {
  it("charges 100 days correctly", () => {
    const returnDate = new Date(END_DATE.getTime() + 101 * 24 * 60 * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
    });
    expect(result.lateDays).toBe(100);
    expect(result.lateFeeAmount).toBeCloseTo(15000, 5);
  });
});

// ── null actualReturnDate (uses injected now) ────────────────────────────
describe("computeLateFee — null actualReturnDate uses `now`", () => {
  it("uses injected `now` when actualReturnDate is null", () => {
    // 3 days + grace after endDate
    const injectedNow = new Date(END_DATE.getTime() + 4 * 24 * 60 * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: null,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
      now: injectedNow,
    });
    expect(result.lateDays).toBe(3);
    expect(result.lateFeeAmount).toBeCloseTo(450, 5);
  });

  it("returns 0 lateDays when now is before endDate (null return, no overdue)", () => {
    const earlyNow = new Date(END_DATE.getTime() - 1 * 24 * 60 * 60 * 1000);
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: null,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: BASE_SETTINGS,
      now: earlyNow,
    });
    expect(result.lateDays).toBe(0);
    expect(result.lateFeeAmount).toBe(0);
  });
});

// ── Grace period variants ────────────────────────────────────────────────
describe("computeLateFee — grace period variants", () => {
  it("grace = 0h: 1h overdue is still 0 late days (< 24h)", () => {
    const settings = { lateFeeDailyRatePct: 150, lateFeeGraceHours: 0 };
    const returnDate = new Date(END_DATE.getTime() + 1 * 60 * 60 * 1000); // 1h late
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings,
    });
    // floor(1h / 24h) = 0
    expect(result.lateDays).toBe(0);
  });

  it("grace = 24h: 25h overdue → 1 late day", () => {
    const returnDate = new Date(END_DATE.getTime() + 49 * 60 * 60 * 1000); // 49h after end
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: { lateFeeDailyRatePct: 150, lateFeeGraceHours: 24 },
    });
    expect(result.lateDays).toBe(1);
  });

  it("grace = 48h: 49h overdue → 1 late day", () => {
    const settings = { lateFeeDailyRatePct: 150, lateFeeGraceHours: 48 };
    const returnDate = new Date(END_DATE.getTime() + 97 * 60 * 60 * 1000); // 97h = 48h grace + 49h overdue
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings,
    });
    expect(result.lateDays).toBe(2); // floor(49h / 24h) = 2
  });
});

// ── Rate percentage variants ─────────────────────────────────────────────
describe("computeLateFee — custom ratePct", () => {
  const returnDate = new Date(END_DATE.getTime() + 2 * 24 * 60 * 60 * 1000); // 1 day late after 24h grace

  it("100% ratePct = 1× daily rate per late day", () => {
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: { lateFeeDailyRatePct: 100, lateFeeGraceHours: 24 },
    });
    expect(result.lateDays).toBe(1);
    expect(result.lateFeeAmount).toBeCloseTo(100, 5); // 1 × $100 × 100%
  });

  it("150% ratePct = 1.5× daily rate per late day", () => {
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: { lateFeeDailyRatePct: 150, lateFeeGraceHours: 24 },
    });
    expect(result.lateDays).toBe(1);
    expect(result.lateFeeAmount).toBeCloseTo(150, 5); // 1 × $100 × 150%
  });

  it("200% ratePct = 2× daily rate per late day", () => {
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: DAILY_BASE_RATE,
      settings: { lateFeeDailyRatePct: 200, lateFeeGraceHours: 24 },
    });
    expect(result.lateDays).toBe(1);
    expect(result.lateFeeAmount).toBeCloseTo(200, 5); // 1 × $100 × 200%
  });

  it("fractional daily base rate computes correctly", () => {
    const result = computeLateFee({
      endDate: END_DATE,
      actualReturnDate: returnDate,
      dailyBaseRate: 75.5,
      settings: { lateFeeDailyRatePct: 150, lateFeeGraceHours: 24 },
    });
    expect(result.lateDays).toBe(1);
    expect(result.lateFeeAmount).toBeCloseTo(113.25, 5); // 75.5 × 1.5
  });
});
