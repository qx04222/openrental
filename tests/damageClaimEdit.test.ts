import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { assertEditReason, diffFields } from "../server/services/editableGuard";
import { EDIT_REASONS } from "../shared/editReasons";
import { EXTRA_CHARGE_REASONS } from "../shared/extraCharges";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enCommon from "../client/src/i18n/locales/en/common.json";
import zhRental from "../client/src/i18n/locales/zh/rental.json";
import enRental from "../client/src/i18n/locales/en/rental.json";

/**
 * Extra charges (damage_claims) are the charges a customer actually gets billed
 * for after the fact, so an edit here moves money. These tests pin the evidence
 * requirements the router enforces before it writes: a valid reason, a note when
 * the reason is "other", and a diff that records only what really changed.
 *
 * The DB-facing half of the gate (invoiced / order-closed) is covered by
 * tests/editableGuard.test.ts and is not duplicated here.
 */

describe("extra charge edit — reason is mandatory", () => {
  it("rejects a missing reason", () => {
    expect(() => assertEditReason("")).toThrow(TRPCError);
    expect(() => assertEditReason(undefined as unknown as string)).toThrow(TRPCError);
  });

  it("rejects a reason that is not in EDIT_REASONS", () => {
    expect(() => assertEditReason("because_i_said_so")).toThrow(TRPCError);
    // An extra-charge *reason* (why the charge exists) is not an edit reason
    // (why it was changed) — the two vocabularies must not leak into each other.
    expect(() => assertEditReason("fuel")).toThrow(TRPCError);
    expect(EXTRA_CHARGE_REASONS).not.toContain("wrong_amount");
  });

  it("rejects \"other\" without a note, accepts it with one", () => {
    expect(() => assertEditReason("other")).toThrow(TRPCError);
    expect(() => assertEditReason("other", "   ")).toThrow(TRPCError);
    expect(assertEditReason("other", "customer disputed the fuel level")).toEqual({
      reason: "other",
      reasonNote: "customer disputed the fuel level",
    });
  });

  it("accepts every non-other reason without a note", () => {
    for (const reason of EDIT_REASONS.filter((r) => r !== "other")) {
      expect(assertEditReason(reason)).toEqual({ reason, reasonNote: undefined });
    }
  });
});

describe("extra charge edit — diff records only real changes", () => {
  // Shape mirrors a damage_claims row as the router reads it (numerics are
  // strings out of postgres.js).
  const existing = {
    id: 7,
    rentalId: 42,
    chargeType: "fuel",
    amount: "120.00",
    approvedAmount: "120.00",
    repairEstimate: null,
    description: "Returned with half a tank",
    invoiceId: null,
    status: "accepted",
  };

  it("records the amount fields that moved and nothing else", () => {
    const patch = { amount: "150.00", approvedAmount: "150.00", description: existing.description, updatedAt: new Date() };
    const changes = diffFields(existing, patch);
    delete (changes as Record<string, unknown>).updatedAt;
    expect(changes).toEqual({
      amount: { old: "120.00", new: "150.00" },
      approvedAmount: { old: "120.00", new: "150.00" },
    });
    expect(changes).not.toHaveProperty("description");
  });

  it("returns an empty diff when nothing actually changed", () => {
    const changes = diffFields(existing, { amount: "120.00", description: existing.description });
    expect(Object.keys(changes)).toHaveLength(0);
  });

  it("records a chargeType switch", () => {
    const changes = diffFields(existing, { chargeType: "cleaning" });
    expect(changes).toEqual({ chargeType: { old: "fuel", new: "cleaning" } });
  });

  it("records the soft-delete diff shape the router writes", () => {
    // delete() logs { amount: { old, new: null } } so the change-history tab
    // shows the money that stopped being owed.
    const oldAmount = existing.approvedAmount ?? existing.amount ?? existing.repairEstimate ?? null;
    expect({ amount: { old: oldAmount, new: null } }).toEqual({
      amount: { old: "120.00", new: null },
    });
  });
});

describe("extra charge edit — i18n keys exist in both locales", () => {
  it("server error keys", () => {
    for (const key of ["errors.damageClaim.notFound", "errors.edit.alreadyInvoiced", "errors.amountMustBePositive"]) {
      expect(zhCommon, `zh missing ${key}`).toHaveProperty(key);
      expect(enCommon, `en missing ${key}`).toHaveProperty(key);
    }
  });

  it("UI keys for the edit/delete controls", () => {
    for (const key of [
      "management.chargeUpdated",
      "management.chargeDeleted",
      "management.chargeLockedInvoiced",
      "management.chargeLockedClosed",
      "management.confirmDeleteCharge",
    ]) {
      expect(zhRental, `zh missing ${key}`).toHaveProperty(key);
      expect(enRental, `en missing ${key}`).toHaveProperty(key);
    }
  });
});
