/**
 * buildDateFilter SQL-injection hardening — exercised via reports.financialOverview
 *
 * buildDateFilter is not exported, so we drive it through a procedure that uses it
 * and inspect the raw SQL string handed to db.execute (captured by the sql.raw mock).
 *
 * Covers:
 *  1. Valid dates are interpolated as canonical ISO timestamps
 *  2. An injection payload never reaches the SQL verbatim (no breakout, no DROP)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockDb, executeQueue } = vi.hoisted(() => {
  const executeQueue: { value: Record<string, unknown>[][] } = { value: [] };

  const createSelectChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["from", "where", "orderBy", "limit", "leftJoin"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown[]) => void) => resolve([]);
    return chain;
  };

  const mockDb = {
    select: vi.fn().mockReturnValue(createSelectChain()),
    execute: vi.fn().mockImplementation(() => {
      if (executeQueue.value.length > 0) {
        return Promise.resolve(executeQueue.value.shift()!);
      }
      return Promise.resolve([]);
    }),
  };

  return { mockGetDb: vi.fn().mockResolvedValue(mockDb), mockDb, executeQueue };
});

vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn(() => "eq"),
  and: vi.fn(() => "and"),
  gte: vi.fn(() => "gte"),
  lte: vi.fn(() => "lte"),
  isNull: vi.fn(() => "isNull"),
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

/** Pull the raw SQL string handed to the first db.execute() call. */
function capturedSql(): string {
  const arg = mockDb.execute.mock.calls[0]?.[0] as { _tag?: string; s?: string };
  return arg?.s ?? "";
}

describe("buildDateFilter injection hardening (via financialOverview)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueue.value = [];
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

  it("interpolates valid dates as canonical ISO timestamps", async () => {
    const caller = createCaller(makeCtx());
    await caller.financialOverview({ startDate: "2026-01-01", endDate: "2026-01-31" });

    const sqlStr = capturedSql();
    expect(sqlStr).toContain("'2026-01-01T00:00:00.000Z'::timestamp");
    expect(sqlStr).toContain("'2026-01-31T00:00:00.000Z'::timestamp");
  });

  it("never lets an injection payload reach the SQL verbatim", async () => {
    const caller = createCaller(makeCtx());
    // ≤30 chars to clear the z.string().max(30) gate; tail is an injection attempt.
    await caller.financialOverview({ startDate: "2020-01-01';DROP TABLE x--" });

    const sqlStr = capturedSql();
    // Whether the input parses to a date (→ clean ISO) or to Invalid Date (→ no
    // filter at all), the malicious tail must never survive into the query.
    expect(sqlStr).not.toContain("DROP TABLE");
    expect(sqlStr).not.toContain("';");
  });
});

describe("buildFilters dimension slicers (via financialOverview)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueue.value = [];
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

  it("interpolates a validated customerId as an integer equality", async () => {
    const caller = createCaller(makeCtx());
    await caller.financialOverview({ customerId: 42 });
    expect(capturedSql()).toContain('rental_requests."customerId" = 42');
  });

  it("applies warehouse + category via an EXISTS against rental_fleet", async () => {
    const caller = createCaller(makeCtx());
    await caller.financialOverview({ locationId: 7, category: "Excavators" });
    const sqlStr = capturedSql();
    expect(sqlStr).toContain('EXISTS (SELECT 1 FROM rental_fleet f WHERE f.id = rental_requests."rentalFleetId"');
    expect(sqlStr).toContain('f."locationId" = 7');
    expect(sqlStr).toContain("f.category = 'Excavators'");
  });

  it("emits no dimension clause when none are supplied", async () => {
    const caller = createCaller(makeCtx());
    await caller.financialOverview({});
    const sqlStr = capturedSql();
    expect(sqlStr).not.toContain('"customerId" =');
    expect(sqlStr).not.toContain("EXISTS (SELECT 1 FROM rental_fleet");
  });

  it("rejects a category containing SQL metacharacters at the input layer", async () => {
    const caller = createCaller(makeCtx());
    await expect(caller.financialOverview({ category: "x'; DROP TABLE y--" })).rejects.toThrow();
  });

  it("rejects a non-integer customerId at the input layer", async () => {
    const caller = createCaller(makeCtx());
    await expect(caller.financialOverview({ customerId: 1.5 })).rejects.toThrow();
  });
});
