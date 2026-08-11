import { sql, type SQL } from "drizzle-orm";
import type { getDb } from "../db";
import * as schema from "../../drizzle/schema";

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ExecuteDb = Pick<AppDb, "execute">;

export interface FleetAvailabilityFacts {
  currentStatus: "available" | "rented" | "maintenance" | "retired";
  deleted: boolean;
  rentalClaim: boolean;
  returnOperation: boolean;
  openWorkOrder: boolean;
}

export function isFleetOperationallyAvailable(facts: FleetAvailabilityFacts): boolean {
  return facts.currentStatus === "available"
    && !facts.deleted
    && !facts.rentalClaim
    && !facts.returnOperation
    && !facts.openWorkOrder;
}

/**
 * One fail-closed availability predicate shared by dashboard counts and
 * assignment writes. It deliberately checks custody even when currentStatus
 * says available, because that denormalized flag can drift.
 */
export function fleetOperationalAvailabilityWhere(
  options: { excludeRentalId?: number } = {},
): SQL {
  const excludeRentalId = options.excludeRentalId ?? 0;
  return sql`
    ${schema.rentalFleet.deletedAt} IS NULL
    AND ${schema.rentalFleet.currentStatus} = 'available'
    AND NOT EXISTS (
      SELECT 1
      FROM rental_requests AS availability_rental
      WHERE availability_rental."deletedAt" IS NULL
        AND availability_rental.id <> ${excludeRentalId}
        AND availability_rental.status IN ('active', 'overdue')
        AND (
          availability_rental."rentalFleetId" = ${schema.rentalFleet.id}
          OR EXISTS (
            SELECT 1
            FROM rental_line_items AS availability_line
            WHERE availability_line."rentalRequestId" = availability_rental.id
              AND availability_line."deletedAt" IS NULL
              AND availability_line."rentalFleetId" = ${schema.rentalFleet.id}
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM rental_asset_return_operations AS availability_return
      JOIN rental_requests AS availability_return_rental
        ON availability_return_rental.id = availability_return."rentalRequestId"
      WHERE availability_return."rentalFleetId" = ${schema.rentalFleet.id}
        AND availability_return."rentalRequestId" <> ${excludeRentalId}
        AND availability_return_rental."deletedAt" IS NULL
        AND availability_return_rental.status NOT IN ('completed', 'cancelled', 'rejected')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM work_orders AS availability_work
      WHERE availability_work."rentalFleetId" = ${schema.rentalFleet.id}
        AND availability_work."deletedAt" IS NULL
        AND availability_work.status NOT IN ('completed', 'cancelled')
    )
  `;
}

export async function getFleetCustodyBlockers(
  db: ExecuteDb,
  fleetId: number,
  options: { excludeRentalId?: number; excludeWorkOrderId?: number } = {},
): Promise<Array<{ reason: "rental" | "return" | "work_order" }>> {
  const excludeRentalId = options.excludeRentalId ?? 0;
  const excludeWorkOrderId = options.excludeWorkOrderId ?? 0;
  return db.execute(sql`
    SELECT reason FROM (
      SELECT 'rental'::text AS reason
      FROM rental_requests AS blocker_rental
      WHERE blocker_rental."deletedAt" IS NULL
        AND blocker_rental.id <> ${excludeRentalId}
        AND blocker_rental.status IN ('active', 'overdue')
        AND (
          blocker_rental."rentalFleetId" = ${fleetId}
          OR EXISTS (
            SELECT 1 FROM rental_line_items AS blocker_line
            WHERE blocker_line."rentalRequestId" = blocker_rental.id
              AND blocker_line."deletedAt" IS NULL
              AND blocker_line."rentalFleetId" = ${fleetId}
          )
        )
      UNION ALL
      SELECT 'return'::text AS reason
      FROM rental_asset_return_operations AS blocker_return
      JOIN rental_requests AS blocker_return_rental
        ON blocker_return_rental.id = blocker_return."rentalRequestId"
      WHERE blocker_return."rentalFleetId" = ${fleetId}
        AND blocker_return."rentalRequestId" <> ${excludeRentalId}
        AND blocker_return_rental."deletedAt" IS NULL
        AND blocker_return_rental.status NOT IN ('completed', 'cancelled', 'rejected')
      UNION ALL
      SELECT 'work_order'::text AS reason
      FROM work_orders AS blocker_work
      WHERE blocker_work."rentalFleetId" = ${fleetId}
        AND blocker_work.id <> ${excludeWorkOrderId}
        AND blocker_work."deletedAt" IS NULL
        AND blocker_work.status NOT IN ('completed', 'cancelled')
    ) AS custody_blockers
    LIMIT 1
  `) as unknown as Array<{ reason: "rental" | "return" | "work_order" }>;
}

export async function hasFleetCustodyBlocker(
  db: ExecuteDb,
  fleetId: number,
  options: { excludeRentalId?: number; excludeWorkOrderId?: number } = {},
): Promise<boolean> {
  return (await getFleetCustodyBlockers(db, fleetId, options)).length > 0;
}

/**
 * Fleet units a customer must not be offered for the given dates.
 *
 * The two public booking endpoints each grew their own version of this and both
 * ended up wrong in the same three ways: they only excluded `maintenance`, they
 * never looked at open work orders or unfinished returns, and their date-overlap
 * check omitted `overdue`. An overdue rental is the worst of those — its endDate
 * is already in the past, so it overlaps no future window, yet the machine is
 * still physically at the customer's site with no agreed return date. A customer
 * could book it online.
 *
 * So overdue rentals and operational holds block unconditionally, while ordinary
 * bookings block only when they overlap the requested window (a unit out on rent
 * today is legitimately bookable for next month).
 */
