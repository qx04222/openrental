/**
 * Pure-function tests for checkCredit.
 */
import { describe, it, expect } from "vitest";
import { checkCredit } from "../server/services/creditEnforcement";

const makeCustomer = (
  overrides: Partial<{ isBlacklisted: boolean; blacklistReason: string | null; creditLimit: string | null }> = {},
) => ({
  id: 1,
  isBlacklisted: false,
  blacklistReason: null,
  creditLimit: null,
  ...overrides,
});

describe("checkCredit", () => {
  it("allows when customer has no credit limit and is not blacklisted", () => {
    const result = checkCredit({
      customer: makeCustomer(),
      newOrderAmount: 1000,
      currentOutstanding: 500,
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects blacklisted customer with code 'blacklisted'", () => {
    const result = checkCredit({
      customer: makeCustomer({ isBlacklisted: true, blacklistReason: "Fraud" }),
      newOrderAmount: 0,
      currentOutstanding: 0,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("blacklisted");
      expect(result.message).toContain("Fraud");
    }
  });

  it("rejects when outstanding + new order exceeds limit", () => {
    const result = checkCredit({
      customer: makeCustomer({ creditLimit: "1000" }),
      newOrderAmount: 600,
      currentOutstanding: 500,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("over_limit");
      expect(result.message).toContain("500.00");
      expect(result.message).toContain("600.00");
      expect(result.message).toContain("1000.00");
    }
  });

  it("allows when outstanding + new order equals limit exactly", () => {
    const result = checkCredit({
      customer: makeCustomer({ creditLimit: "1000" }),
      newOrderAmount: 500,
      currentOutstanding: 500,
    });
    // 500 + 500 = 1000, which is NOT greater than 1000, so allowed
    expect(result.allowed).toBe(true);
  });

  it("allows when super_admin override is true despite blacklist", () => {
    const result = checkCredit(
      {
        customer: makeCustomer({ isBlacklisted: true, blacklistReason: "Test" }),
        newOrderAmount: 5000,
        currentOutstanding: 9999,
      },
      true, // override
    );
    expect(result.allowed).toBe(true);
  });

  it("rejects blacklisted customer with zero order amount", () => {
    const result = checkCredit({
      customer: makeCustomer({ isBlacklisted: true, blacklistReason: "Unpaid" }),
      newOrderAmount: 0,
      currentOutstanding: 0,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("blacklisted");
    }
  });

  it("allows when customer is null (guest checkout)", () => {
    const result = checkCredit({
      customer: null,
      newOrderAmount: 5000,
      currentOutstanding: 0,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows when limit is null (unlimited) regardless of amounts", () => {
    const result = checkCredit({
      customer: makeCustomer({ creditLimit: null }),
      newOrderAmount: 999999,
      currentOutstanding: 999999,
    });
    expect(result.allowed).toBe(true);
  });
});
