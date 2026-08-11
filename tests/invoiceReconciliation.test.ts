import { describe, expect, it } from "vitest";
import {
  planExtraChargeReconciliation,
  renewalSupplementSourceKey,
  rentalInvoiceSourceKey,
} from "../server/services/invoiceReconciliation";

describe("rental invoice reconciliation", () => {
  it("uses a deterministic source key for the one base rental invoice", () => {
    expect(rentalInvoiceSourceKey(42)).toBe("rental:42:base");
    expect(renewalSupplementSourceKey(42, 9)).toBe("rental:42:extension:9");
  });

  it("claims only the exact charge ids represented by generated lines", () => {
    const plan = planExtraChargeReconciliation({
      claims: [
        { id: 11, chargeType: "fuel", description: "18 L", approvedAmount: "45.00", amount: null, repairEstimate: null },
        { id: 12, chargeType: "cleaning", description: null, approvedAmount: null, amount: "75.00", repairEstimate: null },
      ],
      currentSubtotal: "500.00",
      currentTaxAmount: "65.00",
      extraTaxAmount: 15.6,
    });

    expect(plan?.claimIds).toEqual([11, 12]);
    expect(plan?.lines.map((line) => line.amount)).toEqual(["45.00", "75.00"]);
    expect(plan?.newSubtotal).toBe("620.00");
    expect(plan?.newTaxAmount).toBe("80.60");
    expect(plan?.newTotalAmount).toBe("700.60");
  });

  it("does not claim a zero-value row that has no invoice line", () => {
    const plan = planExtraChargeReconciliation({
      claims: [
        { id: 21, chargeType: "other", description: "waived", approvedAmount: "0", amount: null, repairEstimate: null },
        { id: 22, chargeType: "damage", description: "panel", approvedAmount: "100", amount: null, repairEstimate: null },
      ],
      currentSubtotal: "0",
      currentTaxAmount: "0",
      extraTaxAmount: 13,
    });

    expect(plan?.claimIds).toEqual([22]);
    expect(plan?.lines).toHaveLength(1);
  });

  it("returns null when there is nothing billable", () => {
    expect(planExtraChargeReconciliation({
      claims: [],
      currentSubtotal: "10",
      currentTaxAmount: "1.3",
      extraTaxAmount: 0,
    })).toBeNull();
  });
});
