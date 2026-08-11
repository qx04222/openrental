export const ROLLING_CYCLE_DAYS = 28;

export type RollingTermStatus = "active" | "ending" | "ended";
export type DelayResponsibility = "company" | "customer" | "none";
export type RollingOperationalState =
  | "in_rental"
  | "rolling_renewal"
  | "awaiting_pickup"
  | "awaiting_return_inspection"
  | "awaiting_close"
  | "customer_overdue"
  | "completed";

export function addRollingDays(date: Date, days = ROLLING_CYCLE_DAYS): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isHistoricalCutoffWithinBounds(
  originalEndDate: Date,
  cutoff: Date,
  now = new Date(),
): boolean {
  return cutoff.getTime() > originalEndDate.getTime()
    && cutoff.getTime() <= now.getTime();
}

export function resolveBillingCutoff(input: {
  responsibility: DelayResponsibility;
  customerReadyAt: Date;
  pickedUpAt: Date | null;
  existingBillingStopAt?: Date | null;
}): Date | null {
  const proposed = input.responsibility === "company"
    ? input.customerReadyAt
    : input.pickedUpAt;
  if (!proposed) return input.existingBillingStopAt ?? null;
  if (!input.existingBillingStopAt) return proposed;
  return input.existingBillingStopAt.getTime() <= proposed.getTime()
    ? input.existingBillingStopAt
    : proposed;
}

export function deriveRollingOperationalState(input: {
  rentalStatus: "pending" | "approved" | "rejected" | "active" | "completed" | "cancelled" | "overdue";
  rollingStatus: RollingTermStatus | null;
  customerReadyAt: Date | null;
  pickedUpAt: Date | null;
  returnEvidence: boolean;
  responsibility: DelayResponsibility;
}): RollingOperationalState {
  if (input.rentalStatus === "completed") return "completed";
  if (input.pickedUpAt && input.returnEvidence) return "awaiting_close";
  if (input.pickedUpAt) return "awaiting_return_inspection";
  if (input.customerReadyAt && !input.pickedUpAt) {
    if (input.responsibility === "customer" && input.rentalStatus === "overdue") {
      return "customer_overdue";
    }
    return "awaiting_pickup";
  }
  if (input.rollingStatus === "active" || input.rollingStatus === "ending") {
    return "rolling_renewal";
  }
  if (input.rentalStatus === "overdue") return "customer_overdue";
  return "in_rental";
}

export function isRollingSettlementDue(
  term: {
    status: RollingTermStatus;
    billingStopAt: Date | null;
    nextSettlementDate: Date;
  },
  now: Date,
): boolean {
  return (term.status === "active" || term.status === "ending")
    && term.billingStopAt === null
    && term.nextSettlementDate.getTime() <= now.getTime();
}
