import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  CHILD_PURGE_MAP,
  isForeignKeyViolation,
  rethrowAsReadable,
} from "../server/routers/recycleBin.router";

/**
 * The recycle-bin purge path had zero test coverage, and both of the P0s found
 * by the last two audits lived on it. These lock in the two decisions that keep
 * it safe:
 *
 *  1. Financial/audit children are RESTRICT so the purge CANNOT destroy them —
 *     they must never be added to CHILD_PURGE_MAP as a "fix" for the delete
 *     failing. The failure IS the feature.
 *  2. When the database refuses, the operator gets a reason, not a SQLSTATE.
 */

const pgFkError = (fields: { table_name?: string; constraint_name?: string }) => ({
  code: "23503",
  detail: 'Key (id)=(216) is still referenced from table "rental_prepayments".',
  ...fields,
});

describe("recycle-bin purge: protected children are never purged", () => {
  it("CHILD_PURGE_MAP only ever purges line-item tables", () => {
    const purged = Object.values(CHILD_PURGE_MAP)
      .flat()
      .map((c) => c!.table);

    // Line items are safe to purge: they are part of the parent document.
    expect(purged.sort()).toEqual([
      "invoice_line_items",
      "quotation_line_items",
      "rental_line_items",
    ]);
  });

  it("never purges tables that carry money or audit history", () => {
    const purged = Object.values(CHILD_PURGE_MAP)
      .flat()
      .map((c) => c!.table);

    // Adding any of these would make "permanent delete" destroy the exact
    // records their RESTRICT FK exists to protect. See sql/095 and sql/146.
    for (const protectedTable of [
      "rental_prepayments", // real customer payments
      "rental_charges", // credit-order charges
      "payments", // real payments
      "login_sessions", // login audit trail
      "rental_lifecycle_effects",
      "rental_rolling_terms",
      "rental_asset_return_operations",
    ]) {
      expect(purged).not.toContain(protectedTable);
    }
  });
});

describe("23503 is translated into an actionable reason", () => {
  it("recognises a Postgres FK violation and nothing else", () => {
    expect(isForeignKeyViolation(pgFkError({ table_name: "rental_prepayments" }))).toBe(true);
    expect(isForeignKeyViolation({ code: "23505" })).toBe(false); // unique violation
    expect(isForeignKeyViolation(new Error("boom"))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
  });

  it("names the blocking table and why it is protected", () => {
    expect(() =>
      rethrowAsReadable(pgFkError({ table_name: "rental_prepayments" }), "rental"),
    ).toThrowError(/recorded customer payments \(rental_prepayments\)/);
  });

  it("resolves the table from the constraint name when table_name is absent", () => {
    // postgres-js does not always populate table_name; constraint names follow
    // the "<table>_<column>_fkey" convention.
    expect(() =>
      rethrowAsReadable(
        pgFkError({ constraint_name: "rental_prepayments_rentalRequestId_fkey" }),
        "rental",
      ),
    ).toThrowError(/recorded customer payments/);
  });

  it("degrades to naming the table when the blocker is unknown", () => {
    expect(() =>
      rethrowAsReadable(pgFkError({ table_name: "some_future_table" }), "rental"),
    ).toThrowError(/linked records in some_future_table/);
  });

  it("surfaces as PRECONDITION_FAILED, not a 500", () => {
    try {
      rethrowAsReadable(pgFkError({ table_name: "payments" }), "invoice");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
    }
  });

  it("rethrows non-FK errors untouched so real failures are not masked", () => {
    const original = new Error("connection reset");
    expect(() => rethrowAsReadable(original, "rental")).toThrowError(original);

    const uniqueViolation = { code: "23505", constraint_name: "invoices_invoiceNumber_key" };
    expect(() => rethrowAsReadable(uniqueViolation, "invoice")).toThrow();
    try {
      rethrowAsReadable(uniqueViolation, "invoice");
    } catch (err) {
      expect(err).not.toBeInstanceOf(TRPCError); // passed through, not translated
    }
  });
});
