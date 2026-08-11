/**
 * P4 closes the loop on the three kinds of money that had nowhere to live:
 * a deposit held past its rental, a credit note owed to the customer, and cash
 * going back out. Each has a way it could quietly double-count, which is what
 * these pin.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const router = readFileSync("server/routers/customerCredit.router.ts", "utf8");
const slice = (from: string, to: string) => router.slice(router.indexOf(from), router.indexOf(to));

describe("moving a held deposit to credit", () => {
  const block = slice("transferDeposit:", "absorbCreditNote:");

  it("does not mark the prepayment as applied", () => {
    // appliedAt would make the row settle invoices — that is "convert to rent",
    // a different decision. On a fully-paid order the money would come straight
    // back out as an overpayment and be counted twice.
    expect(block).toContain("transferredToCreditAt");
    expect(block).not.toContain("appliedAt: new Date()");
  });

  it("only picks up deposits that are still held and not already moved", () => {
    expect(block).toContain("isNull(schema.rentalPrepayments.appliedAt)");
    expect(block).toContain("isNull(schema.rentalPrepayments.transferredToCreditAt)");
  });

  it("locks the rows so the same deposit cannot be transferred twice", () => {
    expect(block).toContain('.for("update")');
  });
});

describe("absorbing a credit note", () => {
  const block = slice("absorbCreditNote:", "Pay credit back out");

  it("refuses anything that is not a credit note", () => {
    expect(block).toContain("errors.notACreditNote");
  });

  it("cannot be run twice on the same note", () => {
    expect(block).toContain("errors.creditNoteAlreadyAbsorbed");
    expect(block).toContain('status: "credited"');
  });

  it("credits the absolute value, since the note's total is negative", () => {
    expect(block).toContain("Math.abs(parseFloat(note.totalAmount");
  });

  it("settles the note so it stops showing as money owed in two places", () => {
    expect(block).toContain('balanceDue: "0.00"');
  });
});

describe("refunding credit", () => {
  const block = slice("refund:", "Manual correction");

  it("is admin-only regardless of module permissions", () => {
    // Every other action here moves money between our own columns; this one
    // sends it out of the company and cannot be undone.
    expect(block).toContain('ctx.user?.role !== "admin"');
    expect(block).toContain('ctx.user?.role !== "super_admin"');
    expect(block).toContain("errors.refundRequiresAdmin");
  });

  it("cannot refund more than the balance", () => {
    expect(block).toContain("errors.creditInsufficient");
  });

  it("locks the customer so two refunds cannot both drain the same balance", () => {
    expect(block).toContain('.for("update")');
  });

  it("demands a reason", () => {
    expect(block).toContain("reason: z.string().trim().min(3)");
  });
});

describe("the held-deposit work queue", () => {
  it("stops flagging a deposit once it has been moved to credit", () => {
    const queue = readFileSync("server/services/internalWorkQueue.ts", "utf8");
    expect(queue).toContain('p."transferredToCreditAt" IS NULL');
  });
});
