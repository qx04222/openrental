/**
 * Credit (挂账) order primitives — unit tests.
 *
 * The full create→exchange→settle→invoice flow is exercised against the live
 * DB in manual verification; here we lock down the pure invariants that the
 * whole feature leans on:
 *  - the open-ended sentinel never reads as a real date, and
 *  - the late-fee cron (endDate < now) can never flag an open credit order.
 */
import { describe, it, expect } from "vitest";
import {
  OPEN_ENDED_END_DATE,
  isOpenEndedEndDate,
  CHARGE_TYPES,
} from "../shared/creditOrders";
import { formatCalendarDate } from "../client/src/lib/dateUtils";

describe("OPEN_ENDED_END_DATE sentinel", () => {
  it("is a far-future date", () => {
    expect(OPEN_ENDED_END_DATE).toBe("2099-12-31");
    expect(new Date(OPEN_ENDED_END_DATE).getFullYear()).toBe(2099);
  });
});

describe("isOpenEndedEndDate", () => {
  it("recognizes the sentinel as a string", () => {
    expect(isOpenEndedEndDate(OPEN_ENDED_END_DATE)).toBe(true);
  });

  it("recognizes the sentinel as a Date", () => {
    expect(isOpenEndedEndDate(new Date(OPEN_ENDED_END_DATE))).toBe(true);
  });

  it("recognizes any year >= 2099", () => {
    expect(isOpenEndedEndDate("2099-01-01")).toBe(true);
    expect(isOpenEndedEndDate("2150-06-01")).toBe(true);
  });

  it("treats normal rental end dates as NOT open-ended", () => {
    expect(isOpenEndedEndDate("2026-06-30")).toBe(false);
    expect(isOpenEndedEndDate(new Date("2026-06-30"))).toBe(false);
    expect(isOpenEndedEndDate("2098-12-31")).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isOpenEndedEndDate(null)).toBe(false);
    expect(isOpenEndedEndDate(undefined)).toBe(false);
  });
});

describe("late-fee cron invariant", () => {
  // lateFeeCron flags rentals where endDate < now. The sentinel is centuries
  // out, so an unsettled open credit order can never be marked overdue.
  it("sentinel endDate is always in the future relative to now", () => {
    const sentinel = new Date(OPEN_ENDED_END_DATE);
    expect(sentinel.getTime()).toBeGreaterThan(Date.now());
    // The cron predicate `endDate < now` is therefore false for the sentinel.
    expect(sentinel.getTime() < Date.now()).toBe(false);
  });
});

describe("CHARGE_TYPES", () => {
  it("contains exactly swap / final / adjustment", () => {
    expect([...CHARGE_TYPES]).toEqual(["swap", "final", "adjustment"]);
  });
});

describe("formatCalendarDate open-ended rendering", () => {
  it("renders the open-ended label for the sentinel, not a 2099 date", () => {
    expect(formatCalendarDate(OPEN_ENDED_END_DATE, "America/Toronto", "en-CA", "Open")).toBe("Open");
    expect(formatCalendarDate(new Date(OPEN_ENDED_END_DATE), "America/Toronto", "zh-CN", "未定")).toBe("未定");
  });

  it("still formats real dates normally", () => {
    const out = formatCalendarDate("2026-06-15", "America/Toronto", "en-CA", "Open");
    expect(out).not.toBe("Open");
    expect(out).toContain("2026");
  });

  it("returns '-' for empty values", () => {
    expect(formatCalendarDate(null)).toBe("-");
  });
});
