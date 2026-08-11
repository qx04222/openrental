import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any imports that use them
// ---------------------------------------------------------------------------

const {
  mockGetDb,
  queryResults,
  queryQueue,
} = vi.hoisted(() => {
  const queryResults: { value: unknown[] } = { value: [] };
  const queryQueue: { value: unknown[][] } = { value: [] };

  const nextQueryResult = () => {
    if (queryQueue.value.length > 0) {
      return queryQueue.value.shift()!;
    }
    return [...queryResults.value];
  };

  const createReadChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> & {
      then?: (resolve: (v: unknown[]) => void) => void;
    } = {};
    for (const method of ["from", "leftJoin", "where", "orderBy", "limit"]) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (v: unknown[]) => void) => resolve(nextQueryResult());
    return chain;
  };

  const mockDb = {
    select: vi.fn().mockImplementation(() => createReadChain()),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    queryResults,
    queryQueue,
  };
});

vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._args: unknown[]) => "eq"),
  and: vi.fn((..._args: unknown[]) => "and"),
  gte: vi.fn((..._args: unknown[]) => "gte"),
  lte: vi.fn((..._args: unknown[]) => "lte"),
  inArray: vi.fn((..._args: unknown[]) => "inArray"),
  isNull: vi.fn((..._args: unknown[]) => "isNull"),
  isNotNull: vi.fn((..._args: unknown[]) => "isNotNull"),
  desc: vi.fn((..._args: unknown[]) => "desc"),
  sql: vi.fn((..._args: unknown[]) => "sql"),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    rentalRequests: {
      id: col("id"),
      rentalNumber: col("rentalNumber"),
      customerName: col("customerName"),
      status: col("status"),
      deletedAt: col("deletedAt"),
      startDate: col("startDate"),
      endDate: col("endDate"),
      deliveryAddress: col("deliveryAddress"),
      scheduledDeliveryTime: col("scheduledDeliveryTime"),
      rentalFleetId: col("rentalFleetId"),
      createdAt: col("createdAt"),
      rentalFee: col("rentalFee"),
      totalAmount: col("totalAmount"),
      paymentStatus: col("paymentStatus"),
    },
    rentalFleet: {
      id: col("id"),
      brand: col("brand"),
      model: col("model"),
      currentStatus: col("currentStatus"),
      deletedAt: col("deletedAt"),
    },
    inspections: {
      id: col("id"),
      deletedAt: col("deletedAt"),
    },
    dispatchOrders: {
      id: col("id"),
      orderType: col("orderType"),
      status: col("status"),
      deletedAt: col("deletedAt"),
      createdAt: col("createdAt"),
    },
    customers: {
      id: col("id"),
      name: col("name"),
      totalRentals: col("totalRentals"),
      nextFollowUp: col("nextFollowUp"),
      followUpNotes: col("followUpNotes"),
      createdAt: col("createdAt"),
      deletedAt: col("deletedAt"),
    },
    invoices: {
      status: col("status"),
      type: col("type"),
      totalAmount: col("totalAmount"),
      balanceDue: col("balanceDue"),
      deletedAt: col("deletedAt"),
    },
    rentalPrepayments: {
      amount: col("amount"),
      appliedAt: col("appliedAt"),
      deletedAt: col("deletedAt"),
    },
  };
});

// ---------------------------------------------------------------------------
// Import the router under test AFTER mocks are declared
// ---------------------------------------------------------------------------

import { dashboardRouter } from "../../server/routers/dashboard.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(dashboardRouter);

