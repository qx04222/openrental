import { sql, type SQL } from "drizzle-orm";

/**
 * SQL predicate matching the DERIVED "overdue" invoice (payment-open + balance
 * owing + past its due date). Mirrors shared/invoiceOverdue.isInvoiceOverdue so
 * the dashboard summary counters agree with the list view.
 *
 * `todayUtc` is bound as an ISO STRING, never a JS Date: under drizzle
 * prepare:false a Date in a raw sql`` fragment throws ERR_INVALID_ARG_TYPE
 * before the query is sent (500 + zero PG logs → summary cards all read 0).
 * See memory/feedback_drizzle-raw-sql-date-params.
 */
export function overdueInvoiceWhereSql(todayUtc: Date): SQL {
  const todayIso = todayUtc.toISOString();
  return sql`status IN ('sent','partial') AND "balanceDue"::numeric > 0.005 AND "dueDate" IS NOT NULL AND "dueDate" < ${todayIso}::timestamptz`;
}
