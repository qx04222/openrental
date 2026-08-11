/**
 * Credit (挂账) orders — shared constants/helpers between server, client, tests.
 *
 * Open-ended rentals keep `endDate` NOT NULL and store a sentinel far-future
 * date instead of going nullable. Rationale (verified against every endDate
 * consumer): availability/conflict checks treat the sentinel as "occupied
 * forever" (exactly the business need, zero code change), while a NULL endDate
 * would be silently dropped by `gte(NULL, start)` → double-booking, and would
 * break 30+ files typed as `endDate: Date`. The late-fee cron's `endDate < now`
 * never matches the sentinel, so it can stay untouched. At close-out the
 * sentinel is overwritten with the real end date.
 */

// Stored verbatim into endDate (via parseCalendarDate, Toronto-anchored midnight).
export const OPEN_ENDED_END_DATE = "2099-12-31";

// Treat anything in/after the sentinel year as "open-ended" so we never depend
// on an exact string/timezone round-trip.
export function isOpenEndedEndDate(d: Date | string | null | undefined): boolean {
  if (d == null) return false;
  const year = typeof d === "string" ? Number(d.slice(0, 4)) : d.getFullYear();
  return Number.isFinite(year) && year >= 2099;
}

// rental_charges.chargeType domain. 'swap' = bin exchange line; 'final' =
// lump-sum settlement line; 'adjustment' = manual correction.
export const CHARGE_TYPES = ["swap", "final", "adjustment"] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];
