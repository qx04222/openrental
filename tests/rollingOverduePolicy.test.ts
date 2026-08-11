import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { rollingOverdueProtectionSql } from "../server/services/rollingOverduePolicy";

describe("rolling overdue protection", () => {
  it("protects active rolling and ending terms with a billing cutoff", () => {
    const query = new PgDialect().sqlToQuery(
      rollingOverdueProtectionSql(sql`r.id`),
    ).sql;

    expect(query).toContain("rental_rolling_terms");
    expect(query).toContain("active");
    expect(query).toContain("ending");
    expect(query).toContain("billingStopAt");
    expect(query).toContain("IS NOT NULL");
  });
});
