/**
 * Credit enforcement — pure business logic, no I/O.
 * Call checkCredit before creating a rental when the credit_limit feature flag
 * is enabled.
 */

export interface CreditCheckInput {
  customer: {
    id: number;
    isBlacklisted: boolean;
    blacklistReason: string | null;
    creditLimit: string | null; // stored as NUMERIC string from Drizzle
  } | null;
  newOrderAmount: number;
  currentOutstanding: number; // sum of unpaid invoice balances for customer
}

export type CreditCheckResult =
  | { allowed: true }
  | {
      allowed: false;
      code: "blacklisted" | "over_limit";
      message: string;
      currentOutstanding?: number;
      newOrderAmount?: number;
      creditLimit?: number;
    };

/**
 * Check whether a new rental is allowed given the customer's credit state.
 *
 * @param input   Credit check inputs.
 * @param override When true (and caller has verified super_admin role),
 *                 the check is bypassed and allowed: true is always returned.
 */
export function checkCredit(
  input: CreditCheckInput,
  override = false,
): CreditCheckResult {
  if (override) {
    return { allowed: true };
  }

  const { customer, newOrderAmount, currentOutstanding } = input;

  if (!customer) {
    // No customer record — allow (guest checkout path).
    return { allowed: true };
  }

  if (customer.isBlacklisted) {
    const reason = customer.blacklistReason ?? "No reason provided.";
    return {
      allowed: false,
      code: "blacklisted",
      message: `This customer is blacklisted: ${reason}`,
    };
  }

  if (customer.creditLimit !== null) {
    const limit = parseFloat(customer.creditLimit);
    if (!isNaN(limit)) {
      const projected = currentOutstanding + newOrderAmount;
      if (projected > limit) {
        return {
          allowed: false,
          code: "over_limit",
          message: `Credit limit exceeded: current balance $${currentOutstanding.toFixed(2)} + this order $${newOrderAmount.toFixed(2)} exceeds limit $${limit.toFixed(2)}`,
          currentOutstanding,
          newOrderAmount,
          creditLimit: limit,
        };
      }
    }
  }

  return { allowed: true };
}
