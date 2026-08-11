import { describe, it, expect } from "vitest";
import { calculateBracketFreight, DEFAULT_FREIGHT_CONFIG } from "../shared/freight";
import { calculateOrderDeposit } from "../shared/deposit";

describe("calculateBracketFreight", () => {
  it("self-pickup is free", () => {
    expect(calculateBracketFreight(20, "pickup").cost).toBe(0);
  });

  it("round-trip uses the distance bracket directly", () => {
    expect(calculateBracketFreight(20, "delivery_and_return").cost).toBe(285);
    expect(calculateBracketFreight(30, "delivery_and_return").cost).toBe(285);
    expect(calculateBracketFreight(31, "delivery_and_return").cost).toBe(335);
    expect(calculateBracketFreight(45, "delivery_and_return").cost).toBe(335);
    expect(calculateBracketFreight(60, "delivery_and_return").cost).toBe(385);
    expect(calculateBracketFreight(75, "delivery_and_return").cost).toBe(435);
  });

  it("one-way = round-trip ÷ 2 × 1.15, rounded to nearest $10", () => {
    expect(calculateBracketFreight(20, "delivery").cost).toBe(160); // round(285*0.575)=164→160
    expect(calculateBracketFreight(45, "delivery").cost).toBe(190); // 335*0.575=192.6→190
    expect(calculateBracketFreight(60, "delivery").cost).toBe(220); // 385*0.575=221.4→220
    expect(calculateBracketFreight(75, "delivery").cost).toBe(250); // 435*0.575=250.1→250
  });

  it("beyond max KNOWN distance → manual", () => {
    expect(calculateBracketFreight(76, "delivery_and_return").needsManual).toBe(true);
    expect(calculateBracketFreight(76, "delivery_and_return").cost).toBe(0);
  });

  it("unknown distance → lowest ≤30km bracket (no manual), flagged assumedMinTier", () => {
    const rt = calculateBracketFreight(null, "delivery_and_return");
    expect(rt.needsManual).toBe(false);
    expect(rt.cost).toBe(285);
    expect(rt.assumedMinTier).toBe(true);

    const ow = calculateBracketFreight(undefined, "delivery");
    expect(ow.needsManual).toBe(false);
    expect(ow.cost).toBe(160); // 285*0.575=164→160
    expect(ow.assumedMinTier).toBe(true);

    expect(calculateBracketFreight(NaN, "delivery_and_return").cost).toBe(285);

    // pickup is still free even with unknown distance
    expect(calculateBracketFreight(null, "pickup").cost).toBe(0);
  });

  it("respects custom config", () => {
    const cfg = { ...DEFAULT_FREIGHT_CONFIG, tier30: 300, maxKm: 100 };
    expect(calculateBracketFreight(25, "delivery_and_return", cfg).cost).toBe(300);
    expect(calculateBracketFreight(90, "delivery_and_return", cfg).needsManual).toBe(false);
  });
});

describe("calculateOrderDeposit", () => {
  it("account/credit customer (creditLimit > 0) is waived", () => {
    expect(calculateOrderDeposit(1000, { creditLimit: 5000 })).toBe(0);
    expect(calculateOrderDeposit(1000, { creditLimit: 0 })).toBeGreaterThan(0);
  });

  it("1.5x after-tax total, rounded up to $50", () => {
    expect(calculateOrderDeposit(646.93)).toBe(1000); // 1.5*646.93=970.4 → 1000
    expect(calculateOrderDeposit(324.88)).toBe(500);  // 487.32 → 500
    expect(calculateOrderDeposit(100)).toBe(150);     // 150 → 150
    expect(calculateOrderDeposit(101)).toBe(200);     // 151.5 → 200
  });

  it("zero / negative base → 0", () => {
    expect(calculateOrderDeposit(0)).toBe(0);
    expect(calculateOrderDeposit(-5)).toBe(0);
  });
});
