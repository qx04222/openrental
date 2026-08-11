import { describe, expect, it } from "vitest";
import i18next from "i18next";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enCommon from "../client/src/i18n/locales/en/common.json";

/**
 * Server errors are English by construction and are shown to the user verbatim
 * (`toast.error(err.message)` in 168 places). This locks in the opt-in
 * translation path added alongside sql/146:
 *
 *   server: i18nError({ i18nKey, i18nParams })  →  error.data.i18nKey
 *   client: serverErrorText(err)                →  i18next.t(key, params)
 *
 * The interesting part is that errors.purgeBlocked composes two other keys via
 * i18next's $t() nesting. If that nesting silently fails, the user gets the raw
 * key text — worse than the English we started with — so it is asserted here
 * rather than assumed.
 */

const makeI18n = async (lng: "zh" | "en") => {
  const inst = i18next.createInstance();
  await inst.init({
    lng,
    resources: { zh: { common: zhCommon }, en: { common: enCommon } },
    interpolation: { escapeValue: false },
  });
  return inst;
};

describe("errors.purgeBlocked renders in the user's language", () => {
  it("composes subject + blocker into a Chinese sentence", async () => {
    const i18n = await makeI18n("zh");
    const text = i18n.t("errors.purgeBlocked", {
      ns: "common",
      subject: "rental",
      blocker: "rental_prepayments",
    });

    expect(text).toContain("该订单");
    expect(text).toContain("客户付款记录");
    // The $t() nesting must actually resolve — never leak a key at the user.
    expect(text).not.toContain("$t(");
    expect(text).not.toContain("errors.purge");
  });

  it("composes the same sentence in English", async () => {
    const i18n = await makeI18n("en");
    const text = i18n.t("errors.purgeBlocked", {
      ns: "common",
      subject: "invoice",
      blocker: "payments",
    });

    expect(text).toContain("this invoice");
    expect(text).toContain("recorded payments");
    expect(text).not.toContain("$t(");
  });

  it("covers every entity type the recycle bin can purge, plus 'all'", async () => {
    const i18n = await makeI18n("zh");
    const subjects = [
      "user", "customer", "warehouse", "fleet", "rental",
      "inspection", "dispatch", "invoice", "quotation", "all",
    ];

    for (const subject of subjects) {
      const text = i18n.t("errors.purgeBlocked", {
        ns: "common",
        subject,
        blocker: "rental_prepayments",
      });
      // A missing errors.purgeSubject.* key would leave the raw key in place.
      expect(text, `subject "${subject}" has no zh translation`).not.toContain("errors.purgeSubject");
    }
  });

  it("covers every blocker the server can name", async () => {
    const i18n = await makeI18n("zh");
    // Mirrors BLOCKER_REASONS in server/routers/recycleBin.router.ts — the server
    // only attaches the i18n hint for tables it can name, so these must all exist.
    const blockers = [
      "rental_prepayments", "rental_charges", "payments", "login_sessions",
      "rental_lifecycle_effects", "rental_rolling_terms",
      "rental_asset_return_operations", "invoice_line_items",
      "rental_line_items", "quotation_line_items", "work_order_parts",
    ];

    for (const blocker of blockers) {
      const text = i18n.t("errors.purgeBlocked", { ns: "common", subject: "rental", blocker });
      expect(text, `blocker "${blocker}" has no zh translation`).not.toContain("errors.purgeBlocker");
    }
  });

  it("keeps zh and en key sets symmetric for the errors block", () => {
    const zhKeys = Object.keys(zhCommon).filter((k) => k.startsWith("errors."));
    const enKeys = Object.keys(enCommon).filter((k) => k.startsWith("errors."));
    expect(zhKeys.sort()).toEqual(enKeys.sort());
    expect(zhKeys.length).toBeGreaterThan(0);
  });
});
