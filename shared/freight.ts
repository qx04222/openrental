/**
 * Distance-bracket freight, by the navigation driving distance from the
 * warehouse to the delivery address. Quoted prices are ROUND-TRIP
 * (deliver + pick up). A one-way leg (delivery only) is round-trip ÷ 2 × 1.15,
 * rounded to the nearest $10. Self-pickup is free. Over the max distance the
 * price must be confirmed manually with the transport department.
 *
 * All values are admin-configurable via rental_settings; the defaults here match
 * the published rate card.
 */
export interface FreightConfig {
  tier30: number;        // <= 30 km  (round-trip)
  tier45: number;        // <= 45 km
  tier60: number;        // <= 60 km
  tier75: number;        // <= 75 km
  onewayFactor: number;  // one-way = round-trip × this (default 0.5 × 1.15 = 0.575)
  maxKm: number;         // beyond this → manual quote
}

export const DEFAULT_FREIGHT_CONFIG: FreightConfig = {
  tier30: 285,
  tier45: 335,
  tier60: 385,
  tier75: 435,
  onewayFactor: 0.575,
  maxKm: 75,
};

export type FreightMethod = "pickup" | "delivery" | "delivery_and_return";

export interface FreightResult {
  /** Computed freight; 0 when manual or pickup. */
  cost: number;
  /** True when the distance exceeds maxKm — contact transport. */
  needsManual: boolean;
  /** The matched round-trip tier (for display), or null. */
  roundTripTier: number | null;
  /**
   * True when the distance could not be determined and we fell back to the
   * lowest (≤30 km) bracket. The price is charged, but staff should sanity-check
   * it against the real delivery distance.
   */
  assumedMinTier?: boolean;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Bracket freight for one delivery. distanceKm is the ONE-WAY driving distance.
 *
 * When the distance is unknown (null/NaN — e.g. Maps lookup failed or no address
 * yet), we DON'T punt to a manual quote: we charge the lowest (≤30 km) bracket
 * and flag `assumedMinTier` so the order still prices and staff can verify later.
 * A KNOWN distance beyond maxKm still requires a manual quote.
 */
export function calculateBracketFreight(
  distanceKm: number | null | undefined,
  method: FreightMethod,
  cfg: FreightConfig = DEFAULT_FREIGHT_CONFIG,
): FreightResult {
  if (method === "pickup") return { cost: 0, needsManual: false, roundTripTier: 0 };

  const unknownDistance = distanceKm == null || isNaN(distanceKm);
  if (!unknownDistance && distanceKm! > cfg.maxKm) {
    return { cost: 0, needsManual: true, roundTripTier: null };
  }

  // Unknown distance → assume the lowest (≤30 km) bracket.
  const km = unknownDistance ? 0 : distanceKm!;
  const tier = km <= 30 ? cfg.tier30
    : km <= 45 ? cfg.tier45
    : km <= 60 ? cfg.tier60
    : cfg.tier75;
  if (method === "delivery_and_return") {
    return { cost: tier, needsManual: false, roundTripTier: tier, assumedMinTier: unknownDistance };
  }
  // One-way (delivery only): round-trip ÷ 2 × 1.15, to the nearest $10.
  const oneway = roundTo(tier * cfg.onewayFactor, 10);
  return { cost: oneway, needsManual: false, roundTripTier: tier, assumedMinTier: unknownDistance };
}
