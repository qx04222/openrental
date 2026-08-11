export const rentalStatusOptions = [
  "pending",
  "approved",
  "rejected",
  "active",
  "completed",
  "cancelled",
  "overdue",
] as const;

export type RentalStatusOption = typeof rentalStatusOptions[number];

export function directRentalStatusOptions(currentStatus: RentalStatusOption) {
  return currentStatus === "completed"
    ? rentalStatusOptions
    : rentalStatusOptions.filter((status) => status !== "completed");
}
