/**
 * invoiceNumber — sequential allocation with retry-on-collision (R7-2).
 * Pure/mocked unit tests (CI-runnable, no real DB).
 */
import { describe, it, expect, vi } from "vitest";
import {
  isUniqueViolation,
  computeNextInvoiceNumber,
  insertWithInvoiceNumber,
} from "../server/services/invoiceNumber";

// Minimal chainable fake matching `db.select().from().where().orderBy().limit()`.
function fakeDb(lastNumber: string | null) {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => (lastNumber ? [{ invoiceNumber: lastNumber }] : []),
  };
  return chain;
}

describe("isUniqueViolation", () => {
  it("detects SQLSTATE 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("nope"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("computeNextInvoiceNumber", () => {
  it("starts at 0001 when none exist", async () => {
    expect(await computeNextInvoiceNumber(fakeDb(null), "FUEL-2026-")).toBe("FUEL-2026-0001");
  });
  it("increments the last sequence", async () => {
    expect(await computeNextInvoiceNumber(fakeDb("FUEL-2026-0007"), "FUEL-2026-")).toBe("FUEL-2026-0008");
  });
});

describe("insertWithInvoiceNumber", () => {
  it("retries (re-allocates) on a unique collision then succeeds", async () => {
    const db = fakeDb("FUEL-2026-0007");
    const seen: string[] = [];
    const insertFn = vi.fn(async (num: string) => {
      seen.push(num);
      if (seen.length === 1) throw { code: "23505" }; // first attempt collides
      return { id: 99, invoiceNumber: num };
    });
    const result = await insertWithInvoiceNumber(db, "FUEL-2026-", insertFn);
    expect(result).toEqual({ id: 99, invoiceNumber: "FUEL-2026-0008" });
    expect(insertFn).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-unique error without retrying", async () => {
    const db = fakeDb(null);
    const insertFn = vi.fn(async () => { throw new Error("boom"); });
    await expect(insertWithInvoiceNumber(db, "FUEL-2026-", insertFn)).rejects.toThrow("boom");
    expect(insertFn).toHaveBeenCalledTimes(1);
  });
});
