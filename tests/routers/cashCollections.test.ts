/**
 * reports.cashCollections — cash-basis collections on the prepayment ledger.
 *
 * Four queued queries: billed, collected, by-method, by-month. Asserts the
 * derived figures (outstanding, collection rate), method mapping, and that the
 * collected side reads rental_prepayments by payment date.
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

function allSql(): string {
  return mockDb.execute.mock.calls.map((c) => (c[0] as { s?: string })?.s ?? "").join("\n");
}

describe("reports.cashCollections", () => {
  beforeEach(() => { vi.clearAllMocks(); executeQueue.value = []; });

  it("derives outstanding and collection rate, maps methods", async () => {
    executeQueue.value = [
      [{ billed: "1000" }],
      [{ collected: "600", n: 3 }],
      [{ method: "cash", amount: "400", count: 2 }, { method: "etransfer", amount: "200", count: 1 }],
      [{ month: "2026-06", collected: "600" }],
    ];
    const res = await createCaller(makeCtx()).cashCollections(undefined);
    expect(res?.billed).toBe(1000);
    expect(res?.collected).toBe(600);
    expect(res?.outstanding).toBe(400);
    expect(res?.collectionRate).toBe(60);
    expect(res?.paymentCount).toBe(3);
    expect(res?.byMethod[0]).toEqual({ method: "cash", amount: 400, count: 2 });
    expect(res?.byMonth).toEqual([{ month: "2026-06", collected: 600 }]);
  });

  it("floors outstanding at zero when over-collected", async () => {
    executeQueue.value = [[{ billed: "100" }], [{ collected: "150", n: 1 }], [], []];
    const res = await createCaller(makeCtx()).cashCollections(undefined);
    expect(res?.outstanding).toBe(0);
  });

  it("reads the prepayment ledger by payment date", async () => {
    executeQueue.value = [[{ billed: "0" }], [{ collected: "0", n: 0 }], [], []];
    await createCaller(makeCtx()).cashCollections(undefined);
    const s = allSql();
    expect(s).toContain("rental_prepayments");
    expect(s).toContain('"paymentDate"');
  });
});
