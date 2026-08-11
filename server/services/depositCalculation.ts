import { getDb, isNull, asc } from "../db";
import * as schema from "../../drizzle/schema";

export interface DepositResult {
  deposit: number;
  rule: string;
  breakdown: string;
}

export async function calculateDepositFromRules(
  category: string | null | undefined,
  msrp: number | null | undefined,
): Promise<DepositResult> {
  const db = await getDb();
  if (!db) return { deposit: 0, rule: "none", breakdown: "Database not available" };

  // Find matching rule: exact category match first, then "*" fallback
  const rules = await db
    .select()
    .from(schema.depositRules)
    .where(isNull(schema.depositRules.deletedAt))
    .orderBy(asc(schema.depositRules.priority));

  // Try exact category match first
  let matchedRule = category
    ? rules.find(r => r.category.toLowerCase() === category.toLowerCase())
    : null;

  // Fallback to wildcard
  if (!matchedRule) {
    matchedRule = rules.find(r => r.category === "*");
  }

  if (!matchedRule) {
    // Ultimate fallback: 20% or $5000
    const fallback = msrp && msrp > 0 ? Math.round(msrp * 0.2 * 100) / 100 : 5000;
    return { deposit: fallback, rule: "default", breakdown: "No matching rule, using fallback" };
  }

  const depositType = matchedRule.depositType;
  const value = parseFloat(matchedRule.value);
  const minDeposit = parseFloat(matchedRule.minDeposit);
  const maxDeposit = matchedRule.maxDeposit ? parseFloat(matchedRule.maxDeposit) : null;

  let deposit: number;
  let breakdown: string;

  if (depositType === "percentage") {
    if (!msrp || msrp <= 0) {
      deposit = minDeposit;
      breakdown = `${matchedRule.category}: No MSRP available, using minimum $${minDeposit.toLocaleString()}`;
    } else {
      deposit = Math.round(msrp * value * 100) / 100;
      breakdown = `${matchedRule.category}: ${(value * 100).toFixed(0)}% of $${msrp.toLocaleString()} = $${deposit.toLocaleString()}`;
      // Clamp
      if (deposit < minDeposit) {
        deposit = minDeposit;
        breakdown += ` (raised to min $${minDeposit.toLocaleString()})`;
      }
      if (maxDeposit && deposit > maxDeposit) {
        deposit = maxDeposit;
        breakdown += ` (capped at max $${maxDeposit.toLocaleString()})`;
      }
    }
  } else {
    // Fixed
    deposit = value;
    breakdown = `${matchedRule.category}: Fixed deposit $${value.toLocaleString()}`;
  }

  return {
    deposit: Math.round(deposit * 100) / 100,
    rule: `${matchedRule.category} (priority ${matchedRule.priority})`,
    breakdown,
  };
}
