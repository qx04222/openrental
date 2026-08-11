/**
 * reports.utilizationByFleet — unit tests
 *
 * Covers:
 *  1. Date range defaults to last 30 days
 *  2. warehouseId filter is forwarded to the SQL query
 *  3. Rented days calculated from rental that spans the full window
 *  4. Soft-deleted rentals are excluded (deletedAt IS NOT NULL rows returned)
 *  5. Empty dataset returns zero-value summary
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const { mockGetDb, mockDb, executeQueue } = vi.hoisted(() => {
  /**
   * Queue of result batches. Each call to db.execute() pops the next entry.
   * If the queue is empty, execute() resolves with [].
   */
  const executeQueue: { value: Record<string, unknown>[][] } = { value: [] };

  // Reusable ORM-chain mock for db.select().from().where() used by moduleGuard
  const createSelectChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["from", "where", "orderBy", "limit", "leftJoin"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown[]) => void) => resolve([]);
    return chain;
  };

  const selectChain = createSelectChain();

  const mockDb = {
    select: vi.fn().mockReturnValue(selectChain),
    execute: vi.fn().mockImplementation(() => {
      if (executeQueue.value.length > 0) {
        return Promise.resolve(executeQueue.value.shift()!);
      }
      return Promise.resolve([]);
    }),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    mockDb,
    executeQueue,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  and: vi.fn((..._a: unknown[]) => "and"),
  gte: vi.fn((..._a: unknown[]) => "gte"),
  lte: vi.fn((..._a: unknown[]) => "lte"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      _tag: "sql",
      strings,
      values,
    }),
    {
      raw: (s: string) => ({ _tag: "sql-raw", s }),
    },
  ),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    rentalFleet: {
      id: col("id"), brand: col("brand"), model: col("model"),
      assetNumber: col("assetNumber"), locationId: col("locationId"),
      deletedAt: col("deletedAt"),
    },
    warehouses: {
      id: col("id"), name: col("name"), deletedAt: col("deletedAt"),
    },
    rentalRequests: {
      id: col("id"), rentalFleetId: col("rentalFleetId"),
      startDate: col("startDate"), endDate: col("endDate"),
      status: col("status"), deletedAt: col("deletedAt"),
    },
    downtimeRecords: {
      id: col("id"), rentalFleetId: col("rentalFleetId"),
      reportedAt: col("reportedAt"), resolvedAt: col("resolvedAt"),
    },
    rolePermissions: {
      id: col("id"), role: col("role"), module: col("module"),
      canCreate: col("canCreate"), canRead: col("canRead"),
      canUpdate: col("canUpdate"), canDelete: col("canDelete"),
      createdAt: col("createdAt"), updatedAt: col("updatedAt"),
    },
    userPermissionOverrides: {
      id: col("id"), userId: col("userId"), module: col("module"),
      canCreate: col("canCreate"), canRead: col("canRead"),
      canUpdate: col("canUpdate"), canDelete: col("canDelete"),
      createdAt: col("createdAt"),
    },
  };
});

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { reportsRouter } from "../../server/routers/reports.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(reportsRouter);

function makeCtx(role: "super_admin" | "admin" = "super_admin"): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 1,
      email: "admin@test.com",
      name: "Admin",
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Push rented-row batch, then the multi-item line-item batch (empty by
 * default), then maintenance-row batch into the queue. The line-item query was
 * added so multi-item orders (parent rentalFleetId null) count toward
 * utilization; tests that don't exercise it just leave it empty.
 */
