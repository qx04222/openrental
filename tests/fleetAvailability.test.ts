import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  fleetOperationalAvailabilityWhere,
  isFleetOperationallyAvailable,
  listOperationalFleetBlocks,
  listUnbookableFleetIds,
} from "../server/services/fleetAvailability";

describe("fleet operational availability", () => {
  it("requires the database status and every custody blocker to be clear", () => {
    const clear = {
      currentStatus: "available" as const,
      deleted: false,
      rentalClaim: false,
      returnOperation: false,
      openWorkOrder: false,
    };

    expect(isFleetOperationallyAvailable(clear)).toBe(true);
    expect(isFleetOperationallyAvailable({ ...clear, currentStatus: "rented" })).toBe(false);
    expect(isFleetOperationallyAvailable({ ...clear, rentalClaim: true })).toBe(false);
    expect(isFleetOperationallyAvailable({ ...clear, returnOperation: true })).toBe(false);
    expect(isFleetOperationallyAvailable({ ...clear, openWorkOrder: true })).toBe(false);
    expect(isFleetOperationallyAvailable({ ...clear, deleted: true })).toBe(false);
  });

  it("builds one SQL predicate covering parent claims, line claims, returns, and work orders", () => {
    const query = new PgDialect().sqlToQuery(fleetOperationalAvailabilityWhere()).sql;

    expect(query).toContain("rental_requests");
    expect(query).toContain("rental_line_items");
    expect(query).toContain("rental_asset_return_operations");
    expect(query).toContain("work_orders");
    expect(query).toContain("active");
    expect(query).toContain("overdue");
  });

  it("can exclude the rental currently being activated from its own custody claims", () => {
    const query = new PgDialect().sqlToQuery(
      fleetOperationalAvailabilityWhere({ excludeRentalId: 123 }),
    );

    expect(query.sql).toContain('availability_rental.id <> $1');
    expect(query.sql).toContain('availability_return."rentalRequestId" <> $2');
    expect(query.params).toEqual([123, 123]);
  });
});

/**
 * Two open "mid-rental swap" work orders kept fleet unit 76 unrentable for two
 * weeks while the fleet list still showed it as 待租, because the picker
 * collapsed every operational hold into "rented". The reason has to survive the
 * trip to the UI so the operator is told which document to close.
 */
describe("operational fleet blocks carry their reason", () => {
  const fakeDb = (rows: Array<{ fleetId: number; reason: string; ref: string | null }>) => ({
    execute: async () => rows as never,
  });

  it("keeps the work order numbers holding a unit", async () => {
    const blocks = await listOperationalFleetBlocks(fakeDb([
      { fleetId: 76, reason: "work_order", ref: "WO-2026-0002" },
      { fleetId: 76, reason: "work_order", ref: "WO-2026-0004" },
    ]));

    expect(blocks.get(76)).toEqual({
      reason: "work_order",
      refs: ["WO-2026-0002", "WO-2026-0004"],
    });
  });

  it("lets a live rental outrank a work order, refs and all", async () => {
    // Order reversed on purpose: rank must decide, not row order.
    const blocks = await listOperationalFleetBlocks(fakeDb([
      { fleetId: 9, reason: "work_order", ref: "WO-1" },
      { fleetId: 9, reason: "rental", ref: "20260702TJ" },
      { fleetId: 9, reason: "return", ref: "20260613TC" },
    ]));

    // Naming the work order on a machine that is actually out on rent would
    // send the operator to the wrong screen.
    expect(blocks.get(9)).toEqual({ reason: "rental", refs: ["20260702TJ"] });
  });

  it("prefers an unfinished return over an open work order", async () => {
    const blocks = await listOperationalFleetBlocks(fakeDb([
      { fleetId: 3, reason: "work_order", ref: "WO-7" },
      { fleetId: 3, reason: "return", ref: "20260620TD" },
    ]));

    expect(blocks.get(3)).toEqual({ reason: "return", refs: ["20260620TD"] });
  });

  it("leaves unblocked units out of the map entirely", async () => {
    const blocks = await listOperationalFleetBlocks(fakeDb([]));
    expect(blocks.size).toBe(0);
  });
});

/**
 * The two public booking endpoints each rolled their own availability rule and
 * both missed the same three things. Verified against production: three units
 * held by overdue rentals — physically still at customers' sites — were offerable
 * on the public site, because an overdue rental's endDate is in the past and so
 * overlaps no future window.
 */
describe("public booking availability", () => {
  const capture = () => {
    const seen: string[] = [];
    return {
      seen,
      db: {
        execute: async (query: unknown) => {
          seen.push(new PgDialect().sqlToQuery(query as never).sql);
          return [] as never;
        },
      },
    };
  };

  it("blocks overdue rentals regardless of the requested window", async () => {
    const { seen, db } = capture();
    await listUnbookableFleetIds(db, { start: new Date("2026-08-01"), end: new Date("2026-08-07") });

    expect(seen).toHaveLength(1);
    // An overdue rental has no agreed return date, so it must not be filtered
    // by the date-overlap predicate the ordinary bookings use.
    expect(seen[0]).toContain("'overdue'");
  });

  it("covers work orders and unfinished returns, not just bookings", async () => {
    const { seen, db } = capture();
    await listUnbookableFleetIds(db, { start: new Date("2026-08-01"), end: new Date("2026-08-07") });

    expect(seen[0]).toContain("work_orders");
    expect(seen[0]).toContain("rental_asset_return_operations");
  });

  it("looks at line items too, so multi-unit orders are not invisible", async () => {
    const { seen, db } = capture();
    await listUnbookableFleetIds(db, { start: new Date("2026-08-01"), end: new Date("2026-08-07") });

    expect(seen[0]).toContain("rental_line_items");
  });

  it("returns a set of ids", async () => {
    const db = { execute: async () => [{ fleetId: 7 }, { fleetId: 7 }, { fleetId: 9 }] as never };
    const blocked = await listUnbookableFleetIds(db, { start: new Date(), end: new Date() });

    expect([...blocked].sort()).toEqual([7, 9]);
  });
});