export async function listUnbookableFleetIds(
  db: ExecuteDb,
  range: { start: Date; end: Date },
): Promise<Set<number>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT "fleetId" FROM (
      -- Bookings that overlap the requested window, via the order's own pointer
      -- or via any of its line items (multi-unit orders live only in the lines).
      SELECT COALESCE(booked."rentalFleetId", booked_line."rentalFleetId") AS "fleetId"
      FROM rental_requests AS booked
      LEFT JOIN rental_line_items AS booked_line
        ON booked_line."rentalRequestId" = booked.id
       AND booked_line."deletedAt" IS NULL
      WHERE booked."deletedAt" IS NULL
        AND booked.status IN ('pending', 'approved', 'active')
        AND booked."startDate" <= ${range.end}
        AND booked."endDate" >= ${range.start}
      UNION
      -- Overdue rentals: no agreed return date, so no window makes them free.
      SELECT COALESCE(late."rentalFleetId", late_line."rentalFleetId") AS "fleetId"
      FROM rental_requests AS late
      LEFT JOIN rental_line_items AS late_line
        ON late_line."rentalRequestId" = late.id
       AND late_line."deletedAt" IS NULL
      WHERE late."deletedAt" IS NULL
        AND late.status = 'overdue'
      UNION
      -- In our yard but spoken for: open work order or unfinished return.
      SELECT blocked_return."rentalFleetId" AS "fleetId"
      FROM rental_asset_return_operations AS blocked_return
      JOIN rental_requests AS blocked_return_rental
        ON blocked_return_rental.id = blocked_return."rentalRequestId"
      WHERE blocked_return_rental."deletedAt" IS NULL
        AND blocked_return_rental.status NOT IN ('completed', 'cancelled', 'rejected')
      UNION
      SELECT blocked_work."rentalFleetId" AS "fleetId"
      FROM work_orders AS blocked_work
      WHERE blocked_work."deletedAt" IS NULL
        AND blocked_work.status NOT IN ('completed', 'cancelled')
    ) AS unbookable
    WHERE "fleetId" IS NOT NULL
  `) as unknown as Array<{ fleetId: number }>;
  return new Set(rows.map((row) => Number(row.fleetId)));
}

export type FleetBlockReason = "rental" | "return" | "work_order";

export interface FleetOperationalBlock {
  /** Most significant reason; a live rental outranks a return, which outranks a work order. */
  reason: FleetBlockReason;
  /** Document numbers behind that reason (rental number / work order number), for the UI to name. */
  refs: string[];
}

/** A live rental is the strongest claim; an open work order the weakest. */
const BLOCK_REASON_RANK: Record<FleetBlockReason, number> = {
  rental: 0,
  return: 1,
  work_order: 2,
};

/**
 * Why each fleet unit is operationally unavailable right now — not just *that*
 * it is.
 *
 * The reason matters to the UI: a unit held by a live rental is genuinely
 * "rented", but a unit held by an open work order is in the shop. Collapsing
 * both into "rented" put a red 在租 chip on a machine the fleet list was
 * simultaneously showing as 待租, which is how two open swap work orders kept a
 * machine silently unrentable for two weeks.
 */
export async function listOperationalFleetBlocks(
  db: ExecuteDb,
): Promise<Map<number, FleetOperationalBlock>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT "fleetId", reason, ref FROM (
      SELECT
        COALESCE(blocked_rental."rentalFleetId", blocked_line."rentalFleetId") AS "fleetId",
        'rental'::text AS reason,
        blocked_rental."rentalNumber" AS ref
      FROM rental_requests AS blocked_rental
      LEFT JOIN rental_line_items AS blocked_line
        ON blocked_line."rentalRequestId" = blocked_rental.id
       AND blocked_line."deletedAt" IS NULL
      WHERE blocked_rental."deletedAt" IS NULL
        AND blocked_rental.status IN ('active', 'overdue')
      UNION
      SELECT
        blocked_return."rentalFleetId" AS "fleetId",
        'return'::text AS reason,
        blocked_return_rental."rentalNumber" AS ref
      FROM rental_asset_return_operations AS blocked_return
      JOIN rental_requests AS blocked_return_rental
        ON blocked_return_rental.id = blocked_return."rentalRequestId"
      WHERE blocked_return_rental."deletedAt" IS NULL
        AND blocked_return_rental.status NOT IN ('completed', 'cancelled', 'rejected')
      UNION
      SELECT
        blocked_work."rentalFleetId" AS "fleetId",
        'work_order'::text AS reason,
        blocked_work."workOrderNumber" AS ref
      FROM work_orders AS blocked_work
      WHERE blocked_work."deletedAt" IS NULL
        AND blocked_work.status NOT IN ('completed', 'cancelled')
    ) AS blocked_fleet
    WHERE "fleetId" IS NOT NULL
  `) as unknown as Array<{ fleetId: number; reason: FleetBlockReason; ref: string | null }>;

  const blocks = new Map<number, FleetOperationalBlock>();
  for (const row of rows) {
    const fleetId = Number(row.fleetId);
    const existing = blocks.get(fleetId);
    if (!existing) {
      blocks.set(fleetId, { reason: row.reason, refs: row.ref ? [row.ref] : [] });
      continue;
    }
    if (BLOCK_REASON_RANK[row.reason] < BLOCK_REASON_RANK[existing.reason]) {
      // A stronger reason replaces the weaker one, refs and all: naming the
      // work order on a machine that is actually out on rent would misdirect.
      blocks.set(fleetId, { reason: row.reason, refs: row.ref ? [row.ref] : [] });
    } else if (row.reason === existing.reason && row.ref && !existing.refs.includes(row.ref)) {
      existing.refs.push(row.ref);
    }
  }
  return blocks;
}
