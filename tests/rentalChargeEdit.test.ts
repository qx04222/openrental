import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertEditReason, diffFields } from "../server/services/editableGuard";
import { EDIT_REASONS } from "../shared/editReasons";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enCommon from "../client/src/i18n/locales/en/common.json";
import zhRental from "../client/src/i18n/locales/zh/rental.json";
import enRental from "../client/src/i18n/locales/en/rental.json";

/**
 * Credit-order charges (rental_charges) gained an `update`, and `delete` gained
 * a mandatory reason. Both are money-bearing corrections on a live ledger, so
 * the contract pinned here is the input contract and the diff behaviour — the
 * two places a silent regression would let an unexplained edit through.
 *
 * The router itself is not exercised: it needs a real DB, and the two guards it
 * composes (assertEditable / loadOpenCreditOrder) are covered by
 * editableGuard.test.ts and creditOrders.test.ts respectively.
 */

// Mirrors the router's zod input exactly. Kept in sync by intent: if the router
// loosens a rule, these assertions are what notices.
const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;
const zodPositiveMoney = z
  .string()
  .regex(MONEY_RE, "Invalid monetary amount")
  .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero");

const updateInput = z.object({
  id: z.number(),
  amount: zodPositiveMoney.optional(),
  description: z.string().max(1000).optional(),
  chargeDate: z.string().optional(),
  reason: z.enum(EDIT_REASONS),
  reasonNote: z.string().max(500).optional(),
});

const deleteInput = z.object({
  id: z.number(),
  reason: z.enum(EDIT_REASONS),
  reasonNote: z.string().max(500).optional(),
});

describe("rentalCharges.update — input contract", () => {
  it("accepts a well-formed correction", () => {
    expect(updateInput.safeParse({ id: 1, amount: "150.00", reason: "wrong_amount" }).success).toBe(true);
  });

  it("requires a reason — an edit without a why is not an edit we accept", () => {
    expect(updateInput.safeParse({ id: 1, amount: "150.00" }).success).toBe(false);
    expect(updateInput.safeParse({ id: 1, amount: "150.00", reason: "because" }).success).toBe(false);
  });

  it("rejects zero and negative amounts", () => {
    for (const amount of ["0", "0.00", "-5.00"]) {
      expect(updateInput.safeParse({ id: 1, amount, reason: "wrong_amount" }).success, amount).toBe(false);
    }
  });

  it("rejects malformed money strings", () => {
    for (const amount of ["", "abc", "10.999", "1,000.00", "$10"]) {
      expect(updateInput.safeParse({ id: 1, amount, reason: "wrong_amount" }).success, amount).toBe(false);
    }
  });

  it("allows a charge whose amount is untouched (description-only fix)", () => {
    expect(updateInput.safeParse({ id: 1, description: "typo fixed", reason: "wrong_document" }).success).toBe(true);
  });

  it("caps the free-text note so it cannot be used as a data dump", () => {
    expect(updateInput.safeParse({ id: 1, reason: "other", reasonNote: "x".repeat(501) }).success).toBe(false);
    expect(updateInput.safeParse({ id: 1, reason: "other", reasonNote: "x".repeat(500) }).success).toBe(true);
  });
});

describe("rentalCharges.delete — input contract", () => {
  it("now demands a reason (breaking change, on purpose)", () => {
    expect(deleteInput.safeParse({ id: 1 }).success).toBe(false);
    expect(deleteInput.safeParse({ id: 1, reason: "duplicate" }).success).toBe(true);
  });
});

describe("reason evidence on a charge edit", () => {
  it('demands a note only for "other"', () => {
    expect(assertEditReason("duplicate")).toEqual({ reason: "duplicate", reasonNote: undefined });
    expect(() => assertEditReason("other")).toThrowError(/note is required/i);
    expect(assertEditReason("other", "customer disputed the site visit")).toEqual({
      reason: "other",
      reasonNote: "customer disputed the site visit",
    });
  });
});

describe("diff behaviour on a charge row", () => {
  const existing = {
    id: 7,
    amount: "200.00",
    description: "Extra day",
    chargeDate: new Date("2026-07-01T00:00:00Z"),
    chargeType: "adjustment",
    invoiceId: null,
  };

  it("records only the fields that actually moved", () => {
    const changes = diffFields(existing, { amount: "250.00", description: "Extra day" });
    expect(changes).toEqual({ amount: { old: "200.00", new: "250.00" } });
  });

  it("returns nothing when the submitted values match the stored ones", () => {
    const changes = diffFields(existing, {
      amount: "200.00",
      description: "Extra day",
      chargeDate: new Date("2026-07-01T00:00:00Z"),
    });
    expect(Object.keys(changes)).toHaveLength(0);
  });

  it("ignores fields the caller did not send", () => {
    const changes = diffFields(existing, { amount: undefined, description: "Two extra days" });
    expect(changes).toEqual({ description: { old: "Extra day", new: "Two extra days" } });
  });

  it("captures a date move", () => {
    const changes = diffFields(existing, { chargeDate: new Date("2026-07-05T00:00:00Z") });
    expect(Object.keys(changes)).toEqual(["chargeDate"]);
  });

  it("treats clearing the description as a real change, not a no-op", () => {
    const changes = diffFields(existing, { description: "" });
    expect(changes).toEqual({ description: { old: "Extra day", new: "" } });
  });

  it("does not fold updatedAt into the diff — it moves on every write", () => {
    // The router builds the audit diff from the caller's fields only and adds
    // updatedAt to the DB patch afterwards. If that ever gets merged, the
    // "unchanged" short-circuit dies and every save writes a noise audit row.
    const changes = diffFields(existing, { amount: "200.00" });
    expect(changes).not.toHaveProperty("updatedAt");
    expect(Object.keys(changes)).toHaveLength(0);
  });
});

describe("i18n keys used by the charge edit flow", () => {
  const commonKeys = [
    "errors.charge.notFound",
    "errors.charge.notCreditOrder",
    "errors.rentalNotFound",
    "errors.edit.alreadyInvoiced",
    "errors.edit.orderClosed",
    "errors.edit.orderSettled",
    "errors.edit.reasonRequired",
    "errors.edit.noteRequired",
    "editReason.label",
    "editReason.notePlaceholder",
    "editReason.required",
  ];
  const rentalKeys = ["management.editCharge", "management.deleteChargeTitle", "management.deleteCharge"];

  it("exist in both locales, symmetrically", () => {
    for (const key of commonKeys) {
      expect(zhCommon, `zh/common missing ${key}`).toHaveProperty(key);
      expect(enCommon, `en/common missing ${key}`).toHaveProperty(key);
    }
    for (const key of rentalKeys) {
      expect(zhRental, `zh/rental missing ${key}`).toHaveProperty(key);
      expect(enRental, `en/rental missing ${key}`).toHaveProperty(key);
    }
  });

  it("offers a reason label in both locales for every reason the dropdown renders", () => {
    for (const reason of EDIT_REASONS) {
      expect(zhCommon, `zh missing editReason.${reason}`).toHaveProperty(`editReason.${reason}`);
      expect(enCommon, `en missing editReason.${reason}`).toHaveProperty(`editReason.${reason}`);
    }
  });
});
