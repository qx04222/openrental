/**
 * Sequential invoice-number allocation that is safe under concurrency.
 *
 * The old pattern (read MAX(invoiceNumber) for a prefix, +1, then INSERT) races:
 * two concurrent return inspections could read the same max and generate the same
 * number; the unique constraint then made the second INSERT fail (and the caller
 * silently swallowed it → a missing invoice / revenue leak). `insertWithInvoiceNumber`
 * retries on a unique-constraint collision, recomputing the number each attempt.
 */
import { getDb, desc, sql } from "../db";
import * as schema from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** Postgres unique-violation (SQLSTATE 23505), as surfaced by postgres-js. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

/** Next `${prefix}NNNN` for the given prefix (e.g. "FUEL-2026-"). */
export async function computeNextInvoiceNumber(db: Db, prefix: string): Promise<string> {
  const [last] = await db
    .select({ invoiceNumber: schema.invoices.invoiceNumber })
    .from(schema.invoices)
    .where(sql`${schema.invoices.invoiceNumber} LIKE ${prefix + "%"}`)
    .orderBy(desc(schema.invoices.invoiceNumber))
    .limit(1);
  let seq = 1;
  if (last?.invoiceNumber) {
    const n = parseInt(last.invoiceNumber.split("-").pop() ?? "", 10);
    if (!Number.isNaN(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}

/**
 * Allocate a unique invoice number for `prefix` and run `insertFn` with it,
 * retrying (re-allocating) if a concurrent insert grabbed the same number first.
 */
export async function insertWithInvoiceNumber<T>(
  db: Db,
  prefix: string,
  insertFn: (invoiceNumber: string) => Promise<T>,
  maxAttempts = 6,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const invoiceNumber = await computeNextInvoiceNumber(db, prefix);
    try {
      return await insertFn(invoiceNumber);
    } catch (err) {
      lastErr = err;
      if (isUniqueViolation(err)) continue; // collided — recompute and retry
      throw err;
    }
  }
  throw lastErr ?? new Error("Could not allocate a unique invoice number");
}
