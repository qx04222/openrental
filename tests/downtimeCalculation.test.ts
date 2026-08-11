/**
 * Downtime / Fault Suspension Calculation — unit tests
 *
 * Tests working days lost calculation:
 * - Weekday counting (Mon-Fri)
 * - Weekend exclusion
 * - Ontario statutory holiday exclusion
 * - Edge cases: single day, year boundary
 *
 * NB: fixtures use parseCalendarDate (Toronto-anchored) rather than
 * `new Date(y, m, d)` (which is the RUNNER's local midnight). The function under
 * test resolves each instant to its Toronto calendar day, so a local-midnight
 * fixture silently shifts by a day under a UTC CI runner. parseCalendarDate keeps
 * these deterministic regardless of where the suite runs.
 */
import { describe, it, expect } from "vitest";

import { calculateWorkingDaysLost } from "../server/services/downtimeCalculation";
import { parseCalendarDate } from "../server/_core/dateUtils";

describe("calculateWorkingDaysLost", () => {
  it("counts Mon-Fri within same week as 5 working days", () => {
    // Mon Jan 6 2025 to Fri Jan 10 2025
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-01-06"),
      resolvedAt: parseCalendarDate("2025-01-10"),
    });
    expect(result.totalCalendarDays).toBe(5);
    expect(result.workingDaysLost).toBe(5);
    expect(result.excludedDays).toBe(0);
  });

  it("excludes weekends", () => {
    // Mon Jan 6 2025 to Sun Jan 12 2025 = 7 calendar days
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-01-06"),
      resolvedAt: parseCalendarDate("2025-01-12"),
    });
    expect(result.totalCalendarDays).toBe(7);
    expect(result.workingDaysLost).toBe(5);
    expect(result.excludedDays).toBe(2);
  });

  it("excludes Ontario holidays (Canada Day Jul 1)", () => {
    // Mon Jun 30 2025 to Wed Jul 2 2025 = 3 calendar days
    // Jul 1 is Canada Day (holiday)
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-06-30"),
      resolvedAt: parseCalendarDate("2025-07-02"),
    });
    expect(result.totalCalendarDays).toBe(3);
    // Jun 30 (Mon) = working, Jul 1 (Tue, holiday) = excluded, Jul 2 (Wed) = working
    expect(result.workingDaysLost).toBe(2);
    expect(result.excludedDays).toBe(1);
  });

  it("excludes Christmas Day", () => {
    // Wed Dec 24 2025 to Fri Dec 26 2025 = 3 calendar days
    // Dec 25 = Christmas, Dec 26 = Boxing Day
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-12-24"),
      resolvedAt: parseCalendarDate("2025-12-26"),
    });
    expect(result.totalCalendarDays).toBe(3);
    expect(result.workingDaysLost).toBe(1); // only Dec 24
    expect(result.excludedDays).toBe(2); // Dec 25 + Dec 26
  });

  it("excludes Labour Day (1st Monday of September)", () => {
    // Labour Day 2025 = Mon Sep 1
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-09-01"),
      resolvedAt: parseCalendarDate("2025-09-01"),
    });
    expect(result.totalCalendarDays).toBe(1);
    expect(result.workingDaysLost).toBe(0);
    expect(result.excludedDays).toBe(1);
  });

  it("handles single working day downtime", () => {
    // Wed Jan 8 2025
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-01-08"),
      resolvedAt: parseCalendarDate("2025-01-08"),
    });
    expect(result.totalCalendarDays).toBe(1);
    expect(result.workingDaysLost).toBe(1);
    expect(result.excludedDays).toBe(0);
  });

  it("handles single weekend day downtime", () => {
    // Sat Jan 11 2025
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-01-11"),
      resolvedAt: parseCalendarDate("2025-01-11"),
    });
    expect(result.totalCalendarDays).toBe(1);
    expect(result.workingDaysLost).toBe(0);
    expect(result.excludedDays).toBe(1);
  });

  it("handles period spanning year boundary", () => {
    // Mon Dec 29 2025 to Fri Jan 2 2026 = 5 calendar days
    // Dec 29 (Mon) = working, Dec 30 (Tue) = working, Dec 31 (Wed) = working
    // Jan 1 (Thu, New Year) = excluded, Jan 2 (Fri) = working
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-12-29"),
      resolvedAt: parseCalendarDate("2026-01-02"),
    });
    expect(result.totalCalendarDays).toBe(5);
    expect(result.excludedDays).toBe(1); // Jan 1 only
    expect(result.workingDaysLost).toBe(4);
  });

  it("handles two-week period with weekends", () => {
    // Mon Jan 6 2025 to Fri Jan 17 2025 = 12 calendar days
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-01-06"),
      resolvedAt: parseCalendarDate("2025-01-17"),
    });
    expect(result.totalCalendarDays).toBe(12);
    expect(result.workingDaysLost).toBe(10);
    expect(result.excludedDays).toBe(2); // Sat Jan 11 + Sun Jan 12
  });

  it("excludes New Year's Day", () => {
    // Wed Jan 1 2025
    const result = calculateWorkingDaysLost({
      reportedAt: parseCalendarDate("2025-01-01"),
      resolvedAt: parseCalendarDate("2025-01-01"),
    });
    expect(result.totalCalendarDays).toBe(1);
    expect(result.workingDaysLost).toBe(0);
    expect(result.excludedDays).toBe(1);
  });
});
