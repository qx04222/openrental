/**
 * Extra charges must be taxed at the order's rate — including when the order's
 * taxProvince was left null (historical data gap). Regression: a null province
 * silently zeroed the extra-charge tax, under-deducting refunds (e.g. a $35 fuel
 * charge deducted as $35 instead of $35 × 1.13 = $39.55 in Ontario).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { orderRef, claimsRef, taxSpy } = vi.hoisted(() => ({
  orderRef: { value: { taxProvince: "ON", deliveryProvince: "ON" } as Record<string, unknown> },
  claimsRef: { value: [] as Array<Record<string, unknown>> },
  // calculateTax stub: flat 13% on rentalAmount, like the active ON HST row.
  taxSpy: vi.fn(async ({ rentalAmount, province }: { rentalAmount: number; province: string }) => ({
    totalTax: province ? Math.round(rentalAmount * 0.13 * 100) / 100 : 0,
  })),
}));

// db chain: order query ends in .limit(1); claims query ends at .where().
vi.mock("../server/db", () => ({
  getDb: async () => ({
    select: () => ({
      from: () => ({
        where: () => {
          const claims = Promise.resolve(claimsRef.value);
          return Object.assign(claims, { limit: () => Promise.resolve([orderRef.value]) });
        },
      }),
    }),
  }),
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  // getOrderExtraCharges now filters out soft-deleted claims, so the mock has to
  // expose isNull too (a deleted charge must stop counting toward what is owed).
  isNull: vi.fn(() => "isNull"),
}));

vi.mock("../server/services/taxCalculation", () => ({ calculateTax: taxSpy }));
vi.mock("../server/_core/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getOrderExtraCharges } from "../server/services/orderCharges";

describe("getOrderExtraCharges — extras are taxed at the order rate", () => {
  beforeEach(() => {
    orderRef.value = { taxProvince: "ON", deliveryProvince: "ON" };
    claimsRef.value = [];
    vi.clearAllMocks();
  });

  it("applies 13% tax to a fuel charge (ON)", async () => {
    claimsRef.value = [{ approvedAmount: "35.00", amount: null, repairEstimate: null }];
    const r = await getOrderExtraCharges(232);
    expect(r.subtotal).toBe(35);
    expect(r.tax).toBe(4.55); // 35 * 0.13
    expect(r.total).toBe(39.55); // the amount a refund must deduct
  });

  it("still taxes extras when taxProvince is null (falls back to deliveryProvince)", async () => {
    orderRef.value = { taxProvince: null, deliveryProvince: "ON" };
    claimsRef.value = [{ approvedAmount: "35.00" }];
    const r = await getOrderExtraCharges(232);
    expect(r.tax).toBe(4.55);
    expect(r.total).toBe(39.55);
    // never silently 0 — the original bug
    expect(r.tax).not.toBe(0);
  });

  it("falls back to ON when both taxProvince and deliveryProvince are null", async () => {
    orderRef.value = { taxProvince: null, deliveryProvince: null };
    claimsRef.value = [{ amount: "42.50" }];
    const r = await getOrderExtraCharges(221);
    expect(r.tax).toBe(5.53); // 42.50 * 0.13
    expect(taxSpy).toHaveBeenCalledWith(expect.objectContaining({ province: "ON" }));
  });

  it("returns zero for an order with no billable extras", async () => {
    claimsRef.value = [];
    const r = await getOrderExtraCharges(1);
    expect(r).toEqual({ subtotal: 0, tax: 0, total: 0 });
    expect(taxSpy).not.toHaveBeenCalled();
  });
});
