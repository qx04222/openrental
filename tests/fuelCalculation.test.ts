/**
 * Fuel Surcharge Calculation — unit tests
 *
 * Tests fuel settlement logic for Canadian equipment rental:
 * - full_to_full: surcharge when returned below dispatch level
 * - included / excluded: no surcharge
 * - Edge cases: 0 tank capacity, rounding
 */
import { describe, it, expect } from "vitest";

import { calculateFuelSurcharge } from "../server/services/fuelCalculation";

describe("calculateFuelSurcharge", () => {
  it("calculates surcharge for full_to_full with level difference", () => {
    const result = calculateFuelSurcharge({
      fuelPolicy: "full_to_full",
      dispatchFuelLevel: 100,
      returnFuelLevel: 50,
      tankCapacityLitres: 200,
      pricePerLitre: 1.80,
    });
    // 50% of 200L = 100L short, × $1.80 = $180
    expect(result.litresShort).toBe(100);
    expect(result.surcharge).toBe(180);
    expect(result.breakdown).toContain("100.0L short");
    expect(result.breakdown).toContain("$1.80/L");
  });

  it("returns no surcharge when returned full (full_to_full)", () => {
    const result = calculateFuelSurcharge({
      fuelPolicy: "full_to_full",
      dispatchFuelLevel: 100,
      returnFuelLevel: 100,
      tankCapacityLitres: 200,
      pricePerLitre: 1.80,
    });
    expect(result.litresShort).toBe(0);
    expect(result.surcharge).toBe(0);
    expect(result.breakdown).toBe("Fuel: returned full");
  });

  it("returns no surcharge when returned above dispatch level", () => {
    const result = calculateFuelSurcharge({
      fuelPolicy: "full_to_full",
      dispatchFuelLevel: 50,
      returnFuelLevel: 75,
      tankCapacityLitres: 200,
      pricePerLitre: 1.80,
    });
    expect(result.litresShort).toBe(0);
    expect(result.surcharge).toBe(0);
  });

  it("returns no surcharge for included policy", () => {
    const result = calculateFuelSurcharge({
      fuelPolicy: "included",
      dispatchFuelLevel: 100,
      returnFuelLevel: 0,
      tankCapacityLitres: 500,
      pricePerLitre: 2.00,
    });
    expect(result.surcharge).toBe(0);
    expect(result.litresShort).toBe(0);
    expect(result.breakdown).toBe("Fuel: included");
  });

  it("returns no surcharge for excluded policy", () => {
    const result = calculateFuelSurcharge({
      fuelPolicy: "excluded",
      dispatchFuelLevel: 100,
      returnFuelLevel: 10,
      tankCapacityLitres: 300,
      pricePerLitre: 1.50,
    });
    expect(result.surcharge).toBe(0);
    expect(result.litresShort).toBe(0);
    expect(result.breakdown).toBe("Fuel: excluded");
  });

  it("handles 0 tank capacity", () => {
    const result = calculateFuelSurcharge({
      fuelPolicy: "full_to_full",
      dispatchFuelLevel: 100,
      returnFuelLevel: 0,
      tankCapacityLitres: 0,
      pricePerLitre: 1.80,
    });
    expect(result.litresShort).toBe(0);
    expect(result.surcharge).toBe(0);
  });

  it("rounds litres and surcharge to 2 decimal places", () => {
    const result = calculateFuelSurcharge({
      fuelPolicy: "full_to_full",
      dispatchFuelLevel: 100,
      returnFuelLevel: 67,
      tankCapacityLitres: 150,
      pricePerLitre: 1.73,
    });
    // 33% of 150L = 49.5L, × $1.73 = $85.635 → $85.64
    expect(result.litresShort).toBe(49.5);
    expect(result.surcharge).toBe(Math.round(49.5 * 1.73 * 100) / 100);
  });

  it("handles partial fuel level difference", () => {
    const result = calculateFuelSurcharge({
      fuelPolicy: "full_to_full",
      dispatchFuelLevel: 80,
      returnFuelLevel: 60,
      tankCapacityLitres: 100,
      pricePerLitre: 2.00,
    });
    // 20% of 100L = 20L, × $2.00 = $40
    expect(result.litresShort).toBe(20);
    expect(result.surcharge).toBe(40);
  });
});
