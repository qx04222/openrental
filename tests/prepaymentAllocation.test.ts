import { describe, it, expect } from "vitest";
import { allocatePrepayments, derivePaymentState } from "../shared/paymentStatus";

// invoices passed oldest-first (as recalculateInvoicesForRental sorts them).
const inv = (id: number, total: number) => ({ id, total });
const pay = (amount: number, invoiceId: number | null = null) => ({ amount, invoiceId });

describe("allocatePrepayments", () => {
  it("single invoice, full payment → fully applied", () => {
    const { allocations: a } = allocatePrepayments([inv(1, 1000)], [pay(1000)]);
    expect(a.get(1)).toBe(1000);
  });

  it("single invoice, partial payment → partial applied", () => {
    const { allocations: a } = allocatePrepayments([inv(1, 1000)], [pay(400)]);
    expect(a.get(1)).toBe(400);
  });

  it("★ two invoices, payment TAGGED to invoice 1 → only invoice 1 paid (the月结 bug)", () => {
    const { allocations: a } = allocatePrepayments([inv(1, 1000), inv(2, 1000)], [pay(1000, 1)]);
    expect(a.get(1)).toBe(1000);
    expect(a.get(2)).toBe(0); // would have been 1000 (wrongly "paid") before the fix
  });

  it("two invoices, two tagged monthly payments → each its own", () => {
    const { allocations: a } = allocatePrepayments([inv(1, 1000), inv(2, 800)], [pay(1000, 1), pay(800, 2)]);
    expect(a.get(1)).toBe(1000);
    expect(a.get(2)).toBe(800);
  });

  it("untagged pool fills oldest invoice first (FIFO)", () => {
    const { allocations: a } = allocatePrepayments([inv(1, 1000), inv(2, 1000)], [pay(1200)]);
    expect(a.get(1)).toBe(1000);
    expect(a.get(2)).toBe(200);
  });

  it("tagged payment exceeding its invoice spills the overflow to the pool (FIFO)", () => {
    // Pay 1500 tagged to inv1 (total 1000): 1000 to inv1, 500 spills to inv2.
    const { allocations: a } = allocatePrepayments([inv(1, 1000), inv(2, 1000)], [pay(1500, 1)]);
    expect(a.get(1)).toBe(1000);
    expect(a.get(2)).toBe(500);
  });

  it("payment tagged to a missing/deleted invoice is treated as a general payment", () => {
    const { allocations: a } = allocatePrepayments([inv(1, 1000)], [pay(600, 999)]);
    expect(a.get(1)).toBe(600);
  });

  it("true overpayment is returned as the customer's credit, not pushed onto an invoice", () => {
    const { allocations: a, leftover } = allocatePrepayments([inv(1, 500), inv(2, 500)], [pay(1300)]);
    expect(a.get(1)).toBe(500);
    // Used to be 800 — the newest invoice absorbed the 300 overpayment, which is
    // why 35 production invoices report amountPaid above their own total.
    expect(a.get(2)).toBe(500);
    expect(leftover).toBe(300);
  });

  it("conserves the ledger: allocations plus leftover equal what was paid", () => {
    const { allocations: a, leftover } = allocatePrepayments([inv(1, 500), inv(2, 500)], [pay(1300)]);
    const sum = [...a.values()].reduce((s, v) => s + v, 0);
    expect(sum + leftover).toBe(1300); // nothing vanishes, nothing is invented
  });

  it("never reports leftover when the invoices absorb everything", () => {
    const { leftover } = allocatePrepayments([inv(1, 1000)], [pay(400)]);
    expect(leftover).toBe(0);
  });

  it("ignores refunds when computing credit, so a refund cannot create a balance", () => {
    // Negative rows are refunds; they do not settle invoices and must not show
    // up as money the customer has on account either.
    const { leftover } = allocatePrepayments([inv(1, 500)], [pay(800), pay(-300)]);
    expect(leftover).toBe(300);
  });

  it("no invoices → the whole deposit is the customer's credit", () => {
    // A deposit-only order before billing. The money is real and has to be
    // somewhere; with no invoice to settle, it is credit.
    const { allocations: a, leftover } = allocatePrepayments([], [pay(500)]);
    expect(a.size).toBe(0);
    expect(leftover).toBe(500);
  });

  it("combined with derivePaymentState: month-1 paid, month-2 unpaid", () => {
    const { allocations: a } = allocatePrepayments([inv(1, 1000), inv(2, 1000)], [pay(1000, 1)]);
    expect(derivePaymentState(1000, a.get(1)!)).toBe("paid");
    expect(derivePaymentState(1000, a.get(2)!)).toBe("unpaid");
  });
});