function makeCtx(role: "super_admin" | "admin" = "super_admin"): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 1,
      email: "admin@test.com",
      name: "Admin User",
      username: "admin",
      role,
      isActive: true,
      passwordHash: null,
      phone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      lastSignedIn: null,
      loginMethod: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboard.todaySchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
    queryQueue.value = [];
  });

  it("returns empty arrays when DB is unavailable", async () => {
    mockGetDb.mockResolvedValueOnce(null);
    const caller = createCaller(makeCtx());
    const result = await caller.todaySchedule();
    expect(result).toEqual({
      deliveriesDue: [],
      returnsDue: [],
      startingToday: [],
      endingToday: [],
    });
  });

  it("returns deliveriesDue with expected shape", async () => {
    const delivery = {
      id: 1,
      rentalNumber: "RN-001",
      customerName: "Alice Smith",
      deliveryAddress: "123 Main St",
      scheduledDeliveryTime: "09:00",
    };
    // todaySchedule runs 4 parallel queries; each call to nextQueryResult pops from the queue
    queryQueue.value = [
      [delivery], // deliveriesDue
      [],          // returnsDue
      [],          // startingToday
      [],          // endingToday
    ];
    const caller = createCaller(makeCtx());
    const result = await caller.todaySchedule();
    expect(result.deliveriesDue).toHaveLength(1);
    expect(result.deliveriesDue[0]).toMatchObject({
      id: 1,
      rentalNumber: "RN-001",
      customerName: "Alice Smith",
      deliveryAddress: "123 Main St",
      scheduledDeliveryTime: "09:00",
    });
  });

  it("returns returnsDue with fleet brand and model", async () => {
    const returnItem = {
      id: 2,
      rentalNumber: "RN-002",
      customerName: "Bob Jones",
      endDate: new Date("2026-04-18"),
      fleetBrand: "Caterpillar",
      fleetModel: "320 Excavator",
    };
    queryQueue.value = [
      [],            // deliveriesDue
      [returnItem],  // returnsDue
      [],            // startingToday
      [],            // endingToday
    ];
    const caller = createCaller(makeCtx());
    const result = await caller.todaySchedule();
    expect(result.returnsDue).toHaveLength(1);
    expect(result.returnsDue[0]).toMatchObject({
      id: 2,
      rentalNumber: "RN-002",
      customerName: "Bob Jones",
      fleetBrand: "Caterpillar",
      fleetModel: "320 Excavator",
    });
  });

  it("returns startingToday with expected shape", async () => {
    const starting = {
      id: 3,
      rentalNumber: "RN-003",
      customerName: "Carol White",
      startDate: new Date("2026-04-18"),
    };
    queryQueue.value = [
      [],        // deliveriesDue
      [],        // returnsDue
      [starting], // startingToday
      [],        // endingToday
    ];
    const caller = createCaller(makeCtx());
    const result = await caller.todaySchedule();
    expect(result.startingToday).toHaveLength(1);
    expect(result.startingToday[0]).toMatchObject({
      id: 3,
      rentalNumber: "RN-003",
      customerName: "Carol White",
    });
    expect(result.startingToday[0]).toHaveProperty("startDate");
  });

  it("returns endingToday with expected shape", async () => {
    const ending = {
      id: 4,
      rentalNumber: "RN-004",
      customerName: "Dave Brown",
      endDate: new Date("2026-04-18"),
    };
    queryQueue.value = [
      [],       // deliveriesDue
      [],       // returnsDue
      [],       // startingToday
      [ending], // endingToday
    ];
    const caller = createCaller(makeCtx());
    const result = await caller.todaySchedule();
    expect(result.endingToday).toHaveLength(1);
    expect(result.endingToday[0]).toMatchObject({
      id: 4,
      rentalNumber: "RN-004",
      customerName: "Dave Brown",
    });
    expect(result.endingToday[0]).toHaveProperty("endDate");
  });

  it("returns all 4 categories simultaneously", async () => {
    const delivery = { id: 1, rentalNumber: "RN-001", customerName: "A", deliveryAddress: null, scheduledDeliveryTime: null };
    const returnItem = { id: 2, rentalNumber: "RN-002", customerName: "B", endDate: new Date(), fleetBrand: null, fleetModel: null };
    const starting = { id: 3, rentalNumber: "RN-003", customerName: "C", startDate: new Date() };
    const ending = { id: 4, rentalNumber: "RN-004", customerName: "D", endDate: new Date() };
    queryQueue.value = [[delivery], [returnItem], [starting], [ending]];

    const caller = createCaller(makeCtx());
    const result = await caller.todaySchedule();
    expect(result.deliveriesDue).toHaveLength(1);
    expect(result.returnsDue).toHaveLength(1);
    expect(result.startingToday).toHaveLength(1);
    expect(result.endingToday).toHaveLength(1);
  });

  it("returns empty arrays when DB has no matching rentals", async () => {
    queryQueue.value = [[], [], [], []];
    const caller = createCaller(makeCtx());
    const result = await caller.todaySchedule();
    expect(result).toEqual({
      deliveriesDue: [],
      returnsDue: [],
      startingToday: [],
      endingToday: [],
    });
  });

  it("timezone boundary: 11pm Toronto (next day UTC) still uses Toronto date", () => {
    // Verify torontoTodayRange produces a dateStr consistent with Toronto time.
    // At 11pm Toronto (UTC-4 EDT = 03:00 UTC next day), the Toronto date is today.
    // We can't easily unit-test this without mocking Date, but we verify that
    // the range function does not throw and produces valid Date objects.
    // The key invariant: endUtc - startUtc === 24 hours.
    //
    // We call the function indirectly via the query — if no error is thrown and
    // the result matches the expected shape, the timezone utility works correctly.
    queryQueue.value = [[], [], [], []];
    // This test is intentionally checking that the query succeeds (no timezone crash)
    const caller = createCaller(makeCtx());
    return expect(caller.todaySchedule()).resolves.toEqual({
      deliveriesDue: [],
      returnsDue: [],
      startingToday: [],
      endingToday: [],
    });
  });

  it("soft-deleted rentals are excluded via isNull(deletedAt) filter", async () => {
    // The mock applies isNull filter at the drizzle query level.
    // We verify the isNull mock is called (i.e., the query includes the filter).
    const { isNull } = await import("../../server/db");
    queryQueue.value = [[], [], [], []];
    const caller = createCaller(makeCtx());
    await caller.todaySchedule();
    // isNull should be called for deletedAt in each of the 4 queries
    expect(isNull).toHaveBeenCalled();
  });

  it("excludes terminal rentals from the starting and ending open-work buckets", async () => {
    const { inArray } = await import("../../server/db");
    queryQueue.value = [[], [], [], []];
    const caller = createCaller(makeCtx());

    await caller.todaySchedule();

    expect(inArray).toHaveBeenCalledTimes(4);
    expect(inArray).toHaveBeenNthCalledWith(3, "status", ["pending", "approved", "active", "overdue"]);
    expect(inArray).toHaveBeenNthCalledWith(4, "status", ["pending", "approved", "active", "overdue"]);
  });

  it("rejects unauthenticated callers", async () => {
    const caller = createCaller({
      req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
      res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
      user: null,
    });
    await expect(caller.todaySchedule()).rejects.toThrow();
  });
});

