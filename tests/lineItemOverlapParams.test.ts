import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, lte } from "drizzle-orm";
import { lineItemOverlapWhere } from "../server/services/rentalStatusSync";
import * as schema from "../drizzle/schema";

/**
 * Regression: 2026-06-11 production 500 on rentals.adminCreate.
 *
 * The line-item overlap WHERE compares a raw sql`coalesce(...)` fragment
 * against the requested date range. A raw fragment has no column encoder, so
 * a JS Date bound there is handed to postgres-js untranslated and throws
 * ERR_INVALID_ARG_TYPE under prepare:false — before any SQL reaches Postgres
 * (mock-based tests stay green; only the live driver explodes). Dates must be
 * interpolated as ISO strings.
 */
describe("lineItemOverlapWhere param encoding", () => {
  const dialect = new PgDialect();
  const start = new Date("2026-06-11T00:00:00.000Z");
  const end = new Date("2026-06-20T00:00:00.000Z");

  it("binds no raw Date params (postgres-js prepare:false rejects them)", () => {
    const where = lineItemOverlapWhere(1, start, end, 42);
    const { params } = dialect.sqlToQuery(where!);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) {
      expect(p instanceof Date, `raw Date param leaked: ${String(p)}`).toBe(false);
    }
  });

  it("detector sanity: a Date bound to a raw fragment DOES surface as Date", () => {
    // Re-create the original bug shape to prove the assertion above can fail.
    const bad = lte(sql`coalesce(${schema.rentalLineItems.startDate}, ${schema.rentalRequests.startDate})`, end);
    const { params } = dialect.sqlToQuery(bad);
    expect(params.some((p) => p instanceof Date)).toBe(true);
  });
});
