export interface DepositConfig {
  /** Multiplier applied to the after-tax (rent + insurance + freight) total. */
  multiplier: number;
  /** Round the result UP to the nearest this many dollars. */
  roundTo: number;
}

export const DEFAULT_DEPOSIT_CONFIG: DepositConfig = { multiplier: 1.5, roundTo: 50 };

/**
 * The one deposit policy. There used to be a second, day-tiered formula
 * (a fraction of the PRE-tax subtotal that shrank with duration, rounded to $10,
 * with no credit waiver) used by the price-recalculation path — so changing an
 * order's dates repriced its deposit under rules it was never quoted under, and
 * re-imposed a deposit on account customers whose terms waive it. Removed
 * 2026-07-21; this is now the only formula.
 *
 * Current deposit policy:
 *   - Account / credit customers (creditLimit > 0) → $0 (waived; on file).
 *   - Everyone else → 1.5 × after-tax (rent + insurance + freight), rounded UP
 *     to the nearest $50.
 * `afterTaxTotal` must already include tax on rent+insurance+freight (NOT the
 * refundable deposit itself).
 */
export function calculateOrderDeposit(
  afterTaxTotal: number,
  opts: { creditLimit?: number | null; config?: DepositConfig } = {},
): number {
  const creditLimit = Number(opts.creditLimit ?? 0);
  if (creditLimit > 0) return 0;
  if (!(afterTaxTotal > 0)) return 0;
  const { multiplier, roundTo } = opts.config ?? DEFAULT_DEPOSIT_CONFIG;
  return Math.ceil((afterTaxTotal * multiplier) / roundTo) * roundTo;
}
