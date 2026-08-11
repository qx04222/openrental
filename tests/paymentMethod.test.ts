import { describe, it, expect } from "vitest";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  paymentMethodSchema,
  normalizePaymentMethod,
  paymentMethodI18nKey,
} from "../shared/paymentMethod";
import { paymentMethodEnum } from "../drizzle/schema";

describe("shared/paymentMethod", () => {
  it("★ canonical values stay in lock-step with the Postgres enum (drift guard)", () => {
    // If these diverge, rental_prepayments / payments writes can fail or the
    // dropdowns offer values the DB enum rejects. Keep them identical & ordered.
    expect([...PAYMENT_METHOD_VALUES]).toEqual([...paymentMethodEnum.enumValues]);
  });

  it("schema accepts every canonical value and rejects legacy/unknown ones", () => {
    for (const v of PAYMENT_METHOD_VALUES) {
      expect(paymentMethodSchema.safeParse(v).success).toBe(true);
    }
    expect(paymentMethodSchema.safeParse("etransfer").success).toBe(false);
    expect(paymentMethodSchema.safeParse("card").success).toBe(false);
    expect(paymentMethodSchema.safeParse("bitcoin").success).toBe(false);
  });

  it("normalizePaymentMethod maps legacy prepayment values to canonical", () => {
    expect(normalizePaymentMethod("etransfer")).toBe("e_transfer");
    expect(normalizePaymentMethod("card")).toBe("credit_card");
  });

  it("normalizePaymentMethod passes through canonical values unchanged", () => {
    for (const v of PAYMENT_METHOD_VALUES) {
      expect(normalizePaymentMethod(v)).toBe(v);
    }
  });

  it("normalizePaymentMethod returns null for empty, 'other' for unknown", () => {
    expect(normalizePaymentMethod(null)).toBeNull();
    expect(normalizePaymentMethod(undefined)).toBeNull();
    expect(normalizePaymentMethod("")).toBeNull();
    expect(normalizePaymentMethod("paypal")).toBe("other");
  });

  it("paymentMethodI18nKey resolves canonical + legacy to a real bundle key", () => {
    expect(paymentMethodI18nKey("e_transfer")).toBe("invoices.methodETransfer");
    expect(paymentMethodI18nKey("etransfer")).toBe("invoices.methodETransfer");
    expect(paymentMethodI18nKey("card")).toBe("invoices.methodCreditCard");
    expect(paymentMethodI18nKey(null)).toBeNull();
    // every entry resolves to a key present in PAYMENT_METHODS
    const keys = new Set(PAYMENT_METHODS.map((m) => m.i18nKey));
    for (const v of PAYMENT_METHOD_VALUES) {
      expect(keys.has(paymentMethodI18nKey(v)!)).toBe(true);
    }
  });
});
