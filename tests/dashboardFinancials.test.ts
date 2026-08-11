import { describe, expect, it } from "vitest";
import {
  deriveDashboardFinancials,
  deriveInvoiceAllocation,
} from "../server/services/dashboardFinancials";

describe("dashboard financial semantics", () => {
  it("separates order rent, issued receivables, outstanding balance, and cash", () => {
    const result = deriveDashboardFinancials({
      rentals: [
        { status: "active", rentalFee: "1000" },
        { status: "overdue", rentalFee: "600" },
        { status: "completed", rentalFee: "400" },
        { status: "approved", rentalFee: "999" },
      ],
      invoices: [
        { status: "sent", type: "rental", totalAmount: "800", balanceDue: "500" },
        { status: "paid", type: "rental", totalAmount: "400", balanceDue: "0" },
        { status: "sent", type: "credit_note", totalAmount: "100", balanceDue: "100" },
        { status: "draft", type: "rental", totalAmount: "900", balanceDue: "900" },
        { status: "cancelled", type: "rental", totalAmount: "700", balanceDue: "700" },
      ],
      prepayments: [
        { amount: "900", appliedAt: new Date() },
        { amount: "250", appliedAt: null },
        { amount: "-50", appliedAt: new Date() },
      ],
    });

    expect(result).toEqual({
      orderRent: 2000,
      cumulativeReceivable: 1100,
      outstandingBalance: 400,
      cashReceived: 1100,
      heldCash: 250,
    });
  });

  it("derives invoice allocation and order-level excess without rewriting rows", () => {
    expect(deriveInvoiceAllocation("1000", "1250")).toEqual({
      invoiceAllocated: 1000,
      orderCreditBalance: 250,
    });
    expect(deriveInvoiceAllocation("1000", "600")).toEqual({
      invoiceAllocated: 600,
      orderCreditBalance: 0,
    });
  });
});
