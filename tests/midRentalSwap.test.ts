/**
 * rentals.midRentalSwap — unit tests (mock db).
 * Covers: guards (flag / credit / status / unit-membership / availability /
 * claim race) and the happy-path side effects (pointer + line-item sync,
 * fleet status flips, charge, work order, dispatch retire + create, audit).
 * The full DB behavior is exercised by the local E2E run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted db mock ─────────────────────────────────────────────────────
const { mockGetDb, state } = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    selectQueue: [] as Row[][],
    returningQueue: [] as Row[][],
    updates: [] as { table: unknown; values: Row }[],
    inserts: [] as { table: unknown; values: Row }[],
  };

  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin"]) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (rows: Row[]) => void) => resolve(state.selectQueue.shift() ?? []);
    return chain;
  };

  const popReturning = () => state.returningQueue.shift() ?? [{}];

  const makeWriter = () => ({
    select: () => makeSelectChain(),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => ({
          returning: async () => {
            state.updates.push({ table, values });
            return popReturning();
          },
          then: (resolve: () => void) => {
            state.updates.push({ table, values });
            resolve();
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => ({
        returning: async () => {
          state.inserts.push({ table, values });
          return popReturning();
        },
        then: (resolve: () => void) => {
          state.inserts.push({ table, values });
          resolve();
        },
      }),
    }),
    execute: async () => [] as Row[],
  });

  const mockDb = {
    ...makeWriter(),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(makeWriter()),
  };

  return { mockGetDb: vi.fn().mockResolvedValue(mockDb), state };
});

vi.mock("../server/db", () => {
  const token = (..._a: unknown[]) => "cond";
  return {
    getDb: mockGetDb,
    closePool: vi.fn(),
    eq: token, ne: token, and: token, or: token, gte: token, lte: token,
    lt: token, gt: token, desc: token, asc: token, like: token, ilike: token,
    isNull: token, isNotNull: token, inArray: token, sql: token,
  };
});

const isFeatureEnabledMock = vi.fn(async () => true);
vi.mock("../server/services/featureFlags", () => ({
  isFeatureEnabled: (key: string) => isFeatureEnabledMock(key),
}));

const availabilityMock = vi.fn(async () => ({ isAvailable: true, conflicts: [] }));
vi.mock("../server/services/rentalStatusSync", () => ({
  checkDateRangeAvailability: (...args: unknown[]) => availabilityMock(...(args as [])),
  assignFleetAssetToRental: vi.fn(),
  releaseFleetAsset: vi.fn(),
  lineItemOverlapWhere: vi.fn(),
}));

const logAuditMock = vi.fn(async () => undefined);
vi.mock("../server/services/auditLog", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...(a as [])) }));

vi.mock("../server/services/creditWarning", () => ({
  computeCreditWarning: vi.fn(async () => null),
  computeCreditExposure: vi.fn(async () => 0),
}));

vi.mock("../server/services/workOrderNumber", () => ({
  getNextWorkOrderNumber: vi.fn(async () => "WO-2026-0042"),
}));

import { rentalRequestsRouter } from "../server/routers/rentalRequests.router";
import { t } from "../server/_core/trpc";
import type { TrpcContext } from "../server/_core/context";
import * as schema from "../drizzle/schema";

const createCaller = t.createCallerFactory(rentalRequestsRouter);

function adminCtx(): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 1, email: "admin@test.com", name: "Admin", username: "admin",
      role: "super_admin" as const, isActive: true, passwordHash: null,
      phone: null, createdAt: new Date(), updatedAt: new Date(),
      deletedAt: null, lastSignedIn: null, loginMethod: null,
    },
  };
}

const baseRental = {
  id: 500,
  rentalNumber: "20260703AB",
  status: "active",
  isCreditOrder: false,
  creditFinalizedAt: null,
  rentalFleetId: 10,
  equipmentModelId: 3,
  customerId: 42,
  deliveryAddress: "123 Main St",
  startDate: new Date("2026-06-20"),
  endDate: new Date("2026-07-20"),
  contractGenerated: false,
  contractUrl: null,
};

const oldFleet = { id: 10, assetNumber: "MB-010", brand: "SANY", model: "SY50", equipmentModelId: 3, currentStatus: "rented" };
const newFleet = { id: 20, assetNumber: "MB-020", brand: "SANY", model: "SY50", equipmentModelId: 3, currentStatus: "available" };

const happyInput = {
  rentalRequestId: 500,
  oldRentalFleetId: 10,
  newRentalFleetId: 20,
  reasonType: "equipment_fault" as const,
  reason: "hydraulic pump failure",
  chargeAmount: "150.00",
  chargeDescription: "call-out fee",
  createWorkOrder: true,
  createDispatch: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  isFeatureEnabledMock.mockResolvedValue(true);
  availabilityMock.mockResolvedValue({ isAvailable: true, conflicts: [] });
  state.selectQueue = [];
  state.returningQueue = [];
  state.updates = [];
  state.inserts = [];
});

/** Standard select queue: rental, old line item probe, old fleet, new fleet. */
function queueHappySelects(overrides: { rental?: object; oldLine?: object[]; old?: object; nw?: object } = {}) {
  state.selectQueue.push(
    [{ ...baseRental, ...(overrides.rental ?? {}) }],
    overrides.oldLine ?? [],
    [{ ...oldFleet, ...(overrides.old ?? {}) }],
    [{ ...newFleet, ...(overrides.nw ?? {}) }],
  );
}

