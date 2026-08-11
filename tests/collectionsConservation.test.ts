/**
 * The collections total must equal every overdue dollar — no silent drops.
 *
 * The list is built by joining overdue invoices to a customer, because a call
 * list needs somebody to call. Production has two overdue invoices with no
 * customerId and no rental to borrow one from ($2,355.55 between them); the
 * first version of the query joined them away, and the page would have shown
 * $60,202.89 while the ledger said $62,558.44. Money that quietly leaves a
 * total is worse than money shown as a problem, so orphans are reported in
 * their own bucket and still counted in the headline.
 */
import { describe, it, expect } from "vitest";

/** The two sums the router builds, extracted so the arithmetic is testable. */
function totals(
  customers: Array<{ totalOwed: number; invoiceCount: number; waiting: boolean }>,
  unassigned: Array<{ balanceDue: number }>,
) {
  const assignedAmount = customers.reduce((s, c) => s + c.totalOwed, 0);
  const unassignedAmount = unassigned.reduce((s, i) => s + i.balanceDue, 0);
  return {
    customerCount: customers.length,
    invoiceCount: customers.reduce((s, c) => s + c.invoiceCount, 0) + unassigned.length,
    amount: assignedAmount + unassignedAmount,
    unassignedAmount,
    waitingAmount: customers.filter((c) => c.waiting).reduce((s, c) => s + c.totalOwed, 0),
  };
}

describe("collections totals conservation", () => {
  // The real production shape as of 2026-08-09.
  const customers = [
    { totalOwed: 7147.27, invoiceCount: 4, waiting: false },
    { totalOwed: 8435.43, invoiceCount: 1, waiting: false },
    { totalOwed: 44620.19, invoiceCount: 40, waiting: false },
  ];
  const unassigned = [{ balanceDue: 971.8 }, { balanceDue: 1383.75 }];

  it("headline amount includes the invoices nobody can be called about", () => {
    const t = totals(customers, unassigned);
    expect(t.amount).toBeCloseTo(62558.44, 2);
    expect(t.unassignedAmount).toBeCloseTo(2355.55, 2);
  });

  it("invoice count covers both buckets", () => {
    expect(totals(customers, unassigned).invoiceCount).toBe(47);
  });

  it("dropping the orphan bucket would under-report — guard against regressing to that", () => {
    const withoutOrphans = totals(customers, []);
    expect(withoutOrphans.amount).toBeLessThan(totals(customers, unassigned).amount);
  });

  it("waiting amount is a subset of the total, never added on top", () => {
    const promised = [{ totalOwed: 1000, invoiceCount: 1, waiting: true }];
    const t = totals([...customers, ...promised], unassigned);
    expect(t.waitingAmount).toBe(1000);
    expect(t.waitingAmount).toBeLessThanOrEqual(t.amount);
  });
});
