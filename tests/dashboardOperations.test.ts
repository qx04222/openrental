import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  dashboardRentalBucketSql,
  deriveDashboardRentalBucket,
} from "../server/services/dashboardOperations";

const base = {
  rentalStatus: "active" as const,
  rollingStatus: null,
  isCreditOrder: false,
  endDate: new Date("2026-07-20T00:00:00.000Z"),
  now: new Date("2026-07-15T00:00:00.000Z"),
  returnOperations: [] as Array<{
    pickedUpAt: Date | null;
    responsibility: "none" | "company" | "customer";
  }>,
};

describe("dashboard rental operational buckets", () => {
  it("keeps the ongoing buckets mutually exclusive", () => {
    expect(deriveDashboardRentalBucket(base)).toBe("normal");
    expect(deriveDashboardRentalBucket({ ...base, rollingStatus: "active" })).toBe("rolling");
    expect(deriveDashboardRentalBucket({
      ...base,
      rentalStatus: "overdue",
      endDate: new Date("2026-07-14T00:00:00.000Z"),
    })).toBe("renewal_review");
    expect(deriveDashboardRentalBucket({
      ...base,
      rollingStatus: "ending",
      returnOperations: [{ pickedUpAt: null, responsibility: "company" }],
    })).toBe("awaiting_pickup");
    expect(deriveDashboardRentalBucket({
      ...base,
      rollingStatus: "ending",
      returnOperations: [{ pickedUpAt: new Date(), responsibility: "company" }],
    })).toBe("awaiting_inspection");
    expect(deriveDashboardRentalBucket({
      ...base,
      rentalStatus: "overdue",
      rollingStatus: "ending",
      returnOperations: [{ pickedUpAt: null, responsibility: "customer" }],
    })).toBe("customer_overdue");
  });

  it("does not count terminal rentals as ongoing", () => {
    expect(deriveDashboardRentalBucket({ ...base, rentalStatus: "completed" })).toBeNull();
  });

  it("does not send open-ended credit rentals to renewal review", () => {
    expect(deriveDashboardRentalBucket({
      ...base,
      rentalStatus: "overdue",
      endDate: new Date("2026-07-14T00:00:00.000Z"),
      isCreditOrder: true,
    })).toBe("normal");
  });

  it("builds SQL from rolling terms and per-unit return operations", () => {
    const rendered = new PgDialect().sqlToQuery(dashboardRentalBucketSql(
      sql.raw('"rental_requests"."id"'),
      sql.raw('"rental_requests"."status"'),
      sql.raw('"rental_requests"."endDate"'),
      sql.raw('"rental_requests"."isCreditOrder"'),
    )).sql;
    expect(rendered).toContain("rental_rolling_terms");
    expect(rendered).toContain("rental_asset_return_operations");
    expect(rendered).toContain("customer_overdue");
    expect(rendered).toContain("awaiting_pickup");
    expect(rendered).toContain("awaiting_inspection");
    expect(rendered).toContain("renewal_review");
    expect(rendered).toContain('"rental_requests"."endDate"');
    expect(rendered).toContain('"rental_requests"."isCreditOrder"');
  });
});
