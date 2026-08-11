/**
 * Price-override transparency: when an order's price is manually overridden, we
 * record WHICH money components diverge from the system-computed price and by how
 * much, so the "改价 / Override" badge can say e.g. "freight $335 → $285" instead
 * of a bare "price overridden".
 */

/** The money components an override can touch, in display order. */
export const PRICE_OVERRIDE_FIELDS = [
  "rentalFee",
  "freightCost",
  "insuranceCost",
  "taxAmount",
  "depositAmount",
  "totalAmount",
] as const;

export type PriceOverrideField = (typeof PRICE_OVERRIDE_FIELDS)[number];

export type PriceOverrideDiff = Partial<
  Record<PriceOverrideField, { from: string | null; to: string | null }>
>;

/** Loose numeric/string equality matching the routers' String(...) comparisons. */
function sameMoney(a: string | null | undefined, b: string | null | undefined): boolean {
  const an = a == null || a === "" ? null : Number(a);
  const bn = b == null || b === "" ? null : Number(b);
  if (an != null && bn != null && !isNaN(an) && !isNaN(bn)) return an === bn;
  return String(a ?? "") === String(b ?? "");
}

/**
 * Diff the system-computed money values against the values actually stored.
 * Returns only the components that changed, or null when nothing diverges.
 */
export function computeOverrideFields(
  computed: Partial<Record<PriceOverrideField, string | null | undefined>>,
  final: Partial<Record<PriceOverrideField, string | null | undefined>>,
): PriceOverrideDiff | null {
  const diff: PriceOverrideDiff = {};
  for (const field of PRICE_OVERRIDE_FIELDS) {
    const from = computed[field];
    const to = final[field];
    // Only fields present in BOTH sides are comparable; skip an undefined `to`
    // (the caller didn't set that component).
    if (to === undefined) continue;
    if (!sameMoney(from, to)) {
      diff[field] = { from: from ?? null, to: to ?? null };
    }
  }
  return Object.keys(diff).length > 0 ? diff : null;
}
