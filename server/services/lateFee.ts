/**
 * Late Fee Computation Service
 * Pure, dependency-free functions — fully testable without a DB.
 */

export interface LateFeeSettings {
  lateFeeDailyRatePct: number; // e.g. 150 = 1.5× daily rate
  lateFeeGraceHours: number;   // grace period before fees begin
}

export interface LateFeeInput {
  endDate: Date;
  actualReturnDate: Date | null; // null => ongoing, compute vs `now`
  dailyBaseRate: number;         // rentalFee / rentalDays
  settings: LateFeeSettings;
  now?: Date;                    // injectable for deterministic tests
}

export interface LateFeeResult {
  lateDays: number;      // 0 if within grace period
  lateFeeAmount: number; // CAD
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Compute the late fee for a rental.
 *
 * Algorithm:
 *   overdueMs  = returnDate - endDate - graceHours (in ms)
 *   lateDays   = max(0, floor(overdueMs / 24h))
 *   lateFee    = lateDays × dailyBaseRate × (lateFeeDailyRatePct / 100)
 */
export function computeLateFee({
  endDate,
  actualReturnDate,
  dailyBaseRate,
  settings,
  now = new Date(),
}: LateFeeInput): LateFeeResult {
  const returnDate = actualReturnDate ?? now;

  const overdueMs =
    returnDate.getTime() -
    endDate.getTime() -
    settings.lateFeeGraceHours * MS_PER_HOUR;

  const lateDays = Math.max(0, Math.floor(overdueMs / MS_PER_DAY));
  const lateFeeAmount = lateDays * dailyBaseRate * (settings.lateFeeDailyRatePct / 100);

  return { lateDays, lateFeeAmount };
}

/**
 * Helper: derive dailyBaseRate from a rental row.
 * Returns 0 if data is missing or rental has zero days.
 */
export function dailyBaseRateFromRental(rental: {
  rentalFee: string | null | undefined;
  startDate: Date;
  endDate: Date;
}): number {
  const fee = parseFloat(rental.rentalFee ?? "0");
  const days = Math.max(
    1,
    Math.ceil(
      (rental.endDate.getTime() - rental.startDate.getTime()) / MS_PER_DAY,
    ),
  );
  return fee / days;
}