function setExecuteResults(
  rentedRows: Record<string, unknown>[],
  maintenanceRows: Record<string, unknown>[],
  lineItemRows: Record<string, unknown>[] = [],
) {
  executeQueue.value = [rentedRows, lineItemRows, maintenanceRows];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("reports.utilizationByFleet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueue.value = [];
    // Re-setup select chain after clearAllMocks
    const createSelectChain = () => {
      const chain: Record<string, ReturnType<typeof vi.fn>> = {};
      for (const m of ["from", "where", "orderBy", "limit", "leftJoin"]) {
        chain[m] = vi.fn().mockReturnValue(chain);
      }
      (chain as { then: unknown }).then = (resolve: (v: unknown[]) => void) => resolve([]);
      return chain;
    };
    mockDb.select.mockReturnValue(createSelectChain());
  });

  it("empty dataset returns zero-value summary", async () => {
    setExecuteResults([], []);
    const caller = createCaller(makeCtx());
    const result = await caller.utilizationByFleet(undefined);

    expect(result.assets).toHaveLength(0);
    expect(result.averageUtilizationPct).toBe(0);
    expect(result.topIdle).toHaveLength(0);
    expect(result.topMaintenance).toHaveLength(0);
  });

  it("calculates rented days from a rental spanning the full window", async () => {
    // Simulate an asset that was rented for the entire 30-day default window.
    // The SQL does the overlap calc in DB — here we return the already-calculated
    // rentedDays value (30) from the mocked execute call.
    setExecuteResults(
      [
        {
          fleetId: 1,
          assetNumber: "A001",
          brand: "Caterpillar",
          model: "313",
          warehouseName: "Main",
          rentedDays: "30",
        },
      ],
      [], // no downtime
    );

    const caller = createCaller(makeCtx());
    const result = await caller.utilizationByFleet(undefined);

    expect(result.assets).toHaveLength(1);
    const asset = result.assets[0];
    expect(asset.rentedDays).toBe(30);
    expect(asset.maintenanceDays).toBe(0);
    expect(asset.idleDays).toBe(0);
    // totalDays defaults to 30
    expect(asset.totalDays).toBe(30);
    expect(asset.utilizationPct).toBe(100);
  });

  it("date range defaults: db.execute called for rentedRows + maintenanceRows + exclusions", async () => {
    setExecuteResults([], []);
    const before = Date.now();
    const caller = createCaller(makeCtx());
    await caller.utilizationByFleet(undefined);
    const after = Date.now();

    // rentedRows + maintenanceRows + the rental_settings exclusions read
    expect(mockDb.execute).toHaveBeenCalledTimes(4);

    // Validate that windowEnd embedded in the sql call is within a few seconds of now.
    const firstCallArgs = mockDb.execute.mock.calls[0];
    const sqlObj = firstCallArgs[0] as { values: unknown[] };
    if (Array.isArray(sqlObj.values)) {
      const windowEnd = sqlObj.values[0] as Date | undefined;
      if (windowEnd instanceof Date) {
        expect(windowEnd.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(windowEnd.getTime()).toBeLessThanOrEqual(after + 1000);
      }
    }
  });

  it("warehouseId filter: db.execute called with sql containing warehouseId", async () => {
    setExecuteResults([], []);
    const caller = createCaller(makeCtx());
    await caller.utilizationByFleet({ warehouseId: 5 });

    // rentedRows + maintenanceRows + exclusions read
    expect(mockDb.execute).toHaveBeenCalledTimes(4);

    // Recursively search for warehouseId value (5) in nested sql objects
    function containsValue(obj: unknown, target: unknown): boolean {
      if (obj === target) return true;
      if (obj && typeof obj === "object") {
        for (const v of Object.values(obj as Record<string, unknown>)) {
          if (Array.isArray(v)) {
            if (v.some((item) => containsValue(item, target))) return true;
          } else if (containsValue(v, target)) {
            return true;
          }
        }
      }
      return false;
    }

    const firstCallSql = mockDb.execute.mock.calls[0][0];
    expect(containsValue(firstCallSql, 5)).toBe(true);
  });

  it("computes averageUtilizationPct across multiple assets", async () => {
    setExecuteResults(
      [
        { fleetId: 1, assetNumber: "A001", brand: "Cat", model: "313", warehouseName: "Main", rentedDays: "20" },
        { fleetId: 2, assetNumber: "A002", brand: "JD", model: "35G", warehouseName: "Main", rentedDays: "10" },
      ],
      [],
    );

    const caller = createCaller(makeCtx());
    const result = await caller.utilizationByFleet({ startDate: "2026-01-01", endDate: "2026-01-31" });

    // totalDays = 30 (Jan 1 → Jan 31)
    // asset1 util = 20/30 * 100 ≈ 66.7%
    // asset2 util = 10/30 * 100 ≈ 33.3%
    // average ≈ 50%
    expect(result.averageUtilizationPct).toBeCloseTo(50, 0);
    expect(result.assets).toHaveLength(2);
  });

  it("soft-deleted rentals excluded: only SQL-returned rows appear in output", async () => {
    // The soft-delete filter is applied inside the SQL (AND rr."deletedAt" IS NULL).
    // We verify that our JS layer doesn't add extra rows; execute runs three times
    // (rentedRows + maintenanceRows + exclusions read).
    setExecuteResults(
      [
        { fleetId: 3, assetNumber: "A003", brand: "Volvo", model: "ECR25", warehouseName: null, rentedDays: "0" },
      ],
      [],
    );

    const caller = createCaller(makeCtx());
    const result = await caller.utilizationByFleet(undefined);

    expect(mockDb.execute).toHaveBeenCalledTimes(4);
    // The returned asset has 0 rented days (soft-deleted rentals not returned by SQL)
    expect(result.assets[0].rentedDays).toBe(0);
    expect(result.assets[0].utilizationPct).toBe(0);
  });

  it("topIdle lists assets with highest idle days first", async () => {
    setExecuteResults(
      [
        { fleetId: 1, assetNumber: "A001", brand: "Cat", model: "313", warehouseName: null, rentedDays: "5" },
        { fleetId: 2, assetNumber: "A002", brand: "JD", model: "35G", warehouseName: null, rentedDays: "25" },
      ],
      [],
    );

    const caller = createCaller(makeCtx());
    const result = await caller.utilizationByFleet(undefined);

    // A001: idle = 30 - 5 = 25, A002: idle = 30 - 25 = 5
    expect(result.topIdle[0].fleetId).toBe(1);
    expect(result.topIdle[0].idleDays).toBe(25);
  });

  it("rejects an invalid date string with BAD_REQUEST (not a 500)", async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.utilizationByFleet({ startDate: "not-a-date" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Validation fails before the resolver body — no DB query should run.
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("maintenance days reduce idle days correctly", async () => {
    setExecuteResults(
      [
        { fleetId: 1, assetNumber: "A001", brand: "Cat", model: "313", warehouseName: null, rentedDays: "10" },
      ],
      [
        { fleetId: 1, maintenanceDays: "5" },
      ],
    );

    const caller = createCaller(makeCtx());
    const result = await caller.utilizationByFleet(undefined);

    const asset = result.assets[0];
    expect(asset.rentedDays).toBe(10);
    expect(asset.maintenanceDays).toBe(5);
    // idleDays = totalDays(30) - rentedDays(10) - maintenanceDays(5) = 15
    expect(asset.idleDays).toBe(15);
  });

  it("excluded fleet ids are dropped from the stats and the average", async () => {
    executeQueue.value = [
      [
        { fleetId: 1, assetNumber: "A001", brand: "Cat", model: "313", warehouseName: null, rentedDays: "30" },
        { fleetId: 2, assetNumber: "A002", brand: "JD", model: "35G", warehouseName: null, rentedDays: "0" },
      ],
      [], // line-item occupancy
      [], // maintenance
      [{ value: "[2]" }], // rental_settings: exclude fleet 2
    ];

    const caller = createCaller(makeCtx());
    const result = await caller.utilizationByFleet(undefined);

    expect(result.excludedFleetIds).toEqual([2]);
    // Default view returns only the counted (non-excluded) assets
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].fleetId).toBe(1);
    // Average is over non-excluded only → 100%, not (100+0)/2 = 50%
    expect(result.averageUtilizationPct).toBe(100);
  });

  it("maintenance assets are excluded from the average and flagged", async () => {
    executeQueue.value = [
      [
        { fleetId: 1, assetNumber: "A001", brand: "Cat", model: "313", currentStatus: "rented", warehouseName: null, rentedDays: "30" },
        { fleetId: 2, assetNumber: "A002", brand: "JD", model: "35G", currentStatus: "maintenance", warehouseName: null, rentedDays: "0" },
      ],
      [], // line-item occupancy
      [], // maintenance
      [], // no manual exclusions
    ];

    const caller = createCaller(makeCtx());
    // includeExcluded returns all assets (flagged) but the average still drops maintenance.
    const result = await caller.utilizationByFleet({ includeExcluded: true });

    expect(result.assets).toHaveLength(2);
    expect(result.assets.find((a) => a.fleetId === 2)?.inMaintenance).toBe(true);
    expect(result.assets.find((a) => a.fleetId === 1)?.inMaintenance).toBe(false);
    // Average over non-maintenance only → 100%, not (100+0)/2 = 50%
    expect(result.averageUtilizationPct).toBe(100);
  });

  it("includeExcluded returns every asset flagged with `excluded`", async () => {
    executeQueue.value = [
      [
        { fleetId: 1, assetNumber: "A001", brand: "Cat", model: "313", warehouseName: null, rentedDays: "30" },
        { fleetId: 2, assetNumber: "A002", brand: "JD", model: "35G", warehouseName: null, rentedDays: "0" },
      ],
      [], // line-item occupancy
      [], // maintenance
      [{ value: "[2]" }],
    ];

    const caller = createCaller(makeCtx());
    const result = await caller.utilizationByFleet({ includeExcluded: true });

    expect(result.assets).toHaveLength(2);
    expect(result.assets.find((a) => a.fleetId === 2)?.excluded).toBe(true);
    expect(result.assets.find((a) => a.fleetId === 1)?.excluded).toBe(false);
    // Average still excludes the flagged asset
    expect(result.averageUtilizationPct).toBe(100);
  });
});
