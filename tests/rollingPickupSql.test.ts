import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { rollingTermBillingStopSql } from "../server/services/rollingRentalOperations";

describe("rolling pickup SQL", () => {
  it("encodes the all-units pickup cutoff as an ISO timestamp", () => {
    const cutoff = new Date("2026-07-15T17:57:41.386Z");
    const query = new PgDialect().sqlToQuery(rollingTermBillingStopSql(cutoff));

    expect(query.sql).toContain("coalesce");
    expect(query.params).toEqual([cutoff.toISOString()]);
  });
});
