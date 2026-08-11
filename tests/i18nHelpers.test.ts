import { describe, it, expect } from "vitest";
import { tDeliveryMethod, tInsurance } from "../client/src/lib/i18nHelpers";

// Mock TFunction that returns the key path for verification
function mockT(key: string, opts?: { ns?: string }): string {
  return opts?.ns ? `[${opts.ns}] ${key}` : key;
}

describe("i18nHelpers (real implementation)", () => {
  describe("tDeliveryMethod", () => {
    it("returns label and description for pickup", () => {
      const result = tDeliveryMethod(mockT as never, "pickup");
      expect(result.label).toContain("delivery.pickup.label");
      expect(result.description).toContain("delivery.pickup.description");
    });

    it("returns label and description for delivery", () => {
      const result = tDeliveryMethod(mockT as never, "delivery");
      expect(result.label).toContain("delivery.delivery.label");
      expect(result.description).toContain("delivery.delivery.description");
    });

    it("returns label and description for delivery_and_return", () => {
      const result = tDeliveryMethod(mockT as never, "delivery_and_return");
      expect(result.label).toContain("delivery.delivery_and_return.label");
      expect(result.description).toContain("delivery.delivery_and_return.description");
    });

    it("uses rental namespace", () => {
      const result = tDeliveryMethod(mockT as never, "pickup");
      expect(result.label).toContain("[rental]");
    });
  });

  describe("tInsurance", () => {
    it("returns label and description for none", () => {
      const result = tInsurance(mockT as never, "none");
      expect(result.label).toContain("insurance.none.label");
      expect(result.description).toContain("insurance.none.description");
    });

    it("returns label and description for basic", () => {
      const result = tInsurance(mockT as never, "basic");
      expect(result.label).toContain("insurance.basic.label");
      expect(result.description).toContain("insurance.basic.description");
    });

    it("returns label and description for full", () => {
      const result = tInsurance(mockT as never, "full");
      expect(result.label).toContain("insurance.full.label");
      expect(result.description).toContain("insurance.full.description");
    });

    it("uses rental namespace", () => {
      const result = tInsurance(mockT as never, "basic");
      expect(result.label).toContain("[rental]");
    });
  });
});
