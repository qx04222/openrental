import { describe, expect, it } from "vitest";
import {
  buildEndedRollingTermValues,
  calculateRollingPriceDelta,
  finalRollingSourceKey,
  historicalRollingSourceKey,
  rollingPeriodSourceKey,
} from "../server/services/rollingSettlement";

const snapshot = (overrides: Partial<Record<string, number | string>> = {}) => ({
  rentalFee: 1000,
  insuranceCost: 100,
  taxAmount: 143,
  freightCost: 285,
  depositAmount: 500,
  totalAmount: 1528,
  breakdown: "",
  taxBreakdown: "HST 13%",
  days: 28,
  ...overrides,
});

describe("rolling settlement", () => {
  it("ends a rolling term with an auditable completion reason", () => {
    const endedAt = new Date("2026-08-04T15:00:00.000Z");
    expect(buildEndedRollingTermValues(endedAt, 7)).toEqual({
      status: "ended",
      endedAt,
      endedBy: 7,
      endReason: "rental_completed",
      updatedAt: endedAt,
    });
  });

  it("uses deterministic period, final, and historical source keys", () => {
    const start = new Date("2026-07-01T00:00:00.000Z");
    const end = new Date("2026-07-29T00:00:00.000Z");

    expect(rollingPeriodSourceKey(10, start, end)).toBe(
      "rolling:10:2026-07-01T00:00:00.000Z:2026-07-29T00:00:00.000Z",
    );
    expect(finalRollingSourceKey(10, end)).toBe(
      "rolling-final:10:2026-07-29T00:00:00.000Z",
    );
    expect(historicalRollingSourceKey(10, end)).toBe(
      "rolling-catchup:10:2026-07-29T00:00:00.000Z",
    );
  });

  it("prices only the incremental rental, insurance, and tax", () => {
    const delta = calculateRollingPriceDelta(
      snapshot(),
      snapshot({
        rentalFee: 1800,
        insuranceCost: 180,
        taxAmount: 257.4,
        totalAmount: 2522.4,
        days: 56,
      }),
    );

    expect(delta).toEqual({
      rentalFee: 800,
      insuranceCost: 80,
      subtotal: 880,
      taxAmount: 114.4,
      totalAmount: 994.4,
    });
  });

  it("does not rebill freight or deposit", () => {
    const delta = calculateRollingPriceDelta(
      snapshot({ freightCost: 285, depositAmount: 500 }),
      snapshot({ freightCost: 570, depositAmount: 1000 }),
    );

    expect(delta.subtotal).toBe(0);
    expect(delta.totalAmount).toBe(0);
  });

  it("rounds each monetary component to cents", () => {
    const delta = calculateRollingPriceDelta(
      snapshot({ rentalFee: 1.111, insuranceCost: 2.222, taxAmount: 3.333 }),
      snapshot({ rentalFee: 2.226, insuranceCost: 3.337, taxAmount: 4.448 }),
    );

    expect(delta).toEqual({
      rentalFee: 1.12,
      insuranceCost: 1.12,
      subtotal: 2.24,
      taxAmount: 1.12,
      totalAmount: 3.36,
    });
  });
});
