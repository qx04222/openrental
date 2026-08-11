import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { assertEditReason, diffFields, CLOSED_RENTAL_STATUSES } from "../server/services/editableGuard";
import { EDIT_REASONS, EDIT_REASON_LABELS, isEditReason } from "../shared/editReasons";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enCommon from "../client/src/i18n/locales/en/common.json";

/**
 * Foundation for the "correct a recorded row, and say why" work. Every module
 * (extra charges, payments, work-order parts/labour, downtime) imports this, so
 * a defect here propagates everywhere — hence it is pinned before the modules
 * are wired to it.
 */

describe("edit reasons", () => {
  it("every reason has a zh and en label", () => {
    for (const reason of EDIT_REASONS) {
      expect(EDIT_REASON_LABELS[reason].zh, `${reason} missing zh`).toBeTruthy();
      expect(EDIT_REASON_LABELS[reason].en, `${reason} missing en`).toBeTruthy();
    }
  });

  it("every reason has a translation key in both locales", () => {
    for (const reason of EDIT_REASONS) {
      const key = `editReason.${reason}`;
      expect(zhCommon, `zh missing ${key}`).toHaveProperty(key);
      expect(enCommon, `en missing ${key}`).toHaveProperty(key);
    }
  });

  it("rejects values that are not reasons", () => {
    expect(isEditReason("wrong_amount")).toBe(true);
    expect(isEditReason("made_up")).toBe(false);
    expect(isEditReason("")).toBe(false);
    expect(isEditReason(undefined)).toBe(false);
  });
});

describe("assertEditReason", () => {
  it("accepts a known reason", () => {
    expect(assertEditReason("wrong_amount")).toEqual({ reason: "wrong_amount", reasonNote: undefined });
  });

  it("refuses a missing or unknown reason — the why is mandatory", () => {
    expect(() => assertEditReason("")).toThrowError(/reason is required/i);
    expect(() => assertEditReason("nonsense")).toThrowError(/reason is required/i);
  });

  it('requires a note when the reason is "other"', () => {
    expect(() => assertEditReason("other")).toThrowError(/note is required/i);
    expect(() => assertEditReason("other", "   ")).toThrowError(/note is required/i);
    expect(assertEditReason("other", " customer called ")).toEqual({
      reason: "other",
      reasonNote: "customer called",
    });
  });

  it("surfaces as a typed TRPCError so the client can translate it", () => {
    try {
      assertEditReason("nonsense");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("BAD_REQUEST");
    }
  });
});

describe("diffFields", () => {
  it("records only what actually changed", () => {
    const diff = diffFields(
      { amount: "36.00", description: "fuel", chargeType: "fuel" },
      { amount: "0.00", description: "fuel" },
    );
    expect(diff).toEqual({ amount: { old: "36.00", new: "0.00" } });
  });

  it("compares by value, so 36 and '36' are not a change", () => {
    expect(diffFields({ amount: 36 }, { amount: "36" })).toEqual({});
  });

  it("ignores undefined (field not supplied) but records an explicit null", () => {
    expect(diffFields({ description: "x" }, { description: undefined })).toEqual({});
    expect(diffFields({ description: "x" }, { description: null })).toEqual({
      description: { old: "x", new: null },
    });
  });
});

describe("closed-order rule", () => {
  it("treats completed and cancelled as closed", () => {
    expect([...CLOSED_RENTAL_STATUSES].sort()).toEqual(["cancelled", "completed"]);
    // active / overdue / pending stay editable — that is the whole point of the
    // rule: corrections are allowed while the order is still running.
    for (const open of ["active", "overdue", "pending", "approved"]) {
      expect(CLOSED_RENTAL_STATUSES as readonly string[]).not.toContain(open);
    }
  });
});
