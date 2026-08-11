/**
 * Pricing Resolution Service
 * Resolves effective rates using a waterfall:
 *   1. rentalFleet rate (non-null, > 0) → asset override
 *   2. equipmentModels rate → category standard
 *   3. fallback → "0" (no pricing set)
 */

export interface RateFields {
  dailyRate?: string | null;
  weeklyRate?: string | null;
  monthlyRate?: string | null;
  twentyEightDayRate?: string | null;
}

export interface ResolvedRates {
  dailyRate: string;
  weeklyRate: string;
  monthlyRate: string;
  twentyEightDayRate?: string;
  source: "asset_override" | "category" | "none";
}

function isValidRate(rate: string | null | undefined): rate is string {
  if (!rate) return false;
  const n = parseFloat(rate);
  return !isNaN(n) && n > 0;
}

/**
 * Resolve pricing from fleet (asset-level override) and model (category-level).
 * Fleet rates take precedence when non-null and > 0.
 */
export function resolvePricing(
  fleet: RateFields,
  model?: RateFields | null,
): ResolvedRates {
  // Check if fleet has any valid rate (asset override)
  const hasFleetRate =
    isValidRate(fleet.dailyRate) ||
    isValidRate(fleet.weeklyRate) ||
    isValidRate(fleet.monthlyRate);

  if (hasFleetRate) {
    return {
      dailyRate: fleet.dailyRate || "0",
      weeklyRate: fleet.weeklyRate || "0",
      monthlyRate: fleet.monthlyRate || "0",
      twentyEightDayRate: fleet.twentyEightDayRate || undefined,
      source: "asset_override",
    };
  }

  // Fall back to model (category) rates
  if (model) {
    const hasModelRate =
      isValidRate(model.dailyRate) ||
      isValidRate(model.weeklyRate) ||
      isValidRate(model.monthlyRate);

    if (hasModelRate) {
      return {
        dailyRate: model.dailyRate || "0",
        weeklyRate: model.weeklyRate || "0",
        monthlyRate: model.monthlyRate || "0",
        twentyEightDayRate: model.twentyEightDayRate || undefined,
        source: "category",
      };
    }
  }

  // No pricing found
  return {
    dailyRate: "0",
    weeklyRate: "0",
    monthlyRate: "0",
    source: "none",
  };
}
