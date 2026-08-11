import { describe, expect, it } from "vitest";
import i18next from "i18next";
import { i18nError, I18nErrorInfo } from "../server/_core/i18nError";
import { formatTrpcError } from "../server/_core/trpc";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enCommon from "../client/src/i18n/locales/en/common.json";

/**
 * First end-to-end slice of the server-error i18n migration: customers.router.
 * Proves the whole chain for a migrated error —
 *   i18nError() → cause → formatTrpcError forwards key into data → i18next renders
 * — and that the English message survives as the fallback / log source.
 */

// The customer errors migrated in this slice, with the key each was given.
const MIGRATED = [
  { key: "errors.customer.tooManyLookups", en: "Too many lookups. Please wait a few minutes and try again." },
  { key: "errors.customer.emailExists", en: "Customer with this email already exists" },
  { key: "errors.customer.blacklistSuperAdminOnly", en: "Only super_admin can manage customer blacklist." },
  { key: "errors.customer.creditLimitDisabled", en: "Credit limit feature is not enabled." },
  { key: "errors.customer.notFound", en: "Customer not found." },
  { key: "errors.customer.creditLimitSuperAdminOnly", en: "Only super_admin can set credit limits." },
  { key: "errors.customer.hasActiveRentals", en: "Cannot delete customer with active rentals. Complete or cancel them first." },
];

const makeI18n = async (lng: "zh" | "en") => {
  const inst = i18next.createInstance();
  await inst.init({
    lng,
    resources: { zh: { common: zhCommon }, en: { common: enCommon } },
    interpolation: { escapeValue: false },
  });
  return inst;
};

describe("customers.router error i18n slice", () => {
  it("every migrated key exists in both zh and en", () => {
    for (const { key } of MIGRATED) {
      expect(zhCommon, `zh missing ${key}`).toHaveProperty(key);
      expect(enCommon, `en missing ${key}`).toHaveProperty(key);
    }
  });

  it("i18nError keeps the English message and carries the key on cause", () => {
    const err = i18nError({
      code: "CONFLICT",
      message: "Customer with this email already exists",
      i18nKey: "errors.customer.emailExists",
    });
    // Message unchanged: it is still the fallback and the log line.
    expect(err.message).toBe("Customer with this email already exists");
    expect(err.cause).toBeInstanceOf(I18nErrorInfo);
    expect((err.cause as I18nErrorInfo).i18nKey).toBe("errors.customer.emailExists");
  });

  it("errorFormatter forwards the key into error.data for the client", () => {
    const err = i18nError({
      code: "NOT_FOUND",
      message: "Customer not found.",
      i18nKey: "errors.customer.notFound",
    });
    const shape = { message: err.message, data: { code: "NOT_FOUND" } as Record<string, unknown> };
    const formatted = formatTrpcError(shape, err, false);
    expect(formatted.data.i18nKey).toBe("errors.customer.notFound");
  });

  it("renders each migrated error in Chinese, never leaking the key", async () => {
    const zh = await makeI18n("zh");
    for (const { key } of MIGRATED) {
      const text = zh.t(key, { ns: "common" });
      expect(text, `${key} not translated`).not.toBe(key);
      expect(text).not.toContain("errors.customer");
      // zh values must actually be Chinese, not the English string copied over.
      expect(text, `${key} looks untranslated`).toMatch(/[一-鿿]/);
    }
  });

  it("English locale matches the server fallback message verbatim", async () => {
    const en = await makeI18n("en");
    for (const { key, en: english } of MIGRATED) {
      expect(en.t(key, { ns: "common" })).toBe(english);
    }
  });
});

// Second slice: rentalPrepayments.router (payment errors, incl. an interpolated one).
const PREPAYMENT = [
  "errors.rentalNotFound",
  "errors.amountMustBePositive",
  "errors.prepayment.invoiceNotOnOrder",
  "errors.prepayment.notFound",
  "errors.prepayment.noOverpayment",
  "errors.prepayment.refundExceedsOwed",
];

describe("rentalPrepayments.router error i18n slice", () => {
  it("every migrated key exists in both zh and en", () => {
    for (const key of PREPAYMENT) {
      expect(zhCommon, `zh missing ${key}`).toHaveProperty(key);
      expect(enCommon, `en missing ${key}`).toHaveProperty(key);
    }
  });

  it("renders in Chinese without leaking the key", async () => {
    const zh = await makeI18n("zh");
    for (const key of PREPAYMENT) {
      const text = zh.t(key, { ns: "common", amount: "12.34" });
      expect(text).not.toContain("errors.");
      expect(text, `${key} looks untranslated`).toMatch(/[一-鿿]/);
    }
  });

  it("interpolates the refund amount into the message (both languages)", async () => {
    const zh = await makeI18n("zh");
    const en = await makeI18n("en");
    const params = { ns: "common", amount: "42.50" } as const;
    // The value must land inside the sentence, and the placeholder must be gone.
    expect(zh.t("errors.prepayment.refundExceedsOwed", params)).toContain("42.50");
    expect(zh.t("errors.prepayment.refundExceedsOwed", params)).not.toContain("{{amount}}");
    expect(en.t("errors.prepayment.refundExceedsOwed", params)).toBe(
      "Refund exceeds the amount owed to the customer (42.50)",
    );
  });
});
