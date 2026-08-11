import { describe, expect, it } from "vitest";
import {
  assertHistoricalClassificationCutoff,
  buildReadyOperationValues,
  buildResponsibilityUpdates,
  calculateTermPickupCutoff,
  hashClassificationPreview,
  validateRollingStartRental,
} from "../server/services/rollingRentalOperations";
import { isHistoricalCutoffWithinBounds } from "../shared/rollingRental";

describe("rolling rental operation commands", () => {
  describe("historical classification cutoff", () => {
    const originalEndDate = new Date("2026-07-01T04:00:00.000Z");
    const now = new Date("2026-07-16T16:00:00.000Z");

    it("requires the cutoff to be strictly after the original rental end", () => {
      expect(() => assertHistoricalClassificationCutoff({
        originalEndDate,
        cutoff: new Date("2026-06-30T23:59:59.999Z"),
        now,
      })).toThrow("after the original rental end");
      expect(() => assertHistoricalClassificationCutoff({
        originalEndDate,
        cutoff: originalEndDate,
        now,
      })).toThrow("after the original rental end");
    });

    it("rejects a cutoff after the current server time", () => {
      expect(() => assertHistoricalClassificationCutoff({
        originalEndDate,
        cutoff: new Date("2026-07-16T16:00:00.001Z"),
        now,
      })).toThrow("future");
    });

    it("accepts the first valid instant and the current server time", () => {
      expect(() => assertHistoricalClassificationCutoff({
        originalEndDate,
        cutoff: new Date("2026-07-01T04:00:00.001Z"),
        now,
      })).not.toThrow();
      expect(() => assertHistoricalClassificationCutoff({
        originalEndDate,
        cutoff: now,
        now,
      })).not.toThrow();
    });

    it("exposes the same pure range rule to the browser", () => {
      expect(isHistoricalCutoffWithinBounds(originalEndDate, originalEndDate, now)).toBe(false);
      expect(isHistoricalCutoffWithinBounds(originalEndDate, new Date("2026-07-02T04:00:00.000Z"), now)).toBe(true);
      expect(isHistoricalCutoffWithinBounds(originalEndDate, new Date("2026-07-17T04:00:00.000Z"), now)).toBe(false);
    });
  });

  it("accepts active assigned non-credit rentals", () => {
    expect(() => validateRollingStartRental({
      status: "active",
      isCreditOrder: false,
      endDate: new Date("2026-08-10T12:00:00.000Z"),
    }, [101], new Date("2026-08-01T12:00:00.000Z"))).not.toThrow();
  });

  it("requires guarded historical conversion for past or overdue rentals", () => {
    expect(() => validateRollingStartRental({
      status: "overdue",
      isCreditOrder: false,
      endDate: new Date("2026-07-01T12:00:00.000Z"),
    }, [101], new Date("2026-08-01T12:00:00.000Z"))).toThrow("historical classification");

    expect(() => validateRollingStartRental({
      status: "active",
      isCreditOrder: false,
      endDate: new Date("2026-07-31T12:00:00.000Z"),
    }, [101], new Date("2026-08-01T12:00:00.000Z"))).toThrow("historical classification");
  });

  it("rejects terminal, credit, and unassigned rentals", () => {
    expect(() => validateRollingStartRental({
      status: "completed",
      isCreditOrder: false,
      endDate: new Date("2026-08-10T12:00:00.000Z"),
    }, [101], new Date())).toThrow("active");
    expect(() => validateRollingStartRental({
      status: "active",
      isCreditOrder: true,
      endDate: new Date("2099-12-31T00:00:00.000Z"),
    }, [101], new Date())).toThrow(/credit/i);
    expect(() => validateRollingStartRental({
      status: "active",
      isCreditOrder: false,
      endDate: new Date("2026-08-10T12:00:00.000Z"),
    }, [], new Date())).toThrow("assigned");
  });

  it("builds company-ready operations for every assigned unit", () => {
    const ready = new Date("2026-08-01T15:00:00.000Z");
    const scheduled = new Date("2026-08-02T15:00:00.000Z");

    expect(buildReadyOperationValues({
      rentalId: 10,
      fleetIds: [101, 102],
      customerReadyAt: ready,
      scheduledPickupAt: scheduled,
      actorUserId: 7,
    })).toEqual([
      expect.objectContaining({
        rentalRequestId: 10,
        rentalFleetId: 101,
        delayResponsibility: "company",
        billingStopAt: ready,
      }),
      expect.objectContaining({ rentalFleetId: 102, billingStopAt: ready }),
    ]);
  });

  it("clears the cutoff only for an audited customer-responsibility correction", () => {
    const ready = new Date("2026-08-01T15:00:00.000Z");
    const operations = [{
      id: 1,
      customerReadyAt: ready,
      billingStopAt: ready,
    }];

    expect(buildResponsibilityUpdates(operations, "customer", 7, "Customer site not ready"))
      .toEqual([expect.objectContaining({
        id: 1,
        delayResponsibility: "customer",
        billingStopAt: null,
        responsibilitySetBy: 7,
        responsibilityReason: "Customer site not ready",
      })]);
  });

  it("stops customer-delay order billing only after every unit is picked up", () => {
    const first = new Date("2026-08-03T15:00:00.000Z");
    const second = new Date("2026-08-04T15:00:00.000Z");

    expect(calculateTermPickupCutoff([
      { pickedUpAt: first, delayResponsibility: "customer" },
      { pickedUpAt: null, delayResponsibility: "customer" },
    ])).toBeNull();
    expect(calculateTermPickupCutoff([
      { pickedUpAt: first, delayResponsibility: "customer" },
      { pickedUpAt: second, delayResponsibility: "customer" },
    ])).toEqual(second);
  });

  it("hashes every amount-affecting historical preview field", () => {
    const preview = {
      rentalId: 10,
      endDate: "2026-07-01T12:00:00.000Z",
      confirmedAt: "2026-08-01T12:00:00.000Z",
      rentalFee: 1000,
      taxAmount: 130,
      totalAmount: 1130,
    };

    expect(hashClassificationPreview(preview)).toBe(hashClassificationPreview(preview));
    expect(hashClassificationPreview(preview)).not.toBe(hashClassificationPreview({
      ...preview,
      totalAmount: 1131,
    }));
  });
});
