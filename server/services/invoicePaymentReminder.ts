import { getDb, sql } from "../db";

/**
 * "Needs a payment reminder" — derived, single source of truth shared by the
 * invoices list (red badge) and the summary (count card).
 *
 * Rule (per product): an OPEN invoice (issued, still owing) where it has been
 * ≥ 30 days since the last payment — or since the rental started, if nothing has
 * ever been paid. Catches long-running rentals that should see a payment at least
 * every 30 days. Standalone invoices fall back to their issue/created date.
 *
 * Uses `now() - interval '30 days'` in SQL (no JS Date bound into a raw fragment —
 * see memory/feedback_drizzle-raw-sql-date-params).
 */
export async function paymentReminderInvoiceIds(): Promise<Set<number>> {
  const db = await getDb();
  if (!db) return new Set();
  const rows: Record<string, unknown>[] = await db.execute(sql`
    SELECT i.id
    FROM invoices i
    LEFT JOIN rental_requests r ON r.id = i."rentalId" AND r."deletedAt" IS NULL
    LEFT JOIN (
      SELECT "rentalRequestId" AS rid, MAX("paymentDate") AS last_pay
      FROM rental_prepayments WHERE "deletedAt" IS NULL
      GROUP BY "rentalRequestId"
    ) lp ON lp.rid = i."rentalId"
    WHERE i."deletedAt" IS NULL
      AND i.status IN ('sent','partial')
      AND i."balanceDue" > 0.005
      AND COALESCE(lp.last_pay, r."startDate", i."issueDate", i."createdAt") < (now() - interval '30 days')
  `);
  return new Set(rows.map((r) => Number(r.id)));
}
