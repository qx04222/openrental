import { sql, type SQL } from "drizzle-orm";

/**
 * Normal rolling use and company-delay return are not customer overdue.
 * Ending terms with no cutoff are customer-chargeable and intentionally fall
 * through to the ordinary overdue rule.
 */
export function rollingOverdueProtectionSql(rentalId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM rental_rolling_terms AS overdue_rolling
    WHERE overdue_rolling."rentalRequestId" = ${rentalId}
      AND (
        overdue_rolling.status = 'active'
        OR (overdue_rolling.status = 'ending' AND overdue_rolling."billingStopAt" IS NOT NULL)
      )
  )`;
}
