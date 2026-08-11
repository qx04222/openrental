import { z } from "zod";

/**
 * Single source of truth for payment methods.
 *
 * The canonical set mirrors the strict Postgres enum `paymentMethodEnum`
 * (drizzle/schema.ts) used by the invoice `payments` table — a hard PG enum that
 * cannot accept loose values. `rental_prepayments.paymentMethod` is an
 * unconstrained varchar(40) that already accepts these strings, so converging
 * both the invoice flow and the prepayment flow onto this set needs NO schema
 * migration. Legacy prepayment rows may still hold "etransfer"/"card"; those are
 * normalized for display via {@link normalizePaymentMethod}.
 *
 * i18nKey points at the existing `invoices.method*` admin bundle keys (en + zh),
 * which already cover all six values — so both forms share one translation set.
 */
export const PAYMENT_METHODS = [
  { value: "cash", i18nKey: "invoices.methodCash" },
  { value: "cheque", i18nKey: "invoices.methodCheque" },
  { value: "e_transfer", i18nKey: "invoices.methodETransfer" },
  { value: "credit_card", i18nKey: "invoices.methodCreditCard" },
  { value: "bank_transfer", i18nKey: "invoices.methodBankTransfer" },
  { value: "other", i18nKey: "invoices.methodOther" },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["value"];
export type PaymentMethodI18nKey = (typeof PAYMENT_METHODS)[number]["i18nKey"];

/** The canonical values, in display order. Must match `paymentMethodEnum.enumValues`. */
export const PAYMENT_METHOD_VALUES = PAYMENT_METHODS.map((m) => m.value) as readonly PaymentMethod[];

export const paymentMethodSchema = z.enum([
  "cash",
  "cheque",
  "e_transfer",
  "credit_card",
  "bank_transfer",
  "other",
]);

/**
 * Map any stored payment-method string to a canonical value for display.
 * Translates legacy prepayment values ("etransfer" → "e_transfer",
 * "card" → "credit_card") and falls back to "other" for anything unknown.
 * Returns null only for an empty/missing value.
 */
export function normalizePaymentMethod(raw: string | null | undefined): PaymentMethod | null {
  if (!raw) return null;
  switch (raw) {
    case "etransfer":
      return "e_transfer";
    case "card":
      return "credit_card";
    case "cash":
    case "cheque":
    case "e_transfer":
    case "credit_card":
    case "bank_transfer":
    case "other":
      return raw;
    default:
      return "other";
  }
}

/** i18n key for a (possibly legacy) stored method value, or null if empty. */
export function paymentMethodI18nKey(method: string | null | undefined): PaymentMethodI18nKey | null {
  const norm = normalizePaymentMethod(method);
  if (!norm) return null;
  return PAYMENT_METHODS.find((m) => m.value === norm)!.i18nKey;
}
