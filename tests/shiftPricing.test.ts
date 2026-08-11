/**
 * Shift Pricing Service — unit tests
 *
 * Tests the 28-day cycle pricing, shift multipliers, and overtime calculation:
 * - calculate28DayPrice: optimal combo of 28-day periods + weeks + days
 * - calculateShiftPricing: single (1.0x), double (1.5x), triple (2.0x)
 * - calculateOvertime: engine hours vs standard hours
 */
import { describe, it, expect, vi } from "vitest";

// Mock pricingCalculation which is require()'d inside calculateShiftPricing
// Must use vi.hoisted so the mock factory is available before module loading
const { mockCalcRentalPrice } = vi.hoisted(() => {
  const mockCalcRentalPrice = vi.fn().mockImplementation(
    (days: number, dailyRate: number, weeklyRate: number, monthlyRate: number) => {
      if (days <= 0) return { total: 0, breakdown: "" };
      const daily = days * dailyRate;
      const weekly = Math.floor(days / 7) * weeklyRate + (days % 7) * dailyRate;
      const monthly = Math.floor(days / 30) * monthlyRate + Math.floor((days % 30) / 7) * weeklyRate + ((days % 30) % 7) * dailyRate;
      const best = Math.min(daily, weekly, monthly);
      return { total: best, breakdown: `${days} days` };
    },
  );
  return { mockCalcRentalPrice };
});

vi.mock("../server/services/pricingCalculation", () => ({
  calculateRentalPrice: (...args: unknown[]) => mockCalcRentalPrice(...args),
}));

import {
  calculate28DayPrice,
  calculateShiftPricing,
  calculateOvertime,
} from "../server/services/shiftPricing";

describe("calculate28DayPrice", () => {
  const daily = 100;
  const weekly = 500;
  const twentyEightDay = 1600;

  it("returns 0 for 0 or negative days", () => {
    expect(calculate28DayPrice(0, daily, weekly, twentyEightDay).total).toBe(0);
    expect(calculate28DayPrice(-5, daily, weekly, twentyEightDay).total).toBe(0);
  });

  it("returns empty breakdown for 0 days", () => {
    expect(calculate28DayPrice(0, daily, weekly, twentyEightDay).breakdown).toBe("");
  });

  it("calculates exactly 28 days as 1 period", () => {
    const result = calculate28DayPrice(28, daily, weekly, twentyEightDay);
    expect(result.total).toBe(1600);
    expect(result.breakdown).toContain("1 period");
  });

  it("calculates exactly 56 days as 2 periods", () => {
    const result = calculate28DayPrice(56, daily, weekly, twentyEightDay);
    expect(result.total).toBe(3200);
    expect(result.breakdown).toContain("2 periods");
  });

  it("finds optimal combo for 35 days (1 period + 1 week)", () => {
    // 1 period (1600) + 1 week (500) = 2100
    // vs 5 weeks (2500) vs 35 days (3500)
    const result = calculate28DayPrice(35, daily, weekly, twentyEightDay);
    expect(result.total).toBe(2100);
    expect(result.breakdown).toContain("period");
    expect(result.breakdown).toContain("week");
  });

  it("handles single day correctly", () => {
    const result = calculate28DayPrice(1, daily, weekly, twentyEightDay);
    expect(result.total).toBe(100);
    expect(result.breakdown).toContain("1 day");
  });

  it("uses weeks when cheaper than daily", () => {
    const result = calculate28DayPrice(7, daily, weekly, twentyEightDay);
    // 1 week (500) < 7 days (700)
    expect(result.total).toBe(500);
  });

  it("rounds result to 2 decimal places", () => {
    // Use rates that produce fractional cents
    const result = calculate28DayPrice(3, 33.33, 200, 800);
    expect(result.total).toBe(Math.round(3 * 33.33 * 100) / 100);
  });

  it("includes plural 'days' in breakdown when remainder > 1", () => {
    const result = calculate28DayPrice(30, daily, weekly, twentyEightDay);
    // 1 period + 2 days = 1800, or 4 weeks + 2 days = 2200 — period wins
    expect(result.total).toBe(1800);
    expect(result.breakdown).toContain("days");
  });
});

