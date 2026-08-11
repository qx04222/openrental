/**
 * Rental Status Synchronization Service
 * Handles fleet asset assignment/release with optimistic locking
 */

import { eq, ne, and, gte, lte, isNull, sql, inArray } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import {
  fleetOperationalAvailabilityWhere,
  hasFleetCustodyBlocker,
} from "./fleetAvailability";

/**
 * Assign a fleet asset to a rental request using optimistic locking.
 * Only succeeds if asset is still "available".
 *
 * `updateParentPointer` controls whether rental_requests.rentalFleetId is
 * written. For single-asset orders this keeps the parent pointer in sync (the
 * historical behavior). For multi-item orders it MUST be false: the parent
 * pointer is deliberately null so the single/multi discriminator
 * (`rr.rentalFleetId IS NULL`) used across reports, inspections and utilization
 * stays correct — otherwise the loop would stamp the parent with "the last
 * asset assigned" and break those queries.
 */
export async function assignFleetAssetToRental(
  rentalRequestId: number,
  rentalFleetId: number,
  updateParentPointer: boolean = true,
): Promise<{ success: boolean; error?: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    // Use transaction to ensure atomicity
    const result = await db.transaction(async (tx) => {
      const updateResult = await tx
        .update(schema.rentalFleet)
        .set({ currentStatus: "rented", updatedAt: new Date() })
        .where(and(
          eq(schema.rentalFleet.id, rentalFleetId),
          fleetOperationalAvailabilityWhere({ excludeRentalId: rentalRequestId }),
        ))
        .returning({ id: schema.rentalFleet.id });

      if (!updateResult || updateResult.length === 0) {
        return { success: false as const, error: "Fleet asset is no longer available." };
      }

      if (updateParentPointer) {
        await tx
          .update(schema.rentalRequests)
          .set({ rentalFleetId, updatedAt: new Date() })
          .where(eq(schema.rentalRequests.id, rentalRequestId));
      }

      return { success: true as const };
    });

    if (!result.success) {
      logger.warn(`[RentalStatusSync] Fleet asset ${rentalFleetId} is no longer available`);
    } else {
      logger.info(`[RentalStatusSync] Assigned fleet asset ${rentalFleetId} to rental ${rentalRequestId}`);
    }
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[RentalStatusSync] Failed to assign fleet asset ${rentalFleetId}`, { error: msg });
    return { success: false, error: msg };
  }
}

/**
 * Release a fleet asset when a rental is completed/cancelled.
 *
 * `excludeRentalId` is the rental being closed. Before releasing, we check
 * whether ANY OTHER active rental still claims this unit (via a line item or the
 * parent pointer). If so we keep it `rented` and skip the release — otherwise
 * closing an order that ran late would wrongly flip a unit a newer active order
 * holds back to `available`, leaving that order active-but-not-rented (the
 * "double-booked" anomaly). Release is therefore order-aware, not just fleet-id
 * keyed.
 */
export async function releaseFleetAsset(rentalFleetId: number, excludeRentalId?: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Any remaining rental, return, or workshop custody keeps the unit blocked.
  if (await hasFleetCustodyBlocker(db, rentalFleetId, { excludeRentalId })) {
    logger.info(`[RentalStatusSync] Fleet asset ${rentalFleetId} still has an operational custody blocker — keeping rented`);
    return;
  }

  // Only release if currently rented — don't overwrite maintenance status
  const result = await db
    .update(schema.rentalFleet)
    .set({ currentStatus: "available", updatedAt: new Date() })
    .where(and(eq(schema.rentalFleet.id, rentalFleetId), eq(schema.rentalFleet.currentStatus, "rented")))
    .returning({ id: schema.rentalFleet.id });

  if (result.length > 0) {
    logger.info(`[RentalStatusSync] Released fleet asset ${rentalFleetId}`);
  } else {
    logger.warn(`[RentalStatusSync] Fleet asset ${rentalFleetId} not in "rented" status, skipping release`);
  }
}

/**
 * WHERE for the rental_line_items overlap scan. Exported so the param-encoding
 * regression test can render it: the coalesce() fragments have no column
 * encoder, so a raw Date param would go straight to postgres-js and throw
 * ERR_INVALID_ARG_TYPE under prepare:false (same trap as assetAssignment) —
 * dates must be interpolated as ISO strings.
 */
/**
 * Rental statuses that occupy an asset for BOOKING purposes (future-facing):
 * a unit held by any of these blocks a new overlapping booking of the same
 * asset. Includes "overdue" because an overdue rental is still on-hire —
 * overdueCron flips active -> overdue past the grace period but the unit is
 * physically out. This matches getActiveRentalsForInspection and the
 * return/close paths, which all treat overdue as on-hire.
 *
 * NOTE: this is deliberately DIFFERENT from the physical-possession set used by
 * getFleetRentalConflicts (["active","overdue"]): possession asks "which live
 * rental holds this unit right now", where pending/approved reservations don't
 * count because the customer hasn't taken the unit yet.
 */
export const BOOKING_OCCUPYING_STATUSES = ["pending", "approved", "active", "overdue"] as const;

export function lineItemOverlapWhere(
  rentalFleetId: number,
  startDate: Date,
  endDate: Date,
  excludeRentalId?: number,
) {
  return and(
    eq(schema.rentalLineItems.rentalFleetId, rentalFleetId),
    isNull(schema.rentalLineItems.deletedAt),
    lte(sql`coalesce(${schema.rentalLineItems.startDate}, ${schema.rentalRequests.startDate})`, endDate.toISOString()),
    gte(sql`coalesce(${schema.rentalLineItems.endDate}, ${schema.rentalRequests.endDate})`, startDate.toISOString()),
    inArray(schema.rentalRequests.status, BOOKING_OCCUPYING_STATUSES),
    ...(excludeRentalId ? [ne(schema.rentalRequests.id, excludeRentalId)] : []),
  );
}

/**
 * Check date range availability for a specific fleet asset
 */
export async function checkDateRangeAvailability(
  rentalFleetId: number,
  startDate: Date,
  endDate: Date,
  excludeRentalId?: number,
  dbOverride?: NonNullable<Awaited<ReturnType<typeof getDb>>>,
): Promise<{
  isAvailable: boolean;
  conflictingRentals: Array<{ id: number; startDate: Date; endDate: Date; customerName: string }>;
}> {
  const db = dbOverride ?? await getDb();
  if (!db) throw new Error("Database not available");

  // Check asset status (exclude soft-deleted)
  const [asset] = await db
    .select()
    .from(schema.rentalFleet)
    .where(and(eq(schema.rentalFleet.id, rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
    .limit(1);

  if (!asset || asset.currentStatus === "retired" || asset.currentStatus === "maintenance") {
    return { isAvailable: false, conflictingRentals: [] };
  }

  // Check overlapping rentals
  const overlapping = await db
    .select({
      id: schema.rentalRequests.id,
      startDate: schema.rentalRequests.startDate,
      endDate: schema.rentalRequests.endDate,
      customerName: schema.rentalRequests.customerName,
    })
    .from(schema.rentalRequests)
    .where(
      and(
        eq(schema.rentalRequests.rentalFleetId, rentalFleetId),
        isNull(schema.rentalRequests.deletedAt),
        lte(schema.rentalRequests.startDate, endDate),
        gte(schema.rentalRequests.endDate, startDate),
        inArray(schema.rentalRequests.status, BOOKING_OCCUPYING_STATUSES),
        // Exclude the rental being modified (for self-service date changes)
        ...(excludeRentalId ? [ne(schema.rentalRequests.id, excludeRentalId)] : []),
      )
    );

  // Multi-item orders carry their occupancy in rental_line_items, NOT on
  // rentalRequests.rentalFleetId (which is null for those). Without checking
  // line items, a fleet asset booked through the multi-item cart is invisible
  // to conflict detection → deterministic double-booking. Line-item dates fall
  // back to the parent order's dates when null.
  const overlappingLineItems = await db
    .select({
      id: schema.rentalRequests.id,
      startDate: sql<string>`coalesce(${schema.rentalLineItems.startDate}, ${schema.rentalRequests.startDate})`,
      endDate: sql<string>`coalesce(${schema.rentalLineItems.endDate}, ${schema.rentalRequests.endDate})`,
      customerName: schema.rentalRequests.customerName,
    })
    .from(schema.rentalLineItems)
    .innerJoin(
      schema.rentalRequests,
      and(
        eq(schema.rentalLineItems.rentalRequestId, schema.rentalRequests.id),
        isNull(schema.rentalRequests.deletedAt),
      ),
    )
    .where(lineItemOverlapWhere(rentalFleetId, startDate, endDate, excludeRentalId));

  // Merge both occupancy sources, de-duplicating by rental id (a single-asset
  // order could in principle appear in both).
  const byId = new Map<number, { id: number; startDate: Date; endDate: Date; customerName: string }>();
  for (const r of overlapping) {
    byId.set(r.id, { id: r.id, startDate: new Date(r.startDate), endDate: new Date(r.endDate), customerName: r.customerName });
  }
  for (const r of overlappingLineItems) {
    if (!byId.has(r.id)) {
      byId.set(r.id, { id: r.id, startDate: new Date(r.startDate), endDate: new Date(r.endDate), customerName: r.customerName });
    }
  }
  const conflictingRentals = Array.from(byId.values());

  return {
    isAvailable: conflictingRentals.length === 0,
    conflictingRentals,
  };
}
