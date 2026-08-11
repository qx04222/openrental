import { describe, expect, it } from "vitest";
import {
  assetProgressTab,
  areAssetsReadyForAdminClose,
  areFieldOperationsBlocked,
  fieldProgressRefreshInterval,
  canConfirmPhysicalPickup,
  inspectionEvidenceTone,
  rollingOperationalTone,
  shouldShowNextSettlement,
  stageProgressIndex,
} from "../client/src/lib/assetProgressPresentation";

describe("asset progress presentation", () => {
  it("groups exact server stages into the four operator tabs", () => {
    expect(assetProgressTab("entry_pending")).toBe("entry");
    expect(assetProgressTab("entry_ready")).toBe("entry");
    expect(assetProgressTab("in_rental")).toBe("rental");
    expect(assetProgressTab("return_pending")).toBe("return");
    expect(assetProgressTab("return_ready")).toBe("return");
    expect(assetProgressTab("completed")).toBe("completed");
  });

  it("keeps bypass evidence visually distinct from completed inspection", () => {
    expect(inspectionEvidenceTone("completed")).toBe("verified");
    expect(inspectionEvidenceTone("bypassed")).toBe("bypassed");
    expect(inspectionEvidenceTone("not_required")).toBe("neutral");
    expect(inspectionEvidenceTone("pending")).toBe("attention");
  });

  it("orders the six lifecycle stages consistently", () => {
    expect(stageProgressIndex("entry_pending")).toBe(0);
    expect(stageProgressIndex("return_ready")).toBe(4);
    expect(stageProgressIndex("completed")).toBe(5);
  });

  it("highlights rolling return states and only offers pickup at the right moment", () => {
    expect(rollingOperationalTone("rolling_renewal")).toBe("info");
    expect(rollingOperationalTone("awaiting_pickup")).toBe("warning");
    expect(rollingOperationalTone("awaiting_close")).toBe("success");
    expect(rollingOperationalTone("customer_overdue")).toBe("danger");
    expect(canConfirmPhysicalPickup({ operationalState: "awaiting_pickup", pickedUpAt: null })).toBe(true);
    expect(canConfirmPhysicalPickup({ operationalState: "awaiting_return_inspection", pickedUpAt: new Date() })).toBe(false);
  });

  it("marks a rolling rental ready to close only after pickup and return evidence", () => {
    expect(areAssetsReadyForAdminClose([{
      stage: "return_ready",
      pickupTransport: "disabled",
      rollingStatus: "ending",
      pickedUpAt: new Date("2026-07-17T14:10:26.000Z"),
    }])).toBe(true);

    expect(areAssetsReadyForAdminClose([{
      stage: "return_ready",
      pickupTransport: "disabled",
      rollingStatus: "ending",
      pickedUpAt: null,
    }])).toBe(false);
  });

  it("does not offer admin close-out while return inspection or pickup transport is incomplete", () => {
    expect(areAssetsReadyForAdminClose([{
      stage: "return_pending",
      pickupTransport: "disabled",
      rollingStatus: null,
      pickedUpAt: null,
    }])).toBe(false);

    expect(areAssetsReadyForAdminClose([{
      stage: "return_ready",
      pickupTransport: "delivered",
      rollingStatus: null,
      pickedUpAt: null,
    }])).toBe(false);
  });

  it("requires every equipment unit before offering rental close-out", () => {
    expect(areAssetsReadyForAdminClose([
      { stage: "return_ready", pickupTransport: "completed", rollingStatus: null, pickedUpAt: null },
      { stage: "return_pending", pickupTransport: "completed", rollingStatus: null, pickedUpAt: null },
    ])).toBe(false);
    expect(areAssetsReadyForAdminClose([])).toBe(false);
  });

  it("shows the next settlement only while a rolling rental can still settle", () => {
    expect(shouldShowNextSettlement({
      rentalStatus: "active",
      rollingStatus: "active",
      nextSettlementDate: new Date("2026-08-14T00:00:00.000Z"),
    })).toBe(true);
    expect(shouldShowNextSettlement({
      rentalStatus: "completed",
      rollingStatus: "active",
      nextSettlementDate: new Date("2026-08-14T00:00:00.000Z"),
    })).toBe(false);
    expect(shouldShowNextSettlement({
      rentalStatus: "completed",
      rollingStatus: "ended",
      nextSettlementDate: new Date("2026-08-14T00:00:00.000Z"),
    })).toBe(false);
    expect(shouldShowNextSettlement({
      rentalStatus: "active",
      rollingStatus: "ending",
      nextSettlementDate: null,
    })).toBe(false);
  });

  it("blocks field operations whenever an equipment occupancy conflict exists", () => {
    expect(areFieldOperationsBlocked({ occupancyConflict: true })).toBe(true);
    expect(areFieldOperationsBlocked({ occupancyConflict: false })).toBe(false);
  });

  it("refreshes the live field list every 30 seconds only while the page is visible", () => {
    expect(fieldProgressRefreshInterval("visible")).toBe(30_000);
    expect(fieldProgressRefreshInterval("hidden")).toBe(false);
  });
});