describe("calculateShiftPricing", () => {
  const baseInput = {
    days: 28,
    dailyRate: 100,
    weeklyRate: 500,
    monthlyRate: 1800,
    twentyEightDayRate: 1600,
    billingCycleType: "28day" as const,
    shiftType: "single" as const,
  };

  it("single shift applies 1.0x multiplier", () => {
    const result = calculateShiftPricing(baseInput);
    expect(result.shiftMultiplier).toBe(1.0);
    expect(result.adjustedRentalFee).toBe(result.baseRentalFee);
  });

  it("double shift applies 1.5x multiplier", () => {
    const result = calculateShiftPricing({ ...baseInput, shiftType: "double" });
    expect(result.shiftMultiplier).toBe(1.5);
    expect(result.adjustedRentalFee).toBe(Math.round(result.baseRentalFee * 1.5 * 100) / 100);
    expect(result.breakdown).toContain("double shift");
  });

  it("triple shift applies 2.0x multiplier", () => {
    const result = calculateShiftPricing({ ...baseInput, shiftType: "triple" });
    expect(result.shiftMultiplier).toBe(2.0);
    expect(result.adjustedRentalFee).toBe(result.baseRentalFee * 2.0);
    expect(result.breakdown).toContain("triple shift");
  });

  it("single shift breakdown does not include shift label", () => {
    const result = calculateShiftPricing(baseInput);
    expect(result.breakdown).not.toContain("single shift");
    expect(result.breakdown).not.toContain("double shift");
    expect(result.breakdown).not.toContain("triple shift");
  });

  it("uses 28-day pricing when billingCycleType is 28day", () => {
    const result = calculateShiftPricing(baseInput);
    expect(result.baseRentalFee).toBe(1600);
  });

  it("uses calendar pricing when billingCycleType is calendar", () => {
    const result = calculateShiftPricing({
      ...baseInput,
      billingCycleType: "calendar",
      days: 7,
    });
    // Should use calculateRentalPrice with daily/weekly/monthly
    expect(result.baseRentalFee).toBe(500); // weekly rate
  });

  it("rounds adjusted fee to 2 decimal places", () => {
    const result = calculateShiftPricing({
      ...baseInput,
      shiftType: "double",
      days: 3,
      billingCycleType: "28day",
    });
    // 3 days × $100 = $300, × 1.5 = $450
    const expected = Math.round(result.baseRentalFee * 1.5 * 100) / 100;
    expect(result.adjustedRentalFee).toBe(expected);
  });
});

describe("calculateOvertime", () => {
  it("returns 0 overtime when hours within allowance", () => {
    const result = calculateOvertime({
      engineHoursUsed: 40,
      rentalDays: 5,
      standardHoursPerDay: 8,
      dailyRate: 800,
    });
    expect(result.overtimeHours).toBe(0);
    expect(result.overtimeCost).toBe(0);
    expect(result.standardHours).toBe(40);
  });

  it("calculates overtime when hours exceed allowance", () => {
    const result = calculateOvertime({
      engineHoursUsed: 50,
      rentalDays: 5,
      standardHoursPerDay: 8,
      dailyRate: 800,
    });
    expect(result.standardHours).toBe(40);
    expect(result.overtimeHours).toBe(10);
    expect(result.hourlyRate).toBe(100); // 800 / 8
    expect(result.overtimeCost).toBe(1000); // 10 × 100
  });

  it("returns actual hours in result", () => {
    const result = calculateOvertime({
      engineHoursUsed: 55,
      rentalDays: 5,
      standardHoursPerDay: 8,
      dailyRate: 800,
    });
    expect(result.actualHours).toBe(55);
  });

  it("handles 0 overtime hours exactly at boundary", () => {
    const result = calculateOvertime({
      engineHoursUsed: 80,
      rentalDays: 10,
      standardHoursPerDay: 8,
      dailyRate: 800,
    });
    expect(result.overtimeHours).toBe(0);
    expect(result.overtimeCost).toBe(0);
  });

  it("handles fewer hours than allowed (no negative overtime)", () => {
    const result = calculateOvertime({
      engineHoursUsed: 10,
      rentalDays: 5,
      standardHoursPerDay: 8,
      dailyRate: 800,
    });
    expect(result.overtimeHours).toBe(0);
    expect(result.overtimeCost).toBe(0);
  });

  it("rounds hourly rate to 2 decimal places", () => {
    const result = calculateOvertime({
      engineHoursUsed: 50,
      rentalDays: 5,
      standardHoursPerDay: 8,
      dailyRate: 1000,
    });
    // 1000 / 8 = 125
    expect(result.hourlyRate).toBe(125);
  });

  it("rounds overtime cost to 2 decimal places", () => {
    const result = calculateOvertime({
      engineHoursUsed: 11,
      rentalDays: 1,
      standardHoursPerDay: 8,
      dailyRate: 100,
    });
    // hourlyRate = 100/8 = 12.5, overtimeHours = 3, cost = 37.5
    expect(result.hourlyRate).toBe(12.5);
    expect(result.overtimeCost).toBe(37.5);
  });
});
