import { describe, it, expect } from "vitest";
import {
  classifyIdleTier,
  buildFinancingScenarios,
  TIER2_MAX_DAYS,
  TIER2_MAX_ORDERS,
  type FinancingUnit,
} from "../server/services/financingPlan";

describe("classifyIdleTier", () => {
  it("tier1 = fully idle (0 rented days, regardless of count)", () => {
    expect(classifyIdleTier({ rentedDays: 0, rentalCount: 0 })).toBe("tier1");
    expect(classifyIdleTier({ rentedDays: 0, rentalCount: 5 })).toBe("tier1");
  });

  it("tier2 = barely used (< max days AND <= max orders)", () => {
    expect(classifyIdleTier({ rentedDays: 0.5, rentalCount: 1 })).toBe("tier2");
    expect(classifyIdleTier({ rentedDays: 3.5, rentalCount: 1 })).toBe("tier2");
    // boundary: exactly TIER2_MAX_DAYS is NOT tier2
    expect(classifyIdleTier({ rentedDays: TIER2_MAX_DAYS, rentalCount: 1 })).toBe("normal");
    // boundary: more than TIER2_MAX_ORDERS short rentals is NOT tier2
    expect(classifyIdleTier({ rentedDays: 2, rentalCount: TIER2_MAX_ORDERS + 1 })).toBe("normal");
  });

  it("normal = everything else", () => {
    expect(classifyIdleTier({ rentedDays: 10, rentalCount: 3 })).toBe("normal");
    expect(classifyIdleTier({ rentedDays: 4, rentalCount: 1 })).toBe("normal");
  });
});

describe("buildFinancingScenarios", () => {
  const units: FinancingUnit[] = [
    { purchaseCost: 100_000, tier: "normal" },
    { purchaseCost: 30_000, tier: "tier2" },
    { purchaseCost: 20_000, tier: "tier1" },
    { purchaseCost: null, tier: "normal" }, // null cost contributes 0
  ];

  it("computes 0%-interest monthly = total / term for each exclusion set", () => {
    const [current, exTier1, exTier1Tier2] = buildFinancingScenarios({ units, termsMonths: [36, 48] });

    // current keeps all 4 units; value = 150,000 (null → 0)
    expect(current.key).toBe("current");
    expect(current.unitCount).toBe(4);
    expect(current.totalValue).toBe(150_000);
    expect(current.terms.find((t) => t.months === 36)!.monthly).toBeCloseTo(150_000 / 36, 2);
    expect(current.terms.find((t) => t.months === 48)!.monthly).toBeCloseTo(150_000 / 48, 2);
    expect(current.terms.every((t) => t.savingVsCurrent === 0)).toBe(true);

    // drop tier1 (20k) → 130,000 over 3 units
    expect(exTier1.totalValue).toBe(130_000);
    expect(exTier1.unitCount).toBe(3);

    // drop tier1 + tier2 (20k + 30k) → 100,000 over 2 units
    expect(exTier1Tier2.totalValue).toBe(100_000);
    expect(exTier1Tier2.unitCount).toBe(2);
  });

  it("reports monthly saving versus the current scenario at the same term", () => {
    const [, , exTier1Tier2] = buildFinancingScenarios({ units, termsMonths: [36] });
    // saving = current monthly − scenario monthly = (150000 − 100000)/36
    expect(exTier1Tier2.terms[0].savingVsCurrent).toBeCloseTo(50_000 / 36, 2);
  });

  it("sanitizes terms (drops non-positive, dedups, sorts)", () => {
    const s = buildFinancingScenarios({ units, termsMonths: [48, 36, 36, 0, -12] });
    expect(s[0].terms.map((t) => t.months)).toEqual([36, 48]);
  });

  it("handles an empty fleet without dividing by an empty term list", () => {
    const s = buildFinancingScenarios({ units: [], termsMonths: [36] });
    expect(s[0].totalValue).toBe(0);
    expect(s[0].terms[0].monthly).toBe(0);
  });
});
