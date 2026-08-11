import { describe, expect, it, vi } from "vitest";
import {
  buildLifecycleProgressEvents,
  filterFieldProgressByDispatchAssignments,
  loadRentalAssetProgress,
  loadFieldRentalAssetProgress,
  loadRentalAssetProgressBatch,
  listAssetProgressEvents,
  recordAssetProgressEvent,
  resolveRentalAssetProgress,
  type RentalAssetProgressFacts,
} from "../server/services/rentalAssetProgress";

const now = new Date("2026-07-15T12:00:00.000Z");

const facts = (overrides: Partial<RentalAssetProgressFacts> = {}): RentalAssetProgressFacts => ({
  rentalRequestId: 10,
  rentalFleetId: 101,
  rentalNumber: "R-100",
  customerName: "North Site",
  customerPhone: "4165550100",
  startDate: new Date("2026-07-15T00:00:00.000Z"),
  endDate: new Date("2026-07-20T00:00:00.000Z"),
  equipmentLabel: "Bobcat S70",
  serialNumber: "SN-ER620-045",
  rentalStatus: "approved",
  deliveryMethod: "delivery_and_return",
  hasDispatchInspection: false,
  hasReturnInspection: false,
  hasDispatchInspectionBypass: false,
  hasReturnInspectionBypass: false,
  returnStarted: false,
  rollingStatus: null,
  rollingBilledThroughDate: null,
  nextSettlementDate: null,
  customerReadyAt: null,
  scheduledPickupAt: null,
  delayResponsibility: "none",
  billingStopAt: null,
  pickedUpAt: null,
  deliveryDispatchStatus: null,
  pickupDispatchStatus: null,
  deliveryDispatchId: null,
  pickupDispatchId: null,
  deliveryDispatchDetails: {
    scheduledDate: new Date("2026-07-15T13:00:00.000Z"),
    pickupAddress: "1 Warehouse Way",
    deliveryAddress: "10 Jobsite Rd",
    distance: "12.50",
    notes: "Call site foreman",
    driverNotes: "Gate code 100",
  },
  pickupDispatchDetails: null,
  policies: {
    dispatchWorkflow: false,
    dispatchInspectionRequired: false,
    returnInspectionRequired: true,
  },
  lastUpdatedAt: now,
  occupancyConflict: false,
  conflictingRentals: [],
  ...overrides,
});

