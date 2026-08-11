/**
 * resolveCustomerPricing — customer-level discount fallback (big-customer tier).
 * Verifies that when no fleet/category contract row matches, the customer's
 * blanket discountPercent is applied to the resolved rates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Per-call queue: each awaited select() resolves the next queued result, so we
// can script the sequential lookups inside resolveCustomerPricing.
const { mockGetDb, queue } = vi.hoisted(() => {
  const queue: { value: unknown[][] } = { value: [] };
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "orderBy"]) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve(queue.value.shift() ?? []);
    return chain;
  };
  const db = { select: vi.fn(() => makeChain()) };
  return { mockGetDb: vi.fn().mockResolvedValue(db), queue };
});

vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn(() => "eq"),
  and: vi.fn(() => "and"),
  isNull: vi.fn(() => "isNull"),
  sql: Object.assign(() => "sql", {}),
}));

vi.mock("../../drizzle/schema", () => ({
  customerPricing: { customerId: "cp.customerId", rentalFleetId: "cp.fleet", category: "cp.cat", isActive: "cp.active", validFrom: "cp.from", validTo: "cp.to" },
  rentalFleet: { id: "f.id", deletedAt: "f.del" },
  equipmentModels: { id: "m.id", deletedAt: "m.del", dailyRate: "m.d", weeklyRate: "m.w", monthlyRate: "m.m", twentyEightDayRate: "m.28" },
  customers: { id: "c.id", deletedAt: "c.del", discountPercent: "c.disc" },
}));

import { resolveCustomerPricing } from "../../server/services/customerPricingLookup";

const fleetRow = { id: 1, category: "excavator", equipmentModelId: null, dailyRate: "100", weeklyRate: "500", monthlyRate: "2000", twentyEightDayRate: null };

describe("resolveCustomerPricing — customer-level discount fallback", () => {
  beforeEach(() => { vi.clearAllMocks(); queue.value = []; });

  it("applies the customer's blanket discountPercent when no contract row matches", async () => {
    // Sequential lookups: fleetMatch(none), fleet, categoryMatch(none), customer(10%)
    queue.value = [[], [fleetRow], [], [{ discountPercent: "10" }]];
    const r = await resolveCustomerPricing(7, 1);
    expect(r.source).toBe("customer_default");
    expect(r.discountPercent).toBe(10);
    expect(r.dailyRate).toBe(90);   // 100 - 10%
    expect(r.weeklyRate).toBe(450); // 500 - 10%
    expect(r.monthlyRate).toBe(1800);
  });

  it("returns default rates (no discount) when the customer has 0%", async () => {
    queue.value = [[], [fleetRow], [], [{ discountPercent: "0" }]];
    const r = await resolveCustomerPricing(7, 1);
    expect(r.source).toBe("default");
    expect(r.dailyRate).toBe(100);
  });
});
