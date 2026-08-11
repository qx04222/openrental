/**
 * reports.taxRemittance — HST/GST filing report aggregation.
 *
 * Mocked db returns queued rows for the two queries the procedure runs
 * (by-province, then by-month). Asserts:
 *  1. HST-province tax allocated 100% to HST
 *  2. GST+PST-province tax split in the gst:pst rate ratio (sums to collected)
 *  3. a province absent from tax_rates leaves its tax `unallocated`
 *  4. totals aggregate across provinces; deposits never enter the taxable base
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

function firstSql(): string {
  const arg = mockDb.execute.mock.calls[0]?.[0] as { s?: string };
  return arg?.s ?? "";
}

describe("reports.taxRemittance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeQueue.value = [];
  });

  it("allocates by province rate structure and aggregates totals", async () => {
    executeQueue.value = [
      [
        // ON: HST 13% → all collected tax is HST.
        { province: "ON", province_name: "Ontario", gst_rate: "0", pst_rate: "0", hst_rate: "0.13", order_count: 99, taxable_sales: "102882.39", tax_collected: "12940.86" },
        // BC: GST 5% + PST 7% → split 5:7 of the collected tax.
        { province: "BC", province_name: "British Columbia", gst_rate: "0.05", pst_rate: "0.07", hst_rate: "0", order_count: 2, taxable_sales: "1000", tax_collected: "120" },
        // ZZ: not in tax_rates (all rates 0) → unallocated.
        { province: "ZZ", province_name: "ZZ", gst_rate: "0", pst_rate: "0", hst_rate: "0", order_count: 1, taxable_sales: "500", tax_collected: "65" },
      ],
      [{ month: "2026-05", taxable_sales: "1000", tax_collected: "130" }],
    ];
    const caller = createCaller(makeCtx());
    const res = await caller.taxRemittance(undefined);

    expect(res.byProvince).toHaveLength(3);
    const on = res.byProvince.find((p) => p.province === "ON")!;
    expect(on.hst).toBe(12940.86);
    expect(on.gst).toBe(0);
    expect(on.unallocated).toBe(0);

    const bc = res.byProvince.find((p) => p.province === "BC")!;
    expect(bc.gst).toBe(50); // 120 × 5/12
    expect(bc.pst).toBe(70); // remainder → gst+pst === collected
    expect(bc.gst + bc.pst).toBeCloseTo(bc.taxCollected, 2);

    const zz = res.byProvince.find((p) => p.province === "ZZ")!;
    expect(zz.unallocated).toBe(65);

    expect(res.totals).not.toBeNull();
    expect(res.totals!.taxableSales).toBeCloseTo(104382.39, 2);
    expect(res.totals!.taxCollected).toBeCloseTo(13125.86, 2);
    expect(res.totals!.orderCount).toBe(102);
    expect(res.byMonth).toEqual([{ month: "2026-05", taxableSales: 1000, taxCollected: 130 }]);
  });

  it("never puts deposits in the taxable base", async () => {
    executeQueue.value = [[], []];
    const caller = createCaller(makeCtx());
    await caller.taxRemittance(undefined);
    const s = firstSql();
    expect(s).not.toContain("depositAmount");
    expect(s).toContain("tax_rates");
  });
});