describe("rental asset progress resolver", () => {
  it("returns the display identity needed by both field and admin clients", () => {
    const input = {
      ...facts(),
      serialNumber: "SN-ER620-045",
    } as RentalAssetProgressFacts;
    const progress = resolveRentalAssetProgress(input);

    expect(progress).toMatchObject({
      rentalNumber: "R-100",
      customerName: "North Site",
      customerPhone: "4165550100",
      equipmentLabel: "Bobcat S70",
      serialNumber: "SN-ER620-045",
      deliveryMethod: "delivery_and_return",
      deliveryDispatchId: null,
      pickupDispatchId: null,
      deliveryDispatchDetails: expect.objectContaining({
        deliveryAddress: "10 Jobsite Rd",
        driverNotes: "Gate code 100",
      }),
    });
    expect(progress).not.toHaveProperty("assetNumber");
  });

  it("surfaces occupancy conflicts without changing the derived lifecycle stage", () => {
    const progress = resolveRentalAssetProgress(facts({
      rentalStatus: "overdue",
      occupancyConflict: true,
      conflictingRentals: [
        { rentalId: 10, rentalNumber: "20260528GC", customerName: "BBN", status: "overdue" },
        { rentalId: 11, rentalNumber: "20260702LO", customerName: "Dream", status: "overdue" },
      ],
    }));

    expect(progress).toMatchObject({
      stage: "in_rental",
      occupancyConflict: true,
      conflictingRentals: [
        expect.objectContaining({ rentalNumber: "20260528GC" }),
        expect.objectContaining({ rentalNumber: "20260702LO" }),
      ],
    });
  });

  it("builds deterministic lifecycle and system-bypass evidence per equipment", () => {
    const entryEvents = buildLifecycleProgressEvents({
      commandKey: "rental:10:pending:approved:v1",
      rentalRequestId: 10,
      rentalFleetIds: [101, 102],
      targetStatus: "approved",
      actorUserId: 7,
      createdAt: now,
    });
    const completionEvents = buildLifecycleProgressEvents({
      commandKey: "rental:10:active:completed:v2",
      rentalRequestId: 10,
      rentalFleetIds: [101],
      targetStatus: "completed",
      actorUserId: 7,
      systemReturnInspectionBypassFleetIds: [102],
      createdAt: now,
    });

    expect(entryEvents).toEqual([
      expect.objectContaining({
        eventKey: "lifecycle:rental:10:pending:approved:v1:101:entry_pending",
        rentalFleetId: 101,
        eventType: "entry_pending",
        toStage: "entry_pending",
      }),
      expect.objectContaining({ rentalFleetId: 102, eventType: "entry_pending" }),
    ]);
    expect(completionEvents).toEqual([
      expect.objectContaining({
        eventKey: "system:return_inspection_bypassed:10:102:credit_order_finalization",
        rentalFleetId: 102,
        eventType: "return_inspection_bypassed",
        source: "system",
        reason: "credit_order_finalization",
      }),
      expect.objectContaining({
        eventKey: "lifecycle:rental:10:active:completed:v2:101:completed",
        rentalFleetId: 101,
        eventType: "completed",
        toStage: "completed",
      }),
    ]);
  });

  it("starts at entry pending when dispatch inspection is required", () => {
    const progress = resolveRentalAssetProgress(facts({
      policies: {
        dispatchWorkflow: false,
        dispatchInspectionRequired: true,
        returnInspectionRequired: true,
      },
    }));

    expect(progress).toMatchObject({
      stage: "entry_pending",
      entryInspection: "pending",
      deliveryTransport: "disabled",
    });
  });

  it("distinguishes completed, bypassed, and not-required entry inspections", () => {
    expect(resolveRentalAssetProgress(facts({ hasDispatchInspection: true })).entryInspection).toBe("completed");
    expect(resolveRentalAssetProgress(facts({
      hasDispatchInspectionBypass: true,
      policies: {
        dispatchWorkflow: false,
        dispatchInspectionRequired: true,
        returnInspectionRequired: true,
      },
    })).entryInspection).toBe("bypassed");
    expect(resolveRentalAssetProgress(facts()).entryInspection).toBe("not_required");
  });

  it("shows active equipment as in rental even when a historical dispatch is completed", () => {
    const progress = resolveRentalAssetProgress(facts({
      rentalStatus: "active",
      deliveryDispatchStatus: "completed",
      pickupDispatchStatus: "completed",
    }));

    expect(progress.stage).toBe("in_rental");
    expect(progress.rentalStatus).toBe("active");
  });

  it("distinguishes rolling renewal, pickup delay, and return inspection", () => {
    expect(resolveRentalAssetProgress(facts({
      rentalStatus: "active",
      rollingStatus: "active",
      nextSettlementDate: new Date("2026-08-12T00:00:00.000Z"),
    }))).toMatchObject({
      stage: "in_rental",
      operationalState: "rolling_renewal",
    });

    expect(resolveRentalAssetProgress(facts({
      rentalStatus: "active",
      rollingStatus: "ending",
      customerReadyAt: new Date("2026-08-01T00:00:00.000Z"),
      delayResponsibility: "company",
      billingStopAt: new Date("2026-08-01T00:00:00.000Z"),
    }))).toMatchObject({
      stage: "return_pending",
      operationalState: "awaiting_pickup",
    });

    expect(resolveRentalAssetProgress(facts({
      rentalStatus: "active",
      rollingStatus: "ending",
      customerReadyAt: new Date("2026-08-01T00:00:00.000Z"),
      pickedUpAt: new Date("2026-08-03T00:00:00.000Z"),
      delayResponsibility: "company",
    }))).toMatchObject({
      stage: "return_pending",
      operationalState: "awaiting_return_inspection",
    });
  });

  it("shows customer responsibility as customer overdue without changing pickup state", () => {
    const progress = resolveRentalAssetProgress(facts({
      rentalStatus: "overdue",
      rollingStatus: "ending",
      customerReadyAt: new Date("2026-08-01T00:00:00.000Z"),
      delayResponsibility: "customer",
    }));

    expect(progress).toMatchObject({
      stage: "return_pending",
      operationalState: "customer_overdue",
      delayResponsibility: "customer",
    });
  });

  it("moves from return pending to return ready using real or bypass evidence", () => {
    expect(resolveRentalAssetProgress(facts({
      rentalStatus: "active",
      returnStarted: true,
    }))).toMatchObject({ stage: "return_pending", returnInspection: "pending" });

    expect(resolveRentalAssetProgress(facts({
      rentalStatus: "active",
      returnStarted: true,
      hasReturnInspection: true,
    }))).toMatchObject({ stage: "return_ready", returnInspection: "completed" });

    expect(resolveRentalAssetProgress(facts({
      rentalStatus: "active",
      returnStarted: true,
      hasReturnInspectionBypass: true,
    }))).toMatchObject({ stage: "return_ready", returnInspection: "bypassed" });
  });

  it("keeps bypassed inspection visibly different from completed evidence", () => {
    const progress = resolveRentalAssetProgress(facts({
      rentalStatus: "active",
      returnStarted: true,
      hasReturnInspectionBypass: true,
    }));

    expect(progress.returnInspection).toBe("bypassed");
    expect(progress.returnInspection).not.toBe("completed");
  });

  it("hides transport for customer collection", () => {
    const progress = resolveRentalAssetProgress(facts({
      deliveryMethod: "pickup",
      policies: {
        dispatchWorkflow: true,
        dispatchInspectionRequired: false,
        returnInspectionRequired: true,
      },
    }));

    expect(progress.deliveryTransport).toBe("not_required");
    expect(progress.pickupTransport).toBe("not_required");
  });

  it("shows real transport states only while dispatch is enabled", () => {
    const progress = resolveRentalAssetProgress(facts({
      deliveryDispatchStatus: "in_transit",
      pickupDispatchStatus: "assigned",
      policies: {
        dispatchWorkflow: true,
        dispatchInspectionRequired: false,
        returnInspectionRequired: true,
      },
    }));

    expect(progress.deliveryTransport).toBe("in_transit");
    expect(progress.pickupTransport).toBe("assigned");
  });

  it("uses rental completion as the only terminal-stage authority", () => {
    const progress = resolveRentalAssetProgress(facts({
      rentalStatus: "completed",
      hasReturnInspection: false,
      pickupDispatchStatus: null,
    }));

    expect(progress.stage).toBe("completed");
  });

  it("isolates inspection facts for each fleet unit", () => {
    const first = resolveRentalAssetProgress(facts({
      rentalFleetId: 101,
      rentalStatus: "active",
      returnStarted: true,
      hasReturnInspection: true,
    }));
    const second = resolveRentalAssetProgress(facts({
      rentalFleetId: 102,
      rentalStatus: "active",
      returnStarted: true,
      hasReturnInspection: false,
    }));

    expect(first).toMatchObject({ rentalFleetId: 101, stage: "return_ready" });
    expect(second).toMatchObject({ rentalFleetId: 102, stage: "return_pending" });
  });

  it("loads independent facts for every assigned fleet unit", async () => {
    const resultSets = [
      [{ id: 10, rentalNumber: "R-100", customerName: "North Site", startDate: now, endDate: now, status: "active", deliveryMethod: "delivery_and_return", rentalFleetId: 101, updatedAt: now }],
      [
        { rentalRequestId: 10, rentalFleetId: 101, brand: "Bobcat", model: "S70", serialNumber: "SN-BOBCAT-101", assetNumber: "BIN-101" },
        { rentalRequestId: 10, rentalFleetId: 102, brand: "Kubota", model: "SVL", serialNumber: "SN-KUBOTA-102", assetNumber: "BIN-102" },
      ],
      [{ id: 501, rentalRequestId: 10, rentalFleetId: 101, type: "return", createdAt: now }],
      [{
        id: 600,
        rentalRequestId: 10,
        rentalFleetId: 101,
        orderType: "delivery",
        status: "completed",
        scheduledDate: new Date("2026-07-14T13:00:00.000Z"),
        pickupAddress: "Old Warehouse",
        deliveryAddress: "Old Jobsite",
        distance: "10.00",
        notes: "Historical dispatch",
        driverNotes: null,
        updatedAt: new Date("2026-07-14T13:00:00.000Z"),
      }, {
        id: 601,
        rentalRequestId: 10,
        rentalFleetId: 101,
        orderType: "delivery",
        status: "assigned",
        scheduledDate: new Date("2026-07-15T13:00:00.000Z"),
        pickupAddress: "1 Warehouse Way",
        deliveryAddress: "10 Jobsite Rd",
        distance: "12.50",
        notes: "Call site foreman",
        driverNotes: "Gate code 100",
        updatedAt: now,
      }],
      [],
      [
        { rentalRequestId: 10, rentalFleetId: 101, eventType: "return_started", createdAt: now },
        { rentalRequestId: 10, rentalFleetId: 102, eventType: "return_started", createdAt: now },
      ],
      [],
      [],
    ];
    const select = vi.fn(() => {
      const rows = resultSets.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "orderBy", "leftJoin", "innerJoin"]) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (value: unknown[]) => void) => Promise.resolve(rows).then(resolve);
      return chain;
    });

    const progress = await loadRentalAssetProgress({ select } as never, 10, facts().policies);

    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({
      rentalFleetId: 101,
      serialNumber: "SN-BOBCAT-101",
      stage: "return_ready",
      returnInspection: "completed",
      deliveryDispatchId: 601,
      deliveryDispatchDetails: {
        scheduledDate: new Date("2026-07-15T13:00:00.000Z"),
        pickupAddress: "1 Warehouse Way",
        deliveryAddress: "10 Jobsite Rd",
        distance: "12.50",
        notes: "Call site foreman",
        driverNotes: "Gate code 100",
      },
    });
    expect(progress[0]).not.toHaveProperty("assetNumber");
    expect(progress[1]).toMatchObject({ rentalFleetId: 102, serialNumber: "SN-KUBOTA-102", stage: "return_pending", returnInspection: "pending" });
    expect(progress[1]).not.toHaveProperty("assetNumber");
  });

  it("loads multiple rentals with a constant batch query count", async () => {
    const resultSets = [
      [
        { id: 10, rentalNumber: "R-10", customerName: "A", startDate: now, endDate: now, status: "active", deliveryMethod: "pickup", rentalFleetId: 101, updatedAt: now },
        { id: 11, rentalNumber: "R-11", customerName: "B", startDate: now, endDate: now, status: "overdue", deliveryMethod: "pickup", rentalFleetId: 102, updatedAt: now },
      ],
      [
        { rentalRequestId: 10, rentalFleetId: 101, brand: "Bobcat", model: "S70", serialNumber: "SN-101" },
        { rentalRequestId: 11, rentalFleetId: 102, brand: "Kubota", model: "SVL", serialNumber: "SN-102" },
      ],
      [],
      [],
      [],
      [],
      [],
      [],
    ];
    const select = vi.fn(() => {
      const rows = resultSets.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "orderBy", "leftJoin", "innerJoin"]) {
        chain[method] = vi.fn(() => chain);
      }
      chain.then = (resolve: (value: unknown[]) => void) => Promise.resolve(rows).then(resolve);
      return chain;
    });

    const progress = await loadRentalAssetProgressBatch({ select } as never, [10, 11], facts().policies);

    expect(progress).toHaveLength(2);
    expect(progress.map((item) => item.serialNumber)).toEqual(["SN-101", "SN-102"]);
    expect(select).toHaveBeenCalledTimes(8);
  });

  it("inserts progress events idempotently by event key", async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));

    await recordAssetProgressEvent({ insert } as never, {
      eventKey: "inspection:501:completed",
      rentalRequestId: 10,
      rentalFleetId: 101,
      eventType: "return_inspection_completed",
      source: "inspection",
      sourceEntityType: "inspection",
      sourceEntityId: 501,
      createdAt: now,
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ eventKey: "inspection:501:completed" }));
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("returns an empty field list when there are no current rentals", async () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "leftJoin"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = (resolve: (value: unknown[]) => void) => Promise.resolve([]).then(resolve);
    const select = vi.fn(() => chain);

    await expect(loadFieldRentalAssetProgress({ select } as never, 9, facts().policies))
      .resolves.toEqual([]);
  });

  it("narrows field progress to exact driver assignments only while dispatch is enabled", () => {
    const progress = [
      resolveRentalAssetProgress(facts({ rentalRequestId: 10, rentalFleetId: 101 })),
      resolveRentalAssetProgress(facts({ rentalRequestId: 10, rentalFleetId: 102 })),
      resolveRentalAssetProgress(facts({ rentalRequestId: 11, rentalFleetId: 103 })),
    ];
    const assignments = [{ rentalRequestId: 10, rentalFleetId: 102 }];

    expect(filterFieldProgressByDispatchAssignments(progress, assignments, false)).toEqual(progress);
    expect(filterFieldProgressByDispatchAssignments(progress, assignments, true))
      .toEqual([expect.objectContaining({ rentalRequestId: 10, rentalFleetId: 102 })]);
  });

  it("loads a chronological event timeline for one equipment unit", async () => {
    const rows = [
      { id: 1, eventType: "return_started", createdAt: new Date("2026-07-15T12:00:00.000Z") },
      { id: 2, eventType: "return_inspection_completed", createdAt: new Date("2026-07-15T12:05:00.000Z") },
    ];
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "leftJoin"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = (resolve: (value: unknown[]) => void) => Promise.resolve(rows).then(resolve);
    const select = vi.fn(() => chain);

    await expect(listAssetProgressEvents({ select } as never, 10, 101)).resolves.toEqual(rows);
    expect(chain.orderBy).toHaveBeenCalledTimes(1);
  });
});
