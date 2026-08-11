import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { overdueInvoiceWhereSql } from "../server/services/invoiceOverdueSql";

/**
 * Regression: 2026-06-21 invoices.summary 500'd and every dashboard card read 0.
 *
 * The overdue predicate bound a JS Date into a raw sql`` fragment. Under
 * postgres-js prepare:false a raw Date throws ERR_INVALID_ARG_TYPE before the
 * query is sent (zero PG logs; mock tests stay green). Dates must be ISO strings.
 */
describe("overdueInvoiceWhereSql param encoding", () => {
  const dialect = new PgDialect();

  it("binds no raw Date params (postgres-js prepare:false rejects them)", () => {
    const frag = overdueInvoiceWhereSql(new Date("2026-06-21T04:00:00.000Z"));
    const { params } = dialect.sqlToQuery(frag);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) {
      expect(p instanceof Date, `raw Date param leaked: ${String(p)}`).toBe(false);
    }
  });

  it("detector sanity: a Date bound to a raw fragment DOES surface as Date", () => {
    const bad = sql`"dueDate" < ${new Date("2026-06-21T04:00:00.000Z")}`;
    const { params } = dialect.sqlToQuery(bad);
    expect(params.some((p) => p instanceof Date)).toBe(true);
  });
});
