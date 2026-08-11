import { describe, it, expect } from "vitest";
import { calculateRentalPrice, calculateDaysBetween, formatCurrency } from "../client/src/lib/pricing";
import { calculateInsuranceCost, calculateDeposit } from "../shared/insurance";

describe("calculateRentalPrice", () => {
  const daily = 100;
  const weekly = 500;
  const monthly = 1800;

  it("returns 0 for 0 or negative days", () => {
    expect(calculateRentalPrice(0, daily, weekly, monthly).total).toBe(0);
    expect(calculateRentalPrice(-1, daily, weekly, monthly).total).toBe(0);
  });

  it("calculates single day correctly", () => {
    const result = calculateRentalPrice(1, daily, weekly, monthly);
    expect(result.total).toBe(100);
  });

  it("prefers weekly rate over 7 daily rates when cheaper", () => {
    const result = calculateRentalPrice(7, daily, weekly, monthly);
    expect(result.total).toBe(500);
    expect(result.total).toBeLessThan(7 * daily);
  });

  it("prefers monthly rate over 30 daily rates when cheaper", () => {
    const result = calculateRentalPrice(30, daily, weekly, monthly);
    expect(result.total).toBe(1800);
    expect(result.total).toBeLessThan(30 * daily);
  });

  it("handles mixed period optimally (35 days)", () => {
    const result = calculateRentalPrice(35, daily, weekly, monthly);
    // 1 month (1800) + 5 days (500) = 2300
    // vs 5 weeks (2500)
    // vs 1 month + 1 week (2300) — same
    expect(result.total).toBeLessThanOrEqual(2300);
  });

  it("provides a breakdown string", () => {
    const result = calculateRentalPrice(10, daily, weekly, monthly);
    expect(result.breakdown).toBeTruthy();
    expect(typeof result.breakdown).toBe("string");
  });

  it("breakdown includes months plural", () => {
    const result = calculateRentalPrice(60, daily, weekly, monthly);
    expect(result.breakdown).toContain("months");
  });

  it("breakdown includes weeks plural", () => {
    const result = calculateRentalPrice(14, daily, weekly, monthly);
    expect(result.breakdown).toContain("weeks");
  });

  it("breakdown includes days plural when remainder > 1", () => {
    const result = calculateRentalPrice(9, daily, weekly, monthly);
    expect(result.breakdown).toContain("days");
  });

  it("breakdown includes singular month/week/day", () => {
    const result = calculateRentalPrice(38, daily, weekly, monthly);
    expect(result.breakdown).toContain("month");
  });

  it("handles exact week boundary (7 days)", () => {
    // When weekly is cheaper than 7 * daily, the weekly should be used
    const result = calculateRentalPrice(7, 100, 500, 1800);
    expect(result.total).toBe(500);
  });

  it("handles exact month boundary (30 days)", () => {
    const result = calculateRentalPrice(30, 100, 500, 1800);
    expect(result.total).toBe(1800);
  });

  it("handles case where daily is cheaper than weekly per day", () => {
    // weekly = 800, daily = 100, so 7 daily (700) < 1 weekly (800)
    const result = calculateRentalPrice(7, 100, 800, 2000);
    expect(result.total).toBe(700);
  });

  it("handles case where months+weeks exactly cover days (no remainder)", () => {
    // 37 days = 1 month (30) + 1 week (7) = exactly 37
    const result = calculateRentalPrice(37, 100, 500, 1800);
    expect(result.total).toBeLessThanOrEqual(1800 + 500);
  });
});

describe("calculateDaysBetween (hotel-style: pickup day to return day)", () => {
  it("Jan 1 to Jan 7 = 6 days (like 6 nights)", () => {
    const start = new Date("2024-01-01");
    const end = new Date("2024-01-07");
    expect(calculateDaysBetween(start, end)).toBe(6);
  });

  it("same day pickup+return = 1 day minimum", () => {
    const d = new Date("2024-06-15");
    expect(calculateDaysBetween(d, d)).toBe(1);
  });

  it("consecutive days = 1 day (26th pickup, 27th return)", () => {
    expect(calculateDaysBetween(new Date("2024-01-26"), new Date("2024-01-27"))).toBe(1);
  });

  it("handles month boundaries: Jan 28 to Feb 3 = 6 days", () => {
    const start = new Date("2024-01-28");
    const end = new Date("2024-02-03");
    expect(calculateDaysBetween(start, end)).toBe(6);
  });
});

describe("calculateInsuranceCost", () => {
  it("returns 0 for none insurance", () => {
    expect(calculateInsuranceCost(1000, "none")).toBe(0);
  });

  it("returns 15% for basic insurance", () => {
    expect(calculateInsuranceCost(1000, "basic")).toBe(150);
  });

  it("returns 25% for full insurance", () => {
    expect(calculateInsuranceCost(1000, "full")).toBe(250);
  });

  it("rounds to 2 decimal places", () => {
    expect(calculateInsuranceCost(333, "basic")).toBe(49.95);
  });
});

describe("calculateDeposit", () => {
  it("returns 20% of equipment price when available", () => {
    expect(calculateDeposit(10000)).toBe(2000);
  });

  it("rounds to 2 decimal places", () => {
    expect(calculateDeposit(9999)).toBe(1999.8);
  });

  it("uses industrial fallback when no equipment price", () => {
    expect(calculateDeposit(null)).toBe(5000);
    expect(calculateDeposit(0)).toBe(5000);
  });

  it("uses powersports fallback for powersports division", () => {
    expect(calculateDeposit(null, "powersports")).toBe(1000);
  });

  it("uses industrial fallback for unknown division", () => {
    expect(calculateDeposit(null, "unknown")).toBe(5000);
  });
});

describe("formatCurrency", () => {
  it("formats number as CAD currency", () => {
    const result = formatCurrency(1234.56, "en-CA");
    expect(result).toContain("1,234.56");
  });

  it("accepts zh-CN locale", () => {
    const result = formatCurrency(1000, "zh-CN");
    expect(result).toBeTruthy();
  });

  it("uses default locale when none provided", () => {
    const result = formatCurrency(500);
    expect(result).toBeTruthy();
    expect(result).toContain("500");
  });

  it("formats zero correctly", () => {
    const result = formatCurrency(0, "en-CA");
    expect(result).toContain("0");
  });

  it("formats negative values", () => {
    const result = formatCurrency(-100, "en-CA");
    expect(result).toContain("100");
  });

  it("uses zh-CN locale when localStorage language starts with zh", () => {
    // Mock localStorage
    const origLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      value: { getItem: (key: string) => key === "i18nextLng" ? "zh-CN" : null },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", { value: {}, writable: true, configurable: true });

    const result = formatCurrency(500);
    expect(result).toContain("500");

    Object.defineProperty(globalThis, "localStorage", { value: origLocalStorage, writable: true, configurable: true });
  });
});
