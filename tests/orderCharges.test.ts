/**
 * orderCharges — the order-level "amount owed" helper that folds extra charges
 * (fuel/damage/…) + their tax into the balance/refund math. Guards the bug where
 * a refund ignored a gas fee and over-refunded.
 *
 * The helper does two selects (order taxProvince, then the damage_claims rows)
 * and then calls calculateTax. We queue the two select results in order and mock
 * calculateTax with a flat 13% so the arithmetic is deterministic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetDb, selectQueue, mockCalcTax } = vi.hoisted(() => {
  const selectQueue: { value: unknown[][] } = { value: [] };
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "from", "where", "limit"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve(selectQueue.value.length ? selectQueue.value.shift()! : []);
    return chain;
  };
  const mockDb = {
    select: vi.fn().mockImplementation(() => makeChain()),
  };
  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    selectQueue,
    mockCalcTax: vi.fn(),
  };
});

vi.mock("../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn(() => "eq"),
  and: vi.fn(() => "and"),
  inArray: vi.fn(() => "inArray"),
  isNull: vi.fn(() => "isNull"),
}));

vi.mock("../drizzle/schema", () => ({
  rentalRequests: { id: "id", taxProvince: "taxProvince", deliveryProvince: "deliveryProvince" },
  damageClaims: {
    rentalId: "rentalId", status: "status", deletedAt: "deletedAt",
    approvedAmount: "approvedAmount", amount: "amount", repairEstimate: "repairEstimate",
  },
}));

vi.mock("../server/services/taxCalculation", () => ({
  calculateTax: (...args: unknown[]) => mockCalcTax(...args),
}));

import { getOrderExtraCharges, getOrderAmountOwed } from "../server/services/orderCharges";

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.value = [];
  // Flat 13% on the rentalAmount (taxBase), rounded to cents — matches calculateTax's ON path.
  mockCalcTax.mockImplementation(async (input: { rentalAmount: number }) => ({
    totalTax: Math.round(input.rentalAmount * 0.13 * 100) / 100,
  }));
});

describe("getOrderExtraCharges", () => {
  it("sums accepted/invoiced charges (approvedAmount→amount→repairEstimate) and taxes them", async () => {
    selectQueue.value = [
      [{ taxProvince: "ON" }],
      [
        { approvedAmount: "21.00", amount: null, repairEstimate: null }, // fuel
        { approvedAmount: null, amount: "50.00", repairEstimate: null },  // cleaning
        { approvedAmount: null, amount: null, repairEstimate: "100.00" }, // damage
      ],
    ];
    const res = await getOrderExtraCharges(1);
    expect(res.subtotal).toBe(171); // 21 + 50 + 100
    expect(res.tax).toBe(22.23);    // 171 * 0.13
    expect(res.total).toBe(193.23);
  });

  it("still taxes extras when taxProvince is null — falls back to deliveryProvince/ON", async () => {
    // Historical orders had a null taxProvince; the old code silently zeroed the
    // extra-charge tax and under-deducted refunds. Now it falls back to the
    // delivery province (else ON) so the extra is taxed like the rest of the order.
    selectQueue.value = [
      [{ taxProvince: null, deliveryProvince: "ON" }],
      [{ approvedAmount: "21.00", amount: null, repairEstimate: null }],
    ];
    const res = await getOrderExtraCharges(1);
    expect(res.subtotal).toBe(21);
    expect(res.tax).toBe(2.73); // 21 * 0.13 — never silently 0
    expect(res.total).toBe(23.73);
    expect(mockCalcTax).toHaveBeenCalledWith(expect.objectContaining({ province: "ON" }));
  });

  it("is zero when there are no accepted/invoiced charges", async () => {
    selectQueue.value = [[{ taxProvince: "ON" }], []];
    const res = await getOrderExtraCharges(1);
    expect(res).toEqual({ subtotal: 0, tax: 0, total: 0 });
    expect(mockCalcTax).not.toHaveBeenCalled();
  });

  it("ignores non-positive amounts", async () => {
    selectQueue.value = [
      [{ taxProvince: "ON" }],
      [
        { approvedAmount: "21.00", amount: null, repairEstimate: null },
        { approvedAmount: "0", amount: null, repairEstimate: null },
        { approvedAmount: "-5.00", amount: null, repairEstimate: null },
      ],
    ];
    const res = await getOrderExtraCharges(1);
    expect(res.subtotal).toBe(21);
  });
});

describe("getOrderAmountOwed", () => {
  it("adds extras (with tax) on top of the base total — the gas-fee refund bug", async () => {
    // The reported scenario: base 363.86, one $21 gas fee on an ON order.
    selectQueue.value = [
      [{ taxProvince: "ON" }],
      [{ approvedAmount: "21.00", amount: null, repairEstimate: null }],
    ];
    const owed = await getOrderAmountOwed(1, 363.86);
    // 363.86 + 21 + round(21*0.13)=2.73 → 387.59 (NOT 363.86 → would over-refund $23.73)
    expect(owed).toBe(387.59);
  });

  it("equals the base total when there are no extras", async () => {
    selectQueue.value = [[{ taxProvince: "ON" }], []];
    const owed = await getOrderAmountOwed(1, 363.86);
    expect(owed).toBe(363.86);
  });
});
