import { describe, it, expect } from "vitest";
import {
  calculateRentalPrice,
  calculateDaysBetween,
  formatCurrency,
} from "../server/services/pricingCalculation";
import { parseCalendarDate } from "../server/_core/dateUtils";

describe("Server Pricing Calculation (real implementation)", () => {
  describe("calculateRentalPrice", () => {
    const daily = 100;
    const weekly = 500;
    const monthly = 1500;

    it("returns 0 for 0 days", () => {
      expect(calculateRentalPrice(0, daily, weekly, monthly).total).toBe(0);
    });

    it("returns 0 for negative days", () => {
      expect(calculateRentalPrice(-5, daily, weekly, monthly).total).toBe(0);
    });

    it("calculates 1 day correctly", () => {
      const result = calculateRentalPrice(1, daily, weekly, monthly);
      expect(result.total).toBe(100);
      expect(result.breakdown).toContain("day");
    });

    it("uses weekly rate when cheaper (7 days)", () => {
      const result = calculateRentalPrice(7, daily, weekly, monthly);
      expect(result.total).toBe(500);
      expect(result.breakdown).toContain("week");
    });

    it("uses monthly rate when cheaper (30 days)", () => {
      const result = calculateRentalPrice(30, daily, weekly, monthly);
      expect(result.total).toBe(1500);
      expect(result.breakdown).toContain("month");
    });

    it("optimizes mixed periods (35 days = 1 month + 5 days)", () => {
      const result = calculateRentalPrice(35, daily, weekly, monthly);
      // 1 month ($1500) + 5 days ($500) = $2000
      // vs 5 weeks ($2500)
      expect(result.total).toBeLessThanOrEqual(2000);
    });

    it("optimizes complex period (45 days)", () => {
      const result = calculateRentalPrice(45, daily, weekly, monthly);
      // Should find optimal: 1 month + 2 weeks + 1 day
      // = $1500 + $1000 + $100 = $2600
      // vs 1 month + 15 days = $1500 + $1500 = $3000
      expect(result.total).toBeLessThanOrEqual(2600);
    });

    it("handles equal rates gracefully", () => {
      const result = calculateRentalPrice(7, 100, 700, 2800);
      expect(result.total).toBe(700);
    });

    it("breakdown string is non-empty for positive days", () => {
      const result = calculateRentalPrice(10, daily, weekly, monthly);
      expect(result.breakdown).toBeTruthy();
    });

    // Regression (Top-10 #8): null/0 rates must NOT be treated as a free tier.
    describe("zero/null rate guards", () => {
      it("prices off daily only when weekly/monthly are 0 (no free week/month)", () => {
        // 10 days, only a $100/day rate configured → must be 10×100 = 1000,
        // never $0 by 'covering' with a free week.
        const result = calculateRentalPrice(10, 100, 0, 0);
        expect(result.total).toBe(1000);
      });

      it("does not emit $0 when daily is unset but weekly exists (rounds up)", () => {
        // 3 days, only a $500/week rate → cannot charge per-day, so 1 week.
        const result = calculateRentalPrice(3, 0, 500, 0);
        expect(result.total).toBe(500);
      });

      it("returns 0 only when no positive rate is configured at all", () => {
        expect(calculateRentalPrice(10, 0, 0, 0).total).toBe(0);
      });

      it("ignores a free monthly tier and uses the cheaper real tiers", () => {
        // monthly = 0 must not win as 'free coverage' for a 30-day rental.
        const result = calculateRentalPrice(30, 100, 500, 0);
        expect(result.total).toBeGreaterThan(0);
        // best = 4 weeks (2000) + 2 days (200) = 2200, or 30 days daily = 3000
        expect(result.total).toBe(2200);
      });
    });

    // Cover singular/plural branches in formatBreakdown
    it("breakdown uses singular 'month' for exactly 1 month", () => {
      const result = calculateRentalPrice(30, daily, weekly, monthly);
      expect(result.breakdown).toMatch(/1 month/);
      expect(result.breakdown).not.toMatch(/1 months/);
    });

    it("breakdown uses plural 'months' for 2+ months", () => {
      const result = calculateRentalPrice(60, daily, weekly, monthly);
      expect(result.breakdown).toMatch(/2 months/);
    });

    it("breakdown uses singular 'week' for exactly 1 week", () => {
      const result = calculateRentalPrice(7, daily, weekly, monthly);
      expect(result.breakdown).toMatch(/1 week/);
      expect(result.breakdown).not.toMatch(/1 weeks/);
    });

    it("breakdown uses plural 'weeks' for 2+ weeks", () => {
      const result = calculateRentalPrice(14, daily, weekly, monthly);
      expect(result.breakdown).toMatch(/2 weeks/);
    });

    it("breakdown uses singular 'day' for exactly 1 day", () => {
      const result = calculateRentalPrice(1, daily, weekly, monthly);
      expect(result.breakdown).toMatch(/1 day/);
      expect(result.breakdown).not.toMatch(/1 days/);
    });

    it("breakdown uses plural 'days' for 2+ days", () => {
      const result = calculateRentalPrice(3, daily, weekly, monthly);
      expect(result.breakdown).toMatch(/3 days/);
    });

    it("handles mixed period with all singular (1 month + 1 week + 1 day = 38 days)", () => {
      const result = calculateRentalPrice(38, daily, weekly, monthly);
      expect(result.breakdown).toContain("month");
      expect(result.breakdown).toContain("week");
      expect(result.breakdown).toContain("day");
    });

    it("covers the 'else' path where coveredDays >= days (months/weeks only)", () => {
      // 30 days = 1 month exactly (no remaining days needed)
      const result = calculateRentalPrice(30, 100, 500, 1500);
      expect(result.total).toBe(1500);
    });

    it("prefers daily when weekly/monthly are overpriced", () => {
      const result = calculateRentalPrice(5, 10, 200, 5000);
      expect(result.total).toBe(50); // 5 days × $10
    });
  });

  describe("calculateDaysBetween (hotel-style)", () => {
    it("same day returns 1 (minimum)", () => {
      const d = new Date("2024-01-15");
      expect(calculateDaysBetween(d, d)).toBe(1);
    });

    it("consecutive days returns 1 (pickup 15th, return 16th = 1 day)", () => {
      expect(calculateDaysBetween(new Date("2024-01-15"), new Date("2024-01-16"))).toBe(1);
    });

    it("Jan 1 to Jan 7 returns 6 days", () => {
      expect(calculateDaysBetween(new Date("2024-01-01"), new Date("2024-01-07"))).toBe(6);
    });

    it("handles reverse order", () => {
      const result = calculateDaysBetween(new Date("2024-06-15"), new Date("2024-01-15"));
      expect(result).toBeGreaterThan(0);
    });

    // Regression (Top-10 #9): a range crossing the Toronto fall-back DST
    // boundary spans 49h for 2 calendar days; raw ceil(49/24) over-counted to 3.
    // Use parseCalendarDate so the instants are real Toronto midnights (and the
    // test is not fragile under TZ=UTC CI — see the tz-fragile-tests lesson).
    it("does not over-count across the November DST fall-back", () => {
      const start = parseCalendarDate("2024-11-02"); // day before Toronto fall-back
      const end = parseCalendarDate("2024-11-04");    // day after
      expect(calculateDaysBetween(start, end)).toBe(2);
    });

    it("does not over-count across the March DST spring-forward", () => {
      const start = parseCalendarDate("2025-03-08"); // day before spring-forward
      const end = parseCalendarDate("2025-03-10");
      expect(calculateDaysBetween(start, end)).toBe(2);
    });
  });

  describe("formatCurrency", () => {
    it("formats positive amount", () => {
      const result = formatCurrency(1234.56);
      expect(result).toContain("1,234.56");
    });

    it("formats zero", () => {
      const result = formatCurrency(0);
      expect(result).toContain("0.00");
    });

    it("formats negative amount", () => {
      const result = formatCurrency(-500);
      expect(result).toContain("500");
    });

    it("includes currency symbol", () => {
      const result = formatCurrency(100);
      expect(result).toMatch(/\$|CA/);
    });
  });
});
