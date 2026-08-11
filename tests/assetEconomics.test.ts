import { describe, it, expect } from "vitest";
import { computeAssetEconomics } from "../server/services/assetEconomics";

const NOW = new Date("2026-06-10T12:00:00Z");

// 7-year life, 10% salvage — the default policy.
const policy = { usefulLifeYears: 7, salvagePct: 0.1, now: NOW };

describe("computeAssetEconomics", () => {
  it("computes straight-line depreciation, book value and payback for a typical asset", () => {
    // $100k machine bought exactly 2 years ago, earned $40k net rent.
    const r = computeAssetEconomics({
      purchaseCost: 100_000,
      purchaseDate: new Date("2024-06-10T12:00:00Z"),
      netRentalRevenue: 40_000,
      ...policy,
    });
    expect(r.ageYears).toBe(2); // ~1.999y → rounds to 2.0 for display
    // depreciable base = 90,000; annual = 90,000/7 = 12,857.14 (age-independent, exact)
    expect(r.annualDepreciation).toBeCloseTo(12_857.14, 1);
    // age-derived metrics use precise elapsed time (~1.999y), so assert ranges
    expect(r.accumulatedDepreciation!).toBeGreaterThan(25_500);
    expect(r.accumulatedDepreciation!).toBeLessThan(25_900);
    expect(r.bookValue!).toBeGreaterThan(74_100);
    expect(r.bookValue!).toBeLessThan(74_500);
    // payback = 40k/100k = 40% (age-independent, exact)
    expect(r.paybackPct).toBe(40);
    // annualized net ≈ 40k/2 ≈ 20k; ROI = (20k − 12,857)/100k ≈ 7.2%
    expect(r.annualizedNetRevenue!).toBeGreaterThan(19_800);
    expect(r.annualizedNetRevenue!).toBeLessThan(20_200);
    expect(r.annualRoiPct!).toBeGreaterThan(6.5);
    expect(r.annualRoiPct!).toBeLessThan(7.7);
    expect(r.isPaidBack).toBe(false);
  });

  it("flags an asset that has paid itself back", () => {
    const r = computeAssetEconomics({
      purchaseCost: 50_000,
      purchaseDate: new Date("2020-06-10T12:00:00Z"),
      netRentalRevenue: 80_000,
      ...policy,
    });
    expect(r.paybackPct).toBe(160);
    expect(r.isPaidBack).toBe(true);
  });

  it("caps accumulated depreciation at the depreciable base (never below salvage)", () => {
    // 20 years old, well past the 7-year life.
    const r = computeAssetEconomics({
      purchaseCost: 100_000,
      purchaseDate: new Date("2006-06-10T12:00:00Z"),
      netRentalRevenue: 300_000,
      ...policy,
    });
    expect(r.accumulatedDepreciation).toBe(90_000); // = depreciable base
    expect(r.bookValue).toBe(10_000); // = salvage value, not negative
  });

  it("returns null cost-based metrics when purchaseCost is missing", () => {
    const r = computeAssetEconomics({
      purchaseCost: null,
      purchaseDate: new Date("2024-06-10T12:00:00Z"),
      netRentalRevenue: 10_000,
      ...policy,
    });
    expect(r.annualDepreciation).toBeNull();
    expect(r.accumulatedDepreciation).toBeNull();
    expect(r.bookValue).toBeNull();
    expect(r.paybackPct).toBeNull();
    expect(r.annualRoiPct).toBeNull();
    expect(r.isPaidBack).toBe(false);
  });

  it("returns null age/annualized metrics when purchaseDate is missing", () => {
    const r = computeAssetEconomics({
      purchaseCost: 100_000,
      purchaseDate: null,
      netRentalRevenue: 10_000,
      ...policy,
    });
    expect(r.ageYears).toBeNull();
    expect(r.annualizedNetRevenue).toBeNull();
    expect(r.annualRoiPct).toBeNull();
    // cost-based, age-independent metrics still compute
    expect(r.annualDepreciation).toBeCloseTo(12_857.14, 1);
    expect(r.paybackPct).toBe(10);
  });

  it("does not annualize a brand-new asset (< 0.5y) to avoid absurd figures", () => {
    // bought 1 month ago, earned $5k — annualizing would imply $60k/yr.
    const r = computeAssetEconomics({
      purchaseCost: 80_000,
      purchaseDate: new Date("2026-05-10T12:00:00Z"),
      netRentalRevenue: 5_000,
      ...policy,
    });
    expect(r.annualizedNetRevenue).toBeNull();
    expect(r.annualRoiPct).toBeNull();
    // but payback still shows progress
    expect(r.paybackPct).toBeCloseTo(6.3, 0);
  });
});
