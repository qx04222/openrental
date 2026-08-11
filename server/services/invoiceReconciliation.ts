import {
  EXTRA_CHARGE_LABELS,
  chargeLineType,
  type ExtraChargeReason,
} from "../../shared/extraCharges";

export interface ReconciliationClaim {
  id: number;
  chargeType: string | null;
  description: string | null;
  approvedAmount: string | null;
  amount: string | null;
  repairEstimate: string | null;
}

export interface ExtraChargeReconciliationPlan {
  claimIds: number[];
  lines: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    lineType: string;
    sortOrder: number;
  }>;
  extraSubtotal: string;
  newSubtotal: string;
  newTaxAmount: string;
  newTotalAmount: string;
}

const cents = (value: number) => Math.round(value * 100) / 100;
const money = (value: number) => cents(value).toFixed(2);

export function rentalInvoiceSourceKey(rentalId: number): string {
  return `rental:${rentalId}:base`;
}

export function renewalSupplementSourceKey(rentalId: number, extensionRequestId: number): string {
  return `rental:${rentalId}:extension:${extensionRequestId}`;
}

export function planExtraChargeReconciliation(input: {
  claims: ReconciliationClaim[];
  currentSubtotal: string;
  currentTaxAmount: string;
  extraTaxAmount: number;
}): ExtraChargeReconciliationPlan | null {
  const billable = input.claims
    .map((claim) => ({
      claim,
      amount: Number.parseFloat(claim.approvedAmount || claim.amount || claim.repairEstimate || "0"),
    }))
    .filter(({ amount }) => Number.isFinite(amount) && amount > 0);

  if (billable.length === 0) return null;

  const extraSubtotal = cents(billable.reduce((sum, item) => sum + item.amount, 0));
  const newSubtotal = cents(Number.parseFloat(input.currentSubtotal || "0") + extraSubtotal);
  const newTaxAmount = cents(Number.parseFloat(input.currentTaxAmount || "0") + input.extraTaxAmount);

  return {
    claimIds: billable.map(({ claim }) => claim.id),
    lines: billable.map(({ claim, amount }, index) => {
      const reason = (claim.chargeType ?? "other") as ExtraChargeReason;
      const label = EXTRA_CHARGE_LABELS[reason]?.en ?? "Extra charge";
      return {
        description: claim.description ? `${label}: ${claim.description}` : label,
        quantity: "1",
        unitPrice: money(amount),
        amount: money(amount),
        lineType: chargeLineType(reason),
        sortOrder: 20 + index,
      };
    }),
    extraSubtotal: money(extraSubtotal),
    newSubtotal: money(newSubtotal),
    newTaxAmount: money(newTaxAmount),
    newTotalAmount: money(newSubtotal + newTaxAmount),
  };
}
