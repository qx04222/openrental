import { describe, it, expect } from "vitest";
import {
  computeTier,
  DEFAULT_SEGMENTATION_CONFIG,
  type SegmentationConfig,
} from "../server/services/customerSegmentation";

const now = new Date("2026-04-18T00:00:00.000Z");

function daysAgo(days: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
}

describe("computeTier", () => {
  // VIP threshold tests
  describe("VIP tier", () => {
    it("returns vip when revenue equals the threshold", () => {
      expect(computeTier({ totalRevenue: 50000, lastRentalDate: daysAgo(200) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("vip");
    });

    it("returns vip when revenue exceeds the threshold", () => {
      expect(computeTier({ totalRevenue: 100000, lastRentalDate: null }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("vip");
    });

    it("returns vip even when lastRentalDate is null and revenue is above threshold", () => {
      expect(computeTier({ totalRevenue: 50000, lastRentalDate: null }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("vip");
    });

    it("does NOT return vip when revenue is just below threshold", () => {
      const tier = computeTier({ totalRevenue: 49999.99, lastRentalDate: daysAgo(10) }, DEFAULT_SEGMENTATION_CONFIG, now);
      expect(tier).not.toBe("vip");
    });

    it("returns vip when revenue is a string representation of a number above threshold", () => {
      expect(computeTier({ totalRevenue: "75000.00", lastRentalDate: daysAgo(100) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("vip");
    });

    it("handles string revenue exactly at threshold", () => {
      expect(computeTier({ totalRevenue: "50000", lastRentalDate: daysAgo(200) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("vip");
    });
  });

  // Active tier tests
  describe("active tier", () => {
    it("returns active when last rental was within activeWithinDays", () => {
      expect(computeTier({ totalRevenue: 100, lastRentalDate: daysAgo(10) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("active");
    });

    it("returns active when last rental was exactly at activeWithinDays", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(90) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("active");
    });

    it("returns active when last rental was 1 day ago", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(1) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("active");
    });

    it("returns active using string date input", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(30).toISOString() }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("active");
    });
  });

  // At Risk tier tests
  describe("at_risk tier", () => {
    it("returns at_risk when last rental was between activeWithinDays and atRiskWithinDays", () => {
      expect(computeTier({ totalRevenue: 100, lastRentalDate: daysAgo(91) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("at_risk");
    });

    it("returns at_risk when last rental was exactly at atRiskWithinDays", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(180) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("at_risk");
    });

    it("returns at_risk for mid-range recency", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(135) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("at_risk");
    });
  });

  // Churned tier tests
  describe("churned tier", () => {
    it("returns churned when lastRentalDate is null", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: null }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("churned");
    });

    it("returns churned when lastRentalDate is undefined", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: undefined as unknown as null }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("churned");
    });

    it("returns churned when last rental was older than atRiskWithinDays", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(181) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("churned");
    });

    it("returns churned for very old rental date", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(1000) }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("churned");
    });

    it("returns churned for invalid date string", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: "not-a-date" }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("churned");
    });
  });

  // Null / edge case revenue tests
  describe("null and edge case revenue", () => {
    it("treats null revenue as 0 (below vip threshold)", () => {
      const tier = computeTier({ totalRevenue: null, lastRentalDate: daysAgo(10) }, DEFAULT_SEGMENTATION_CONFIG, now);
      expect(tier).toBe("active");
    });

    it("treats null revenue as 0 and churned when no rental date", () => {
      expect(computeTier({ totalRevenue: null, lastRentalDate: null }, DEFAULT_SEGMENTATION_CONFIG, now)).toBe("churned");
    });

    it("treats zero revenue as non-VIP", () => {
      const tier = computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(10) }, DEFAULT_SEGMENTATION_CONFIG, now);
      expect(tier).not.toBe("vip");
    });
  });

  // Custom config tests
  describe("custom SegmentationConfig", () => {
    const customConfig: SegmentationConfig = {
      vipRevenueThreshold: 1000,
      activeWithinDays: 30,
      atRiskWithinDays: 60,
    };

    it("applies custom vip threshold", () => {
      expect(computeTier({ totalRevenue: 1000, lastRentalDate: daysAgo(200) }, customConfig, now)).toBe("vip");
    });

    it("applies custom activeWithinDays", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(30) }, customConfig, now)).toBe("active");
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(31) }, customConfig, now)).toBe("at_risk");
    });

    it("applies custom atRiskWithinDays", () => {
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(60) }, customConfig, now)).toBe("at_risk");
      expect(computeTier({ totalRevenue: 0, lastRentalDate: daysAgo(61) }, customConfig, now)).toBe("churned");
    });
  });
});
