import { eq, and, isNull, sql } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import type { getDb } from "../db";

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Works against a transaction as well as the pooled client. */
type LedgerDb = Pick<AppDb, "select" | "insert" | "update">;

/**
 * The customer credit ledger — money that is the customer's but is not settling
 * an invoice.
 *
 * See drizzle/schema.ts for why this is a ledger rather than a balance column.
 * The short version: a stored balance drifts the first time a write path forgets
 * it, and cannot answer where an amount came from.
 */

export const CREDIT_ENTRY_TYPES = [
  /** Paid more than the order's invoices came to. Recomputed, keyed. */
  "overpayment",
  /** A deposit moved onto the customer's account instead of being converted or refunded. */
  "deposit_transfer",
  /** Spent against an order or invoice. Negative. */
  "applied_to_order",
  /** Paid back out to the customer. Negative. */
  "refund_to_customer",
  /** Staff correction, with a reason in notes. */
  "manual_adjustment",
] as const;

export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];

/** Idempotency key for an order's recomputed overpayment. */
export function overpaymentSourceKey(rentalRequestId: number): string {
  return `overpay:rental:${rentalRequestId}`;
}

/**
 * Payment method marking a prepayment row that is credit being spent, not cash
 * arriving.
 *
 * Applying credit has to land in the prepayment ledger — an invoice's amountPaid
 * is recomputed from that ledger, so anything written straight onto the invoice
 * is erased by the next recalculation. But the money was already collected once,
 * when it became credit, so counting the row again would inflate collections.
 * Everything that asks "how much did we take in" filters this method out;
 * everything that asks "is this invoice settled" correctly counts it.
 */
export const ACCOUNT_CREDIT_METHOD = "account_credit";

/** Current balance, in dollars. Positive means we hold the customer's money. */
export async function getCustomerCreditBalance(
  db: LedgerDb,
  customerId: number,
): Promise<number> {
  const [row] = await db
    .select({ balance: sql<string>`coalesce(sum(${schema.customerCreditEntries.amount}::numeric), 0)` })
    .from(schema.customerCreditEntries)
    .where(and(
      eq(schema.customerCreditEntries.customerId, customerId),
      isNull(schema.customerCreditEntries.deletedAt),
    ));
  return Math.round(parseFloat(row?.balance || "0") * 100) / 100;
}

/**
 * Record an event on the ledger — a refund, an application, a correction.
 *
 * Each call adds a row. That is the point: these are things that happened, and
 * the history of them is the audit trail. For a value that is derived and
 * recomputed, use {@link setRecomputedCreditEntry} instead.
 */
export async function addCreditEntry(
  db: LedgerDb,
  entry: {
    customerId: number;
    amount: number;
    entryType: CreditEntryType;
    rentalRequestId?: number | null;
    invoiceId?: number | null;
    notes?: string | null;
    createdBy?: number | null;
  },
): Promise<void> {
  await db.insert(schema.customerCreditEntries).values({
    customerId: entry.customerId,
    rentalRequestId: entry.rentalRequestId ?? null,
    invoiceId: entry.invoiceId ?? null,
    amount: entry.amount.toFixed(2),
    entryType: entry.entryType,
    notes: entry.notes ?? null,
    createdBy: entry.createdBy ?? null,
  });
}

/**
 * Set a DERIVED entry to a given amount, creating it once and updating it after.
 *
 * An order's overpayment is not an event — it is recomputed from scratch every
 * time the order's invoices or payments change. Inserting a row on each
 * recalculation would compound the customer's balance without anybody doing
 * anything, so the amount is upserted against a stable key instead.
 *
 * An amount of zero leaves the row at zero rather than deleting it: the fact
 * that an order once carried an overpayment is worth keeping, and a zero row
 * sums to nothing.
 */
export async function setRecomputedCreditEntry(
  db: LedgerDb,
  entry: {
    sourceKey: string;
    customerId: number;
    amount: number;
    entryType: CreditEntryType;
    rentalRequestId?: number | null;
    notes?: string | null;
  },
): Promise<void> {
  const amount = Math.round(entry.amount * 100) / 100;

  const [existing] = await db
    .select({ id: schema.customerCreditEntries.id, amount: schema.customerCreditEntries.amount })
    .from(schema.customerCreditEntries)
    .where(eq(schema.customerCreditEntries.sourceKey, entry.sourceKey))
    .limit(1);

  if (existing) {
    // Skip the write when nothing moved — recalculation runs on every payment
    // and invoice change, and a no-op UPDATE would churn updatedAt for nothing.
    if (Math.abs(parseFloat(existing.amount) - amount) < 0.005) return;
    await db
      .update(schema.customerCreditEntries)
      .set({ amount: amount.toFixed(2), updatedAt: new Date(), deletedAt: null })
      .where(eq(schema.customerCreditEntries.id, existing.id));
    return;
  }

  // Nothing to record and nothing recorded before.
  if (Math.abs(amount) < 0.005) return;

  await db.insert(schema.customerCreditEntries).values({
    customerId: entry.customerId,
    rentalRequestId: entry.rentalRequestId ?? null,
    amount: amount.toFixed(2),
    entryType: entry.entryType,
    sourceKey: entry.sourceKey,
    notes: entry.notes ?? null,
  });
}
