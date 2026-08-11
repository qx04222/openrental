/**
 * Phase 3 — depositLiability + AR truth-up (arAging / accountsReceivable).
 *
 * Asserts:
 *  1. depositLiability sums held deposits and only looks at active rentals.
 *  2. arAging is built on rental_requests + rental_prepayments (NOT invoices).
 *  3. accountsReceivable nets prepayments into `owing`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, mockDb, executeQueue, getPoliciesMock } = vi.hoisted(() => {
  const executeQueue: { value: Record<string, unknown>[][] } = { value: [] };
  const mockDb = {
    select: vi.fn(),
    execute: vi.fn().mockImplementation(() => {
      if (executeQueue.value.length > 0) return Promise.resolve(executeQueue.value.shift()!);
      return Promise.resolve([]);
    }),
  };
  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    mockDb,
    executeQueue,
    getPoliciesMock: vi.fn(),
  };
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

vi.mock("../../server/services/rentalOperationPolicies", () => ({
  getRentalOperationPolicies: getPoliciesMock,
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

function lastSql(): string {
  const calls = mockDb.execute.mock.calls;
  const arg = calls[calls.length - 1]?.[0] as { _tag?: string; s?: string; strings?: string[] };
  // sql.raw → { s }, tagged template → { strings }
  return arg?.s ?? (arg?.strings ? arg.strings.join("?") : "");
}

describe("reports.depositLiability", () => {
  beforeEach(() => { vi.clearAllMocks(); executeQueue.value = []; });

  it("sums held deposits and lists only active rentals", async () => {
    executeQueue.value = [[
      { id: 1, order_no: "SOR00050", customerName: "Acme", deposit: "500", start_local: "2026-06-01" },
      { id: 2, order_no: "SOR00051", customerName: "Beta", deposit: "710", start_local: "2026-06-05" },
    ]];
    const res = await createCaller(makeCtx()).depositLiability();
    expect(res.totalHeld).toBe(1210);
    expect(res.orderCount).toBe(2);
    expect(res.orders[0].orderNo).toBe("SOR00050");
    const s = lastSql();
    expect(s).toContain("status = 'active'");
    // Only deposits actually marked collected (depositPaid = true) are a liability.
    // Un-marked deposits must be excluded — this is the deposit-collection closure.
    expect(s).toContain('"depositPaid" = true');
  });
});

describe("reports.arAging (truth-up)", () => {
  beforeEach(() => { vi.clearAllMocks(); executeQueue.value = []; });

  it("buckets owing from rental_requests netted by prepayments, not invoices", async () => {
    executeQueue.value = [[
      { bucket: "0-30", order_count: 3, total_owing: "1500" },
      { bucket: "90+", order_count: 1, total_owing: "800" },
    ]];
    const res = await createCaller(makeCtx()).arAging(undefined);
    expect(res.totalOutstanding).toBe(2300);
    expect(res.buckets[0]).toEqual({ bucket: "0-30", invoiceCount: 3, totalOwing: 1500 });
    const s = lastSql();
    expect(s).toContain("rental_prepayments");
    // Only applied prepayments net the balance (matches invoice rule); the
    // stale paymentStatus filter was removed so held prepayments don't reduce AR.
    expect(s).toContain('"appliedAt" IS NOT NULL');
    expect(s).not.toContain('r."paymentStatus" IN');
    expect(s).not.toContain("FROM invoices");
    // Extra charges (fuel/damage) are now folded into the owing via order_extras
    // (still order-level / damage_claims-based, NOT an invoice pivot).
    expect(s).toContain("order_extras");
    expect(s).toContain("damage_claims");
  });
});

describe("reports.accountsReceivable nets prepayments", () => {
  beforeEach(() => { vi.clearAllMocks(); executeQueue.value = []; });

  it("returns owing and totals on owing (not billed total)", async () => {
    executeQueue.value = [[
      { id: 7, customerName: "Acme", customerEmail: "", status: "completed", paymentStatus: "pending", totalAmount: "1000", owing: "400", createdAt: "2026-06-01" },
      { id: 8, customerName: "Beta", customerEmail: "", status: "active", paymentStatus: "partial", totalAmount: "500", owing: "500", createdAt: "2026-06-02" },
    ]];
    const res = await createCaller(makeCtx()).accountsReceivable(undefined);
    expect(res.orders[0].owing).toBe(400);
    expect(res.total).toBe(900); // 400 + 500, not 1500 billed
    const s = lastSql();
    expect(s).toContain("rental_prepayments");
    // Owing includes extra charges (fuel/damage) via order_extras.
    expect(s).toContain("order_extras");
  });
});

describe("reports.operationalHealth dispatch policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueue.value = [];
    getPoliciesMock.mockResolvedValue({
      dispatchWorkflow: false,
      dispatchInspectionRequired: false,
      returnInspectionRequired: true,
    });
  });

  it("suppresses only no_dispatch findings while dispatch is disabled", async () => {
    executeQueue.value = [[
      { id: 1, order_no: "R1", status: "approved", issue: "no_contract" },
      { id: 2, order_no: "R2", status: "active", issue: "no_dispatch" },
      { id: 3, order_no: "R3", status: "completed", issue: "no_invoice" },
    ]];

    const result = await createCaller(makeCtx()).operationalHealth();

    expect(result.items.map((item) => item.issue)).toEqual(["no_contract", "no_invoice"]);
    expect(result.count).toBe(2);
  });

  it("preserves no_dispatch findings while dispatch is enabled", async () => {
    getPoliciesMock.mockResolvedValue({
      dispatchWorkflow: true,
      dispatchInspectionRequired: false,
      returnInspectionRequired: true,
    });
    executeQueue.value = [[
      { id: 2, order_no: "R2", status: "active", issue: "no_dispatch" },
    ]];

    const result = await createCaller(makeCtx()).operationalHealth();

    expect(result.items.map((item) => item.issue)).toEqual(["no_dispatch"]);
  });
});
