import * as schema from "../../drizzle/schema";
import { INSURANCE_OPTIONS, type InsuranceType } from "../../shared/insurance";
import type { getDb } from "../db";

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type SelectDb = Pick<AppDb, "select">;

/**
 * The insurance rate, from the one place the office can actually change it.
 *
 * Order creation read these keys from `rental_settings` (what the admin's
 * RentalSettings → Insurance tab writes), while every recalculation path used
 * the hardcoded percentages in shared/insurance.ts. The two agreed only because
 * nobody had ever changed the rate — the moment someone did, quoting a new
 * order and changing an existing order's dates would price insurance
 * differently, with no error and no warning.
 *
 * The constants stay as the fallback: they are the current production rates, so
 * a missing key degrades to today's behaviour rather than to zero.
 */
export async function resolveInsuranceRate(
  db: SelectDb,
  insuranceType: InsuranceType,
): Promise<number> {
  const fallback = INSURANCE_OPTIONS[insuranceType].costPercentage;
  if (insuranceType === "none") return 0;

  try {
    const settings = await db.select().from(schema.rentalSettings);
    const key = insuranceType === "basic" ? "insurance_basic_rate" : "insurance_full_rate";
    const raw = settings.find((s) => s.key === key)?.value;
    const pct = parseFloat(raw ?? String(fallback));
    return Number.isFinite(pct) && pct > 0 ? pct : fallback;
  } catch {
    return fallback;
  }
}

/** Insurance cost at the configured rate. */
export async function calculateInsuranceCostFromSettings(
  db: SelectDb,
  rentalFee: number,
  insuranceType: InsuranceType,
): Promise<number> {
  const pct = await resolveInsuranceRate(db, insuranceType);
  return Math.round(rentalFee * pct * 100) / 100;
}
