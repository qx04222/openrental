import { describe, expect, it } from "vitest";
import { parseRenewalSupplementPayload, planRenewalSupplementEffect } from "../server/jobs/rentalLifecycleEffectsCron";

describe("renewal supplement lifecycle effect", () => {
  it("validates and converts the durable payload", () => {
    const parsed = parseRenewalSupplementPayload({
      extensionRequestId: 9,
      actorId: 3,
      oldEndDate: "2026-07-31T00:00:00.000Z",
      newEndDate: "2026-08-15T00:00:00.000Z",
      oldRentalFee: 1200,
      newRentalFee: 1800,
      oldInsuranceCost: 120,
      newInsuranceCost: 180,
      oldTaxAmount: 171.6,
      newTaxAmount: 257.4,
      newTaxBreakdown: "HST 13%",
    });

    expect(parsed.extensionRequestId).toBe(9);
    expect(parsed.newEndDate).toEqual(new Date("2026-08-15T00:00:00.000Z"));
    expect(() => parseRenewalSupplementPayload({ extensionRequestId: 9 })).toThrow("Invalid renewal supplement effect payload");
  });

  it("skips rentals without an issued base invoice and completes idempotent retries", () => {
    const sourceKey = "rental:42:extension:9";
    expect(planRenewalSupplementEffect([], sourceKey)).toBe("skip");
    expect(planRenewalSupplementEffect([{ sourceKey: "rental:42:base" }], sourceKey)).toBe("generate");
    expect(planRenewalSupplementEffect([{ sourceKey }], sourceKey)).toBe("already_generated");
  });
});
