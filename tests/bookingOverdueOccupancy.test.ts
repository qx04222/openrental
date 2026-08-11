import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { lineItemOverlapWhere } from "../server/services/rentalStatusSync";

/**
 * Regression: a booking-availability check must treat "overdue" as on-hire.
 *
 * overdueCron flips active -> overdue once a rental is past its grace period,
 * but the asset is still physically out. If the booking-occupancy predicates
 * omit "overdue", an overdue-held unit silently becomes bookable again — a
 * double-booking hole. The operational/custody predicate
 * (fleetOperationalAvailabilityWhere) and getActiveRentalsForInspection
 * already include overdue; the date-range booking guards must match.
 */
describe("booking occupancy treats overdue as on-hire", () => {
  it("lineItemOverlapWhere includes overdue rentals", () => {
    const query = new PgDialect().sqlToQuery(
      lineItemOverlapWhere(1, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-05T00:00:00Z")),
    );

    // Status values are bound params, not inlined into the SQL string.
    expect(query.params).toContain("pending");
    expect(query.params).toContain("approved");
    expect(query.params).toContain("active");
    expect(query.params).toContain("overdue");
  });
});
