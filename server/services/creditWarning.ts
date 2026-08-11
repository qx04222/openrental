/**
 * Credit-exposure warning for credit (挂账) orders.
 *
 * Unlike checkCredit (pure, blocks at order creation), this is a *non-blocking*
 * advisory used when recording charges / exchanging bins / closing out: by then
 * the bin is already on site, so we surface a warning instead of rejecting.
 *
 * Exposure = unpaid invoice balances + not-yet-invoiced credit charges for the
 * customer. Returns null when the customer has no credit limit set or is still
 * within it.
 */

import { getDb, eq, and, sql, isNull } from "../db";
import * as schema from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Total credit exposure for a customer, used by the order-creation credit check
 * so it reflects committed-but-not-yet-invoiced obligations, not just open
 * invoices. Exposure =
 *   unpaid invoice balances
 * + uninvoiced committed non-credit orders (pending/approved/active with no
 *   invoice yet), net of applied prepayments
 * + unbilled credit charges (credit orders bill through the charges ledger; their
 *   order total is an open-ended sentinel, so they're counted via charges, not
 *   totalAmount).
 * Numbers are interpolated (safe: numeric session value), no Date in raw sql.
 */
export async function computeCreditExposure(db: Db, customerId: number | null | undefined): Promise<number> {
  if (!customerId) return 0;
  const [row]: Record<string, unknown>[] = await db.execute(sql`
    WITH inv AS (
      SELECT COALESCE(SUM("balanceDue"::numeric), 0) AS amt
      FROM invoices WHERE "customerId" = ${customerId} AND "deletedAt" IS NULL
    ),
    pp AS (
      SELECT "rentalRequestId" AS rid, SUM(amount::numeric) AS paid
      FROM rental_prepayments
      WHERE "deletedAt" IS NULL AND "appliedAt" IS NOT NULL
      GROUP BY "rentalRequestId"
    ),
    uninvoiced AS (
      SELECT COALESCE(SUM(GREATEST(COALESCE(r."totalAmount"::numeric, 0) - COALESCE(pp.paid, 0), 0)), 0) AS amt
      FROM rental_requests r
      LEFT JOIN pp ON pp.rid = r.id
      WHERE r."customerId" = ${customerId}
        AND r."deletedAt" IS NULL
        AND r.status IN ('pending', 'approved', 'active')
        AND COALESCE(r."isCreditOrder", false) = false
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i."rentalId" = r.id AND i."deletedAt" IS NULL)
    ),
    charges AS (
      SELECT COALESCE(SUM(c.amount::numeric), 0) AS amt
      FROM rental_charges c
      JOIN rental_requests r2 ON r2.id = c."rentalRequestId" AND r2."deletedAt" IS NULL AND r2."customerId" = ${customerId}
      WHERE c."invoiceId" IS NULL AND c."deletedAt" IS NULL
    )
    SELECT ((SELECT amt FROM inv) + (SELECT amt FROM uninvoiced) + (SELECT amt FROM charges)) AS exposure
  `);
  return parseFloat(String(row?.exposure ?? "0")) || 0;
}

export interface CreditWarning {
  outstanding: number;     // unpaid invoice balances
  unbilledCharges: number; // not-yet-invoiced credit charges
  exposure: number;        // outstanding + unbilledCharges
  creditLimit: number;
}

export async function computeCreditWarning(customerId: number | null | undefined): Promise<CreditWarning | null> {
  if (!customerId) return null;
  const db = await getDb();
  if (!db) return null;

  const [customer] = await db
    .select({ creditLimit: schema.customers.creditLimit })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
    .limit(1);
  if (!customer || customer.creditLimit == null) return null;
  const limit = parseFloat(customer.creditLimit);
  if (isNaN(limit)) return null;

  const [outstandingRow] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.invoices.balanceDue}::numeric), 0)` })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.customerId, customerId), isNull(schema.invoices.deletedAt)));
  const outstanding = parseFloat(outstandingRow?.total ?? "0");

  const [unbilledRow] = await db
    .select({ total: sql<string>`coalesce(sum(${schema.rentalCharges.amount}::numeric), 0)` })
    .from(schema.rentalCharges)
    .innerJoin(schema.rentalRequests, eq(schema.rentalCharges.rentalRequestId, schema.rentalRequests.id))
    .where(and(
      eq(schema.rentalRequests.customerId, customerId),
      isNull(schema.rentalCharges.invoiceId),
      isNull(schema.rentalCharges.deletedAt),
      isNull(schema.rentalRequests.deletedAt),
    ));
  const unbilledCharges = parseFloat(unbilledRow?.total ?? "0");

  const exposure = Math.round((outstanding + unbilledCharges) * 100) / 100;
  if (exposure <= limit) return null;

  return { outstanding, unbilledCharges, exposure, creditLimit: limit };
}
