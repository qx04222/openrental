import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enCommon from "../client/src/i18n/locales/en/common.json";
import zhCommon from "../client/src/i18n/locales/zh/common.json";

const read = (path: string) => readFileSync(path, "utf8");

describe("high-traffic operational errors carry translation hints", () => {
  it("uses i18nError on the selected low-risk error paths", () => {
    const fleet = read("server/routers/rentalFleet.router.ts");
    const workOrders = read("server/routers/workOrders.router.ts");
    const assetProgress = read("server/services/rentalAssetProgress.ts");
    const rolling = read("server/routers/rollingRentals.router.ts");

    expect(fleet).toContain('i18nKey: "errors.fleet.activeRentalDeleteBlocked"');
    expect(workOrders).toContain('i18nKey: "errors.workOrder.fleetAssetRequired"');
    expect(workOrders).toContain('i18nKey: "errors.workOrder.customerNameRequired"');
    expect(workOrders).toContain('i18nKey: "errors.workOrder.endAfterStart"');
    expect(assetProgress).toContain('i18nKey: "errors.rentalNotFound"');
    expect(rolling).toContain('i18nKey: "errors.rolling.disabled"');
    expect(rolling).toContain('i18nKey: "errors.rolling.pickupForbidden"');
  });

  it("keeps English fallback text exact and provides Chinese translations", () => {
    const expected = {
      "errors.fleet.activeRentalDeleteBlocked": "Cannot delete equipment with active or pending rentals",
      "errors.workOrder.fleetAssetRequired": "A fleet asset is required for the work order.",
      "errors.workOrder.customerNameRequired": "Customer name is required for external work orders.",
      "errors.workOrder.endAfterStart": "End time must be after start time.",
      "errors.rentalNotFound": "Rental not found",
      "errors.rolling.disabled": "Rolling renewal operations are disabled",
      "errors.rolling.pickupForbidden": "Operator is not authorized to record pickup",
    } as const;

    for (const [key, fallback] of Object.entries(expected)) {
      expect((enCommon as Record<string, string>)[key]).toBe(fallback);
      expect((zhCommon as Record<string, string>)[key]).toBeTruthy();
      expect((zhCommon as Record<string, string>)[key]).not.toBe(fallback);
    }
  });
});