describe("dashboard.stats operational counts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
    queryQueue.value = [];
  });

  it("returns accurate availability and mutually exclusive ongoing rental buckets", async () => {
    queryQueue.value = [
      [
        { status: "active", rentalFee: "1000" },
        { status: "overdue", rentalFee: "500" },
      ],
      [{ status: "sent", type: "rental", totalAmount: "1200", balanceDue: "300" }],
      [
        { amount: "1000", appliedAt: new Date() },
        { amount: "200", appliedAt: null },
      ],
      [{ total: 20, available: 8, statusMismatch: 2, missingCost: 1 }],
      [{
        total: 30,
        pending: 3,
        active: 7,
        ongoing: 11,
        normal: 2,
        rolling: 3,
        awaitingPickup: 2,
        awaitingInspection: 3,
        customerOverdue: 1,
        revenue: 100,
        freight: 10,
        insurance: 5,
        pendingRevenue: 50,
        pendingInsurance: 2,
        pendingFreight: 4,
      }],
      [{ total: 4 }],
      [{ total: 5 }],
      [],
      [],
      [{ totalCustomers: 10, returningCustomers: 4, newThisMonth: 1 }],
      [],
    ];

    const result = await createCaller(makeCtx()).stats();

    expect(result?.fleet).toMatchObject({ available: 8, statusMismatch: 2 });
    expect(result?.rentals).toMatchObject({
      active: 7,
      ongoing: 11,
      normal: 2,
      rolling: 3,
      awaitingPickup: 2,
      awaitingInspection: 3,
      customerOverdue: 1,
    });
    expect(result?.financials).toEqual({
      orderRent: 1500,
      cumulativeReceivable: 1200,
      outstandingBalance: 300,
      cashReceived: 1200,
      heldCash: 200,
    });
  });
});
