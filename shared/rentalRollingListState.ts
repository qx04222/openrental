export type RentalRollingListState = "active" | "ending" | "candidate" | null;

export function deriveRentalRollingListState(input: {
  rentalStatus: string;
  endDate: Date;
  rollingStatus: string | null;
  isCreditOrder?: boolean;
  now?: Date;
}): RentalRollingListState {
  if (input.rentalStatus !== "active" && input.rentalStatus !== "overdue") return null;
  if (input.rollingStatus === "active" || input.rollingStatus === "ending") {
    return input.rollingStatus;
  }
  if (input.rollingStatus !== null || input.isCreditOrder) return null;
  if (input.endDate.getTime() >= (input.now ?? new Date()).getTime()) return null;
  return "candidate";
}
