import { describe, expect, it } from "vitest";
import {
  evaluateLifecyclePlan,
  makeLifecycleCommandKey,
  nextLifecycleVersion,
  type FulfillmentSnapshot,
  type LifecycleRentalSnapshot,
} from "../server/services/rentalLifecycle";

const rental = (overrides: Partial<LifecycleRentalSnapshot> = {}): LifecycleRentalSnapshot => ({
  id: 42,
  status: "active",
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  endDate: new Date("2026-07-10T00:00:00.000Z"),
  updatedAt: new Date("2026-07-11T12:00:00.000Z"),
  ...overrides,
});

const fulfillment = (overrides: Partial<FulfillmentSnapshot> = {}): FulfillmentSnapshot => ({
  requiredFleetIds: [101],
  dispatchInspectedFleetIds: [101],
  dispatchInspectionBypassedFleetIds: [],
  returnInspectedFleetIds: [101],
  returnInspectionBypassedFleetIds: [],
  incompletePickupFleetIds: [],
  unpickedReturnOperationFleetIds: [],
  ...overrides,
});

describe("rental lifecycle planner", () => {
  it("allows a ready single-unit rental to complete", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental(),
      targetStatus: "completed",
      fulfillment: fulfillment(),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.requiredEffects).toContain("invoice_reconcile");
    expect(plan.willWrite).toBe(true);
  });

  it("blocks completion when one unit lacks a return inspection", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental(),
      targetStatus: "completed",
      fulfillment: fulfillment({
        requiredFleetIds: [101, 102],
        returnInspectedFleetIds: [101],
      }),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "RETURN_INSPECTION_MISSING",
      fleetId: 102,
    }));
  });

  it("blocks activation when dispatch inspection is required and missing", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental({ status: "approved" }),
      targetStatus: "active",
      fulfillment: fulfillment({ dispatchInspectedFleetIds: [] }),
      dispatchInspectionRequired: true,
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "DISPATCH_INSPECTION_MISSING",
      fleetId: 101,
    }));
  });

  it("allows only the bypassed unit through required dispatch inspection", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental({ status: "approved" }),
      targetStatus: "active",
      fulfillment: fulfillment({
        requiredFleetIds: [101, 102],
        dispatchInspectedFleetIds: [102],
        dispatchInspectionBypassedFleetIds: [101],
      }),
      dispatchInspectionRequired: true,
    });

    expect(plan.blockers).toEqual([]);
  });

  it("blocks completion when a required pickup remains unfinished", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental(),
      targetStatus: "completed",
      fulfillment: fulfillment({ incompletePickupFleetIds: [101] }),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "PICKUP_INCOMPLETE",
      fleetId: 101,
    }));
  });

  it("blocks completion when rolling return equipment is not physically picked up", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental(),
      targetStatus: "completed",
      fulfillment: fulfillment({ unpickedReturnOperationFleetIds: [101] }),
      dispatchWorkflow: false,
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "PHYSICAL_PICKUP_MISSING",
      fleetId: 101,
    }));
  });

  it("ignores unfinished pickup only while dispatch workflow is disabled", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental(),
      targetStatus: "completed",
      fulfillment: fulfillment({
        incompletePickupFleetIds: [101],
      }),
      dispatchWorkflow: false,
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers.some((b) => b.code === "PICKUP_INCOMPLETE")).toBe(false);
    expect(plan.requiredEffects).toContain("invoice_reconcile");
  });

  it("keeps unfinished pickup blocking while dispatch workflow is enabled", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental(),
      targetStatus: "completed",
      fulfillment: fulfillment({ incompletePickupFleetIds: [101] }),
      dispatchWorkflow: true,
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers.some((b) => b.code === "PICKUP_INCOMPLETE")).toBe(true);
  });

  it("allows completion without return inspection only when policy is disabled", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental(),
      targetStatus: "completed",
      fulfillment: fulfillment({ returnInspectedFleetIds: [] }),
      returnInspectionRequired: false,
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers.some((b) => b.code === "RETURN_INSPECTION_MISSING")).toBe(false);
    expect(plan.requiredEffects).toContain("invoice_reconcile");
  });

  it("applies return inspection bypass to only the named fleet unit", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental(),
      targetStatus: "completed",
      fulfillment: fulfillment({
        requiredFleetIds: [101, 102],
        returnInspectedFleetIds: [],
        returnInspectionBypassedFleetIds: [101],
      }),
      returnInspectionRequired: true,
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers).not.toContainEqual(expect.objectContaining({
      code: "RETURN_INSPECTION_MISSING",
      fleetId: 101,
    }));
    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "RETURN_INSPECTION_MISSING",
      fleetId: 102,
    }));
  });

  it("requires early-return confirmation before the scheduled end", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental({ endDate: new Date("2026-07-20T00:00:00.000Z") }),
      targetStatus: "completed",
      fulfillment: fulfillment(),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "EARLY_RETURN_UNCONFIRMED",
    }));
  });

  it("rejects an invalid transition", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental({ status: "pending" }),
      targetStatus: "completed",
      fulfillment: fulfillment(),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({
      code: "INVALID_TRANSITION",
    }));
  });

  it("allows a named recovery path to override only the transition edge", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental({ status: "completed" }),
      targetStatus: "active",
      fulfillment: fulfillment(),
      transitionOverrideReason: "super_admin_reopen",
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.willWrite).toBe(true);
  });

  it("turns a same-status retry into reconciliation instead of a blind no-op", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental({ status: "completed" }),
      targetStatus: "completed",
      fulfillment: fulfillment(),
      now: new Date("2026-07-11T12:00:00.000Z"),
    });

    expect(plan.willWrite).toBe(false);
    expect(plan.reconcileOnly).toBe(true);
    expect(plan.requiredEffects).toContain("invoice_reconcile");
    expect(plan.requiredEffects).not.toContain("notification");
    expect(plan.requiredEffects).not.toContain("mailpulse");
  });

  it("does not repeat ambiguous approval messages during reconciliation", () => {
    const plan = evaluateLifecyclePlan({
      rental: rental({ status: "approved" }),
      targetStatus: "approved",
      fulfillment: fulfillment(),
    });

    expect(plan.requiredEffects).toEqual(["contract_generate", "quotation_generate"]);
  });

  it("builds a stable command key from the pre-transition snapshot", () => {
    const first = makeLifecycleCommandKey(rental(), "completed");
    const second = makeLifecycleCommandKey(rental(), "completed");

    expect(first).toBe(second);
    expect(first).toContain("42:active:completed:");
  });

  it("advances a nullable lifecycle version without timestamp round-trips", () => {
    expect(nextLifecycleVersion(null)).toBe(1);
    expect(nextLifecycleVersion(7)).toBe(8);
  });
});
