export type CustomerTier = "vip" | "active" | "at_risk" | "churned";

export interface SegmentationConfig {
  vipRevenueThreshold: number; // default 50000
  activeWithinDays: number; // default 90
  atRiskWithinDays: number; // default 180
  // Churned = lastRentalDate older than atRiskWithinDays days OR no rentals
}

export const DEFAULT_SEGMENTATION_CONFIG: SegmentationConfig = {
  vipRevenueThreshold: 50000,
  activeWithinDays: 90,
  atRiskWithinDays: 180,
};

export function computeTier(
  input: { totalRevenue: number | string | null; lastRentalDate: Date | string | null },
  config: SegmentationConfig = DEFAULT_SEGMENTATION_CONFIG,
  now: Date = new Date(),
): CustomerTier {
  const revenue = input.totalRevenue === null || input.totalRevenue === undefined
    ? 0
    : Number(input.totalRevenue);

  // VIP takes priority: totalRevenue >= vipRevenueThreshold
  if (!isNaN(revenue) && revenue >= config.vipRevenueThreshold) {
    return "vip";
  }

  // No rental date means never rented => churned
  if (input.lastRentalDate === null || input.lastRentalDate === undefined) {
    return "churned";
  }

  const lastDate = input.lastRentalDate instanceof Date
    ? input.lastRentalDate
    : new Date(input.lastRentalDate);

  // Invalid date => churned
  if (isNaN(lastDate.getTime())) {
    return "churned";
  }

  const daysSinceLastRental = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceLastRental <= config.activeWithinDays) {
    return "active";
  }

  if (daysSinceLastRental <= config.atRiskWithinDays) {
    return "at_risk";
  }

  return "churned";
}
