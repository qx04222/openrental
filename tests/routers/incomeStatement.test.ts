/**
 * reports.incomeStatement — P&L aggregation + prior-period comparison.
 *
 * Drives the procedure through the tRPC caller with a mocked db whose
 * db.execute() returns queued rows, so we can assert:
 *  1. Total Revenue = sum of the five revenue streams (not tax/deposit).
 *  2. tax / deposit / billed map straight through.
 *  3. No date window → no prior period (single query, prior === null).
 *  4. start+end window → an equal-length PRIOR window is queried just before it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockDb, executeQueue } = vi.hoisted(() => {
  const executeQueue: { value: Record<string, unknown>[][] } = { value: [] };
  const mockDb = {
    select: vi.fn(),
    execute: vi.fn().mockImplementation(() => {
      if (executeQueue.value.length > 0) return Promise.resolve(executeQueue.value.shift()!);
      return Promise.resolve([]);
    }),
  };
  return { mockGetDb: vi.fn().mockResolvedValue(mockDb), mockDb, executeQueue };
});

vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn(() => "eq"), and: vi.fn(() => "and"), gte: vi.fn(() => "gte"),
  lte: vi.fn(() => "lte"), isNull: vi.fn(() => "isNull"),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _tag: "sql", strings, values }),
    { raw: (s: string) => ({ _tag: "sql-raw", s }) },
  ),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
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

import { reportsRouter } from "../../server/routers/reports.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(reportsRouter);

function makeCtx(): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 1, email: "admin@test.com", name: "Admin", username: "admin",
      role: "super_admin", isActive: true, passwordHash: null, phone: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      lastSignedIn: null, loginMethod: null,
    },
  };
}

const row = (over: Partial<Record<string, number>> = {}) => [{
  rentalFee: 1000, insuranceCost: 150, freightCost: 285, overtimeCost: 50, lateFee: 25,
  taxAmount: 200, depositAmount: 500, billedTotal: 1635, orderCount: 7, ...over,
}];

function nthSql(n: number): string {
  const arg = mockDb.execute.mock.calls[n]?.[0] as { s?: string };
  return arg?.s ?? "";
}

describe("reports.incomeStatement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueue.value = [];
  });

  it("sums billed revenue streams into totalRevenue (late fee/tax/deposit excluded)", async () => {
    executeQueue.value = [row()];
    const caller = createCaller(makeCtx());
    const res = await caller.incomeStatement(undefined);
    // estimatedLateFee is an unbilled accrual estimate → excluded from Total Revenue.
    expect(res?.current.totalRevenue).toBe(1000 + 150 + 285 + 50); // 1485
    expect(res?.current.lateFee).toBe(25); // surfaced separately as a memo line
    expect(res?.current.taxAmount).toBe(200);
    expect(res?.current.depositAmount).toBe(500);
    expect(res?.current.billedTotal).toBe(1635);
    expect(res?.current.orderCount).toBe(7);
  });

  it("returns no prior period when no date window is supplied", async () => {
    executeQueue.value = [row()];
    const caller = createCaller(makeCtx());
    const res = await caller.incomeStatement(undefined);
    expect(res?.prior).toBeNull();
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
  });

  it("queries an equal-length prior window immediately before the current one", async () => {
    executeQueue.value = [row(), row({ rentalFee: 800 })];
    const caller = createCaller(makeCtx());
    // 31-day window: Jan 2026.
    const res = await caller.incomeStatement({ startDate: "2026-02-01", endDate: "2026-03-01" });
    expect(mockDb.execute).toHaveBeenCalledTimes(2);
    expect(res?.prior).not.toBeNull();
    expect(res?.prior?.rentalFee).toBe(800);

    // Current query carries the supplied bounds; prior query carries the window
    // immediately before 2026-02-01 of identical length (ends 1ms earlier).
    expect(nthSql(0)).toContain("'2026-02-01T00:00:00.000Z'::timestamp");

    // Mirror the implementation's arithmetic so the expectation can't drift.
    const s = new Date("2026-02-01").getTime();
    const e = new Date("2026-03-01").getTime();
    const len = e - s;
    const priorEnd = new Date(s - 1).toISOString();
    const priorStart = new Date(s - 1 - len).toISOString();
    const priorSql = nthSql(1);
    expect(priorSql).toContain(`'${priorEnd}'::timestamp`);
    expect(priorSql).toContain(`'${priorStart}'::timestamp`);
  });
});