describe("rentals.midRentalSwap", () => {
  it("performs the full swap with charge, work order and dispatch", async () => {
    queueHappySelects();
    state.returningQueue = [
      [{ ...baseRental, rentalFleetId: 20 }], // parent pointer update
      [{ id: 20 }],                            // optimistic claim of new unit
      [{ id: 77 }],                            // damage claim insert
      [{ id: 88 }],                            // work order insert
      [{ id: 601 }],                           // pickup dispatch
      [{ id: 602 }],                           // delivery dispatch
    ];

    const caller = createCaller(adminCtx());
    const res = await caller.midRentalSwap(happyInput);

    expect(res.damageClaimId).toBe(77);
    expect(res.workOrderId).toBe(88);
    expect(res.workOrderNumber).toBe("WO-2026-0042");
    expect(res.dispatchCreated).toBe(2);

    // Parent pointer re-pointed to the new unit.
    const rentalUpdate = state.updates.find((u) => u.table === schema.rentalRequests);
    expect(rentalUpdate?.values).toMatchObject({ rentalFleetId: 20, equipmentModelId: 3 });

    // Line-item mirror synced.
    const lineUpdate = state.updates.find((u) => u.table === schema.rentalLineItems);
    expect(lineUpdate?.values).toMatchObject({ rentalFleetId: 20 });

    // New unit claimed, old unit parked in maintenance.
    const fleetUpdates = state.updates.filter((u) => u.table === schema.rentalFleet);
    expect(fleetUpdates.some((u) => u.values.currentStatus === "rented")).toBe(true);
    expect(fleetUpdates.some((u) => u.values.currentStatus === "maintenance")).toBe(true);

    // Charge is an accepted simple charge with type "swap".
    const claim = state.inserts.find((i) => i.table === schema.damageClaims);
    expect(claim?.values).toMatchObject({ chargeType: "swap", amount: "150.00", approvedAmount: "150.00", status: "accepted", rentalId: 500 });

    // Repair work order on the OLD unit, linked to the claim.
    const wo = state.inserts.find((i) => i.table === schema.workOrders);
    expect(wo?.values).toMatchObject({ rentalFleetId: 10, damageClaimId: 77, type: "repair", status: "open" });

    // Stale dispatches voided, then pickup(old) + delivery(new) created.
    const dispatchVoid = state.updates.find((u) => u.table === schema.dispatchOrders);
    expect(dispatchVoid?.values).toMatchObject({ status: "cancelled" });
    const dispatchInserts = state.inserts.filter((i) => i.table === schema.dispatchOrders);
    expect(dispatchInserts.map((d) => [d.values.orderType, d.values.rentalFleetId])).toEqual([
      ["pickup", 10],
      ["delivery", 20],
    ]);

    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "mid_rental_swap", entityId: 500 }));
  });

  it("skips charge/work order/dispatch when not requested", async () => {
    queueHappySelects();
    state.returningQueue = [
      [{ ...baseRental, rentalFleetId: 20 }],
      [{ id: 20 }],
    ];

    const caller = createCaller(adminCtx());
    const res = await caller.midRentalSwap({
      ...happyInput,
      chargeAmount: undefined,
      createWorkOrder: false,
      createDispatch: false,
    });

    expect(res.damageClaimId).toBeNull();
    expect(res.workOrderId).toBeNull();
    expect(res.dispatchCreated).toBe(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("is rejected when the feature flag is off", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const caller = createCaller(adminCtx());
    await expect(caller.midRentalSwap(happyInput)).rejects.toThrow(/not enabled/);
  });

  it("rejects credit orders (they use bin exchange)", async () => {
    state.selectQueue.push([{ ...baseRental, isCreditOrder: true }]);
    const caller = createCaller(adminCtx());
    await expect(caller.midRentalSwap(happyInput)).rejects.toThrow(/bin exchange/);
  });

  it("rejects non-active orders", async () => {
    state.selectQueue.push([{ ...baseRental, status: "pending" }]);
    const caller = createCaller(adminCtx());
    await expect(caller.midRentalSwap(happyInput)).rejects.toThrow(/active\/overdue/);
  });

  it("rejects when the old unit is not part of the order", async () => {
    state.selectQueue.push(
      [{ ...baseRental, rentalFleetId: 999 }], // pointer differs
      [],                                       // and no line item matches
    );
    const caller = createCaller(adminCtx());
    await expect(caller.midRentalSwap(happyInput)).rejects.toThrow(/not part of this order/);
  });

  it("accepts a multi-item order where the old unit is a line item", async () => {
    queueHappySelects({ rental: { rentalFleetId: null }, oldLine: [{ id: 71 }] });
    state.returningQueue = [
      [{ id: 20 }], // claim (no parent-pointer update for multi-item orders)
    ];
    const caller = createCaller(adminCtx());
    const res = await caller.midRentalSwap({
      ...happyInput, chargeAmount: undefined, createWorkOrder: false, createDispatch: false,
    });
    expect(res.dispatchCreated).toBe(0);
    // Parent pointer untouched.
    expect(state.updates.find((u) => u.table === schema.rentalRequests)).toBeUndefined();
    // Line item still synced.
    expect(state.updates.find((u) => u.table === schema.rentalLineItems)?.values).toMatchObject({ rentalFleetId: 20 });
  });

  it("rejects when the replacement is not physically available", async () => {
    queueHappySelects({ nw: { currentStatus: "maintenance" } });
    const caller = createCaller(adminCtx());
    await expect(caller.midRentalSwap(happyInput)).rejects.toThrow(/not available/);
  });

  it("rejects when the replacement has conflicting bookings", async () => {
    availabilityMock.mockResolvedValue({ isAvailable: false, conflicts: [{ id: 1 }] });
    queueHappySelects();
    const caller = createCaller(adminCtx());
    await expect(caller.midRentalSwap(happyInput)).rejects.toThrow(/remaining rental period/);
  });

  it("rolls back with CONFLICT when the optimistic claim loses the race", async () => {
    queueHappySelects();
    state.returningQueue = [
      [{ ...baseRental, rentalFleetId: 20 }], // pointer update
      [],                                      // claim returns no rows → race lost
    ];
    const caller = createCaller(adminCtx());
    await expect(caller.midRentalSwap(happyInput)).rejects.toThrow(/claimed by another operation/);
  });
});
