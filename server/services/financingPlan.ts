/**
 * Financing Plan — fleet valuation + 0%-interest monthly-payment scenarios.
 *
 * Pure math (no DB) so it is unit-testable in isolation; the reports router
 * supplies the fleet units (each unit's acquisition value + its idle tier) and
 * the configurable financing terms, then renders the result.
 *
 * `purchaseCost` here is ALREADY the financed basis (Rental Company Financing =
 * Unit Cash Cost × 1.30 — see sql/135 and CLAUDE.md), so the monthly payment is
 * simply total ÷ term with NO interest and NO extra markup. Three exclusion
 * scenarios mirror the office spreadsheet: keep everything, drop the fully-idle
 * (Tier1), drop fully-idle + barely-used (Tier1 + Tier2).
 */

export type IdleTier = "tier1" | "tier2" | "normal";

/** Below this many rented days in the window, a unit is "barely used" (Tier2). */
export const TIER2_MAX_DAYS = 4;
/** …and only if it had at most this many orders in the window. */
export const TIER2_MAX_ORDERS = 1;

/**
 * Classify a unit's idleness over the analysis window.
 *   Tier1 = fully idle: 0 rented days in the window.
 *   Tier2 = barely used: < TIER2_MAX_DAYS rented days AND ≤ TIER2_MAX_ORDERS orders.
 *   normal = everything else.
 */
export function classifyIdleTier(input: { rentedDays: number; rentalCount: number }): IdleTier {
  const { rentedDays, rentalCount } = input;
  if (rentedDays <= 0) return "tier1";
  if (rentedDays < TIER2_MAX_DAYS && rentalCount <= TIER2_MAX_ORDERS) return "tier2";
  return "normal";
}

export interface FinancingUnit {
  /** Acquisition value (financed basis). Units with null/0 contribute 0. */
  purchaseCost: number | null;
  tier: IdleTier;
}

export interface FinancingScenarioTerm {
  /** Term length in months (e.g. 36, 48). */
  months: number;
  /** 0%-interest monthly payment = totalValue / months. */
  monthly: number;
  /** Monthly saving versus the "current" (keep-all) scenario at the same term. */
  savingVsCurrent: number;
}

export interface FinancingScenario {
  /** Stable key: 'current' | 'exTier1' | 'exTier1Tier2'. */
  key: "current" | "exTier1" | "exTier1Tier2";
  /** Number of units kept in this scenario. */
  unitCount: number;
  /** Summed acquisition value of the kept units. */
  totalValue: number;
  /** One entry per configured term. */
  terms: FinancingScenarioTerm[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const cost = (u: FinancingUnit) => (u.purchaseCost != null && u.purchaseCost > 0 ? u.purchaseCost : 0);
const sumCost = (units: FinancingUnit[]) => round2(units.reduce((s, u) => s + cost(u), 0));

/**
 * Build the three exclusion scenarios across every configured term.
 * `termsMonths` is sanitized (positive integers, deduped); empty → [].
 */
export function buildFinancingScenarios(input: {
  units: FinancingUnit[];
  termsMonths: number[];
}): FinancingScenario[] {
  const terms = [...new Set(input.termsMonths.filter((m) => Number.isFinite(m) && m > 0))].sort(
    (a, b) => a - b,
  );

  const current = input.units;
  const exTier1 = current.filter((u) => u.tier !== "tier1");
  const exTier1Tier2 = current.filter((u) => u.tier !== "tier1" && u.tier !== "tier2");

  // Current-scenario monthly per term, used as the baseline for "saving".
  const currentTotal = sumCost(current);
  const currentMonthlyByTerm = new Map<number, number>(
    terms.map((m) => [m, round2(currentTotal / m)]),
  );

  const make = (key: FinancingScenario["key"], units: FinancingUnit[]): FinancingScenario => {
    const totalValue = sumCost(units);
    return {
      key,
      unitCount: units.length,
      totalValue,
      terms: terms.map((months) => {
        const monthly = round2(totalValue / months);
        return {
          months,
          monthly,
          savingVsCurrent: round2((currentMonthlyByTerm.get(months) ?? monthly) - monthly),
        };
      }),
    };
  };

  return [
    make("current", current),
    make("exTier1", exTier1),
    make("exTier1Tier2", exTier1Tier2),
  ];
}
