import { describe, expect, it } from "vitest";
import { isInvoiceOverdue } from "../shared/invoiceOverdue";

// Toronto "today" midnight as a UTC instant (the shape zonedTodayPlusDaysUtc(0) returns).
const TODAY = new Date("2026-06-21T04:00:00.000Z");
const YESTERDAY = new Date("2026-06-20T04:00:00.000Z");
const TOMORROW = new Date("2026-06-22T04:00:00.000Z");

describe("isInvoiceOverdue", () => {
  it("is overdue when sent/partial, owes money, and due date has passed", () => {
    expect(isInvoiceOverdue("sent", YESTERDAY, "100.00", TODAY)).toBe(true);
    expect(isInvoiceOverdue("partial", YESTERDAY, 50, TODAY)).toBe(true);
  });

  it("is NOT overdue when fully paid (no balance)", () => {
    expect(isInvoiceOverdue("sent", YESTERDAY, "0", TODAY)).toBe(false);
    expect(isInvoiceOverdue("sent", YESTERDAY, 0.004, TODAY)).toBe(false); // sub-cent
  });

  it("is NOT overdue before the due date (today or future)", () => {
    expect(isInvoiceOverdue("sent", TODAY, "100", TODAY)).toBe(false);
    expect(isInvoiceOverdue("sent", TOMORROW, "100", TODAY)).toBe(false);
  });

  it("only flags payment-open statuses (never draft/paid/cancelled/credited)", () => {
    for (const s of ["draft", "paid", "cancelled", "credited"]) {
      expect(isInvoiceOverdue(s, YESTERDAY, "100", TODAY)).toBe(false);
    }
  });

  it("is NOT overdue when due date is missing", () => {
    expect(isInvoiceOverdue("sent", null, "100", TODAY)).toBe(false);
  });
});
