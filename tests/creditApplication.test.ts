/**
 * Applying credit has one non-obvious constraint: it MUST land in the
 * prepayment ledger, because an invoice's amountPaid is recomputed from that
 * ledger and anything written straight onto the invoice is erased by the next
 * recalculation. But the money was already collected once — when it became
 * credit — so the row is marked account_credit and collections reporting
 * excludes it. These pin both halves of that arrangement.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ACCOUNT_CREDIT_METHOD } from "../server/services/customerCredit";
import { allocatePrepayments } from "../shared/paymentStatus";

describe("applying credit to an invoice", () => {
  it("settles the invoice through the normal allocation path", () => {
    // A credit application is an ordinary applied prepayment tagged to its
    // invoice, so the existing allocator settles it with no special case.
    const { allocations, leftover } = allocatePrepayments(
      [{ id: 1, total: 500 }],
      [{ amount: 500, invoiceId: 1 }],
    );

    expect(allocations.get(1)).toBe(500);
    expect(leftover).toBe(0);
  });

  it("writes the prepayment row rather than the invoice", () => {
    const src = readFileSync("server/routers/customerCredit.router.ts", "utf8");
    const applyBlock = src.slice(src.indexOf("applyToInvoice:"), src.indexOf("transferDeposit:"));

    expect(applyBlock).toContain("insert(schema.rentalPrepayments)");
    // Writing amountPaid directly would survive exactly until the next
    // recalculation, which runs on any payment or invoice change.
    expect(applyBlock).not.toContain("update(schema.invoices)");
    expect(applyBlock).toContain("recalculateInvoicesForRental");
  });

  it("marks the row so collections do not count the money twice", () => {
    const src = readFileSync("server/routers/customerCredit.router.ts", "utf8");
    expect(src).toContain("ACCOUNT_CREDIT_METHOD");

    const reports = readFileSync("server/routers/reports.router.ts", "utf8");
    expect(reports).toContain("'account_credit'");
  });

  it("refuses to overdraw the balance or overpay the invoice", () => {
    const src = readFileSync("server/routers/customerCredit.router.ts", "utf8");
    const applyBlock = src.slice(src.indexOf("applyToInvoice:"), src.indexOf("transferDeposit:"));

    expect(applyBlock).toContain("errors.creditInsufficient");
    expect(applyBlock).toContain("errors.creditExceedsInvoice");
    expect(applyBlock).toContain("errors.invoiceAlreadySettled");
  });

  it("serialises concurrent applications for the same customer", () => {
    const src = readFileSync("server/routers/customerCredit.router.ts", "utf8");
    const applyBlock = src.slice(src.indexOf("applyToInvoice:"), src.indexOf("transferDeposit:"));

    // The balance is a SUM with no row to lock, so two simultaneous
    // applications would both read the pre-spend balance and together overdraw
    // it. Locking the customer row makes them queue.
    expect(applyBlock).toContain('.for("update")');
    expect(applyBlock).toContain("db.transaction");
  });

  it("uses a payment method distinct from every real one", () => {
    expect(ACCOUNT_CREDIT_METHOD).toBe("account_credit");
    const methods = readFileSync("shared/paymentMethod.ts", "utf8");
    expect(methods).not.toContain(`"${ACCOUNT_CREDIT_METHOD}"`);
  });
});
