import { describe, it, expect } from "vitest";
import { computeOverrideFields, PRICE_OVERRIDE_FIELDS } from "../shared/priceOverride";

describe("computeOverrideFields", () => {
  it("records only the components that diverge, with from→to", () => {
    const computed = {
      rentalFee: "280.00",
      freightCost: "335.00",
      insuranceCost: "42.00",
      taxAmount: "78.91",
      depositAmount: "0.00",
      totalAmount: "735.91",
    };
    const final = { ...computed, freightCost: "285.00", totalAmount: "685.91" };
    expect(computeOverrideFields(computed, final)).toEqual({
      freightCost: { from: "335.00", to: "285.00" },
      totalAmount: { from: "735.91", to: "685.91" },
    });
  });

  it("returns null when nothing diverges", () => {
    const same = { rentalFee: "100.00", freightCost: "285.00" };
    expect(computeOverrideFields(same, same)).toBeNull();
  });

  it("treats numerically-equal strings as unchanged (285 vs 285.00)", () => {
    expect(
      computeOverrideFields({ freightCost: "285" }, { freightCost: "285.00" }),
    ).toBeNull();
  });

  it("skips components the caller did not set (undefined `to`)", () => {
    // edit path passes undefined for fields not in the update
    const computed = { rentalFee: "100.00", freightCost: "285.00" };
    const final = { rentalFee: "120.00", freightCost: undefined };
    expect(computeOverrideFields(computed, final)).toEqual({
      rentalFee: { from: "100.00", to: "120.00" },
    });
  });

  it("captures a null→value change (component had no system price)", () => {
    expect(
      computeOverrideFields({ freightCost: null }, { freightCost: "285.00" }),
    ).toEqual({ freightCost: { from: null, to: "285.00" } });
  });

  it("covers every money component", () => {
    const computed = Object.fromEntries(PRICE_OVERRIDE_FIELDS.map((f) => [f, "1.00"]));
    const final = Object.fromEntries(PRICE_OVERRIDE_FIELDS.map((f) => [f, "2.00"]));
    const diff = computeOverrideFields(computed, final)!;
    expect(Object.keys(diff).sort()).toEqual([...PRICE_OVERRIDE_FIELDS].sort());
  });
});
