/**
 * Asset Economics — per-asset operating analytics for heavy-equipment rental.
 *
 * Pure math (no DB) so it is unit-testable in isolation; the reports router
 * supplies the aggregated revenue + the depreciation policy and renders the
 * result. Revenue here is NET RENTAL revenue (rentalFee / lineSubtotal only) —
 * deliberately excluding tax (a collected liability), freight and insurance
 * (pass-through), matching the project's net-income definition.
 *
 * Depreciation is straight-line:
 *   annual = purchaseCost × (1 − salvagePct) / usefulLifeYears
 * Maintenance cost is intentionally absent (no structured source yet — the
 * maintenance module is a later phase); callers show it as "—".
 */

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

// Below this age, annualizing revenue produces wildly unstable figures
// (dividing a few months of revenue by a tiny fraction of a year), so we
// report annualized metrics as null rather than a misleading number.
const MIN_AGE_FOR_ANNUALIZATION_YEARS = 0.5;

export interface AssetEconomicsInput {
  /** Acquisition cost; 0 or null when unknown (then cost-based metrics are null). */
  purchaseCost: number | null;
  /** Acquisition date; null when unknown (then age/annualized metrics are null). */
  purchaseDate: Date | null;
  /** Accumulated NET rental revenue (rentalFee + multi-item lineSubtotal). */
  netRentalRevenue: number;
  /** Straight-line useful life, years (policy; e.g. 7). */
  usefulLifeYears: number;
  /** Salvage fraction 0..1 (policy; e.g. 0.10 = 10% residual). */
  salvagePct: number;
  /** "Now" injected for deterministic tests. */
  now: Date;
}

export interface AssetEconomics {
  ageYears: number | null;
  annualDepreciation: number | null;
  accumulatedDepreciation: number | null;
  bookValue: number | null;
  /** Accumulated net revenue ÷ purchaseCost × 100 (how much cost is recovered). */
  paybackPct: number | null;
  annualizedNetRevenue: number | null;
  /** (annualized net revenue − annual depreciation) ÷ purchaseCost × 100. */
  annualRoiPct: number | null;
  /** True once net revenue has recovered the full purchase cost. */
  isPaidBack: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function computeAssetEconomics(input: AssetEconomicsInput): AssetEconomics {
  const { purchaseCost, purchaseDate, netRentalRevenue, usefulLifeYears, salvagePct, now } = input;

  const hasCost = purchaseCost != null && purchaseCost > 0;
  const cost = hasCost ? (purchaseCost as number) : 0;
  const salvage = Math.min(Math.max(salvagePct, 0), 1);
  const life = usefulLifeYears > 0 ? usefulLifeYears : 1;

  const ageYears =
    purchaseDate != null
      ? Math.max(0, (now.getTime() - purchaseDate.getTime()) / MS_PER_YEAR)
      : null;

  const depreciableBase = cost * (1 - salvage);
  const annualDepreciation = hasCost ? round2(depreciableBase / life) : null;

  const accumulatedDepreciation =
    hasCost && ageYears != null
      ? round2(Math.min(depreciableBase, (depreciableBase / life) * ageYears))
      : null;

  const bookValue =
    hasCost && accumulatedDepreciation != null
      ? round2(cost - accumulatedDepreciation)
      : null;

  const paybackPct = hasCost ? round1((netRentalRevenue / cost) * 100) : null;

  const canAnnualize = ageYears != null && ageYears >= MIN_AGE_FOR_ANNUALIZATION_YEARS;
  const annualizedNetRevenue = canAnnualize ? round2(netRentalRevenue / (ageYears as number)) : null;

  const annualRoiPct =
    hasCost && annualizedNetRevenue != null && annualDepreciation != null
      ? round1(((annualizedNetRevenue - annualDepreciation) / cost) * 100)
      : null;

  return {
    ageYears: ageYears != null ? round1(ageYears) : null,
    annualDepreciation,
    accumulatedDepreciation,
    bookValue,
    paybackPct,
    annualizedNetRevenue,
    annualRoiPct,
    isPaidBack: paybackPct != null && paybackPct >= 100,
  };
}
