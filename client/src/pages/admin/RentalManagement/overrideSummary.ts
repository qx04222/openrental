import { PRICE_OVERRIDE_FIELDS, type PriceOverrideField, type PriceOverrideDiff } from "@shared/priceOverride";
import { translateDynamic, type RuntimeTranslator } from "@/lib/i18nHelpers";

/** Localized label for a money component (reuses management.overrideField.* keys). */
export function overrideFieldLabel(field: PriceOverrideField, t: RuntimeTranslator): string {
  return translateDynamic(t, `management.overrideField.${field}`);
}

/** Components present in the diff, in canonical display order. */
export function overrideFieldsInOrder(fields: PriceOverrideDiff): PriceOverrideField[] {
  return PRICE_OVERRIDE_FIELDS.filter((f) => fields[f] != null);
}

/** Comma-joined component names, e.g. "运费、税费" / "Freight, Tax". For the list badge tooltip. */
export function overrideFieldNames(
  fields: PriceOverrideDiff | null | undefined,
  t: RuntimeTranslator,
): string {
  if (!fields) return "";
  return overrideFieldsInOrder(fields)
    .map((f) => overrideFieldLabel(f, t))
    .join("、");
}

/** Per-component "label  from → to" lines, e.g. "运费 $335.00 → $285.00". For the detail page. */
export function overrideFieldLines(
  fields: PriceOverrideDiff | null | undefined,
  t: RuntimeTranslator,
  fmt: (n: number) => string,
): Array<{ field: PriceOverrideField; label: string; from: string; to: string }> {
  if (!fields) return [];
  return overrideFieldsInOrder(fields).map((f) => {
    const d = fields[f]!;
    const num = (v: string | null) => (v == null || v === "" ? "—" : fmt(Number(v)));
    return { field: f, label: overrideFieldLabel(f, t), from: num(d.from), to: num(d.to) };
  });
}
