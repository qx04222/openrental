/**
 * Multi-line fleet status sync. Wraps the per-fleet
 * assignFleetAssetToRental / releaseFleetAsset helpers and applies them
 * across every line_item belonging to a rental, so multi-item orders
 * activate / complete every fleet unit, not just rental_requests.rentalFleetId.
 */
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, notInArray } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { fleetOperationalAvailabilityWhere } from "./fleetAvailability";
import { assignFleetAssetToRental, releaseFleetAsset } from "./rentalStatusSync";

type Db = NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;
// Accepts either the pooled db or an open transaction, so callers can read
// uncommitted rows inside a tx (e.g. approval auto-dispatch).
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Fleet IDs assigned across every line item of a rental (de-duplicated).
 *
 * Falls back to the parent rental_requests.rentalFleetId when the order has no
 * line items — covers both single-asset orders (whose line-item mirror is a
 * best-effort, out-of-transaction write that can fail) and legacy orders
 * created before the mirror logic existed. Without this fallback those orders
 * assign/release no fleet at all on activation/completion.
 */
export async function getRentalFleetIds(db: DbOrTx, rentalRequestId: number): Promise<number[]> {
  const rows = await db
    .select({ rentalFleetId: schema.rentalLineItems.rentalFleetId })
    .from(schema.rentalLineItems)
    .where(and(
      eq(schema.rentalLineItems.rentalRequestId, rentalRequestId),
      isNull(schema.rentalLineItems.deletedAt),
    ));
  const out = new Set<number>();
  for (const r of rows) {
    if (r.rentalFleetId) out.add(r.rentalFleetId);
  }
  if (out.size === 0) {
    const [parent] = await db
      .select({ rentalFleetId: schema.rentalRequests.rentalFleetId })
      .from(schema.rentalRequests)
      .where(and(
        eq(schema.rentalRequests.id, rentalRequestId),
        isNull(schema.rentalRequests.deletedAt),
      ))
      .limit(1);
    if (parent?.rentalFleetId) out.add(parent.rentalFleetId);
  }
  return [...out];
}

/**
 * One fulfillment unit = one piece of equipment on a rental, enriched with the
 * display metadata dispatch + inspection need. Multi-item orders yield one unit
 * per line item; single-asset / legacy orders fall back to the parent order's
 * rentalFleetId so callers never special-case the two shapes.
 */
export interface RentalFulfillmentUnit {
  lineItemId: number | null;
  rentalFleetId: number | null;
  equipmentModelId: number | null;
  itemType: "machine" | "attachment";
  quantity: number;
  brand: string;
  model: string;
  category: string;
  assetNumber: string | null;
  locationId: number | null;
  startDate: Date | null;
  endDate: Date | null;
}

export async function getRentalFulfillmentUnits(db: DbOrTx, rentalRequestId: number): Promise<RentalFulfillmentUnit[]> {
  const rows = await db
    .select({
      lineItemId: schema.rentalLineItems.id,
      rentalFleetId: schema.rentalLineItems.rentalFleetId,
      equipmentModelId: schema.rentalLineItems.equipmentModelId,
      itemType: schema.rentalLineItems.itemType,
      quantity: schema.rentalLineItems.quantity,
      startDate: schema.rentalLineItems.startDate,
      endDate: schema.rentalLineItems.endDate,
      fleetBrand: schema.rentalFleet.brand,
      fleetModel: schema.rentalFleet.model,
      fleetCategory: schema.rentalFleet.category,
      fleetAssetNumber: schema.rentalFleet.assetNumber,
      fleetLocationId: schema.rentalFleet.locationId,
      modelBrand: schema.equipmentModels.brand,
      modelModel: schema.equipmentModels.model,
      modelCategory: schema.equipmentModels.category,
    })
    .from(schema.rentalLineItems)
    .leftJoin(schema.rentalFleet, and(eq(schema.rentalLineItems.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
    .leftJoin(schema.equipmentModels, and(eq(schema.rentalLineItems.equipmentModelId, schema.equipmentModels.id), isNull(schema.equipmentModels.deletedAt)))
    .where(and(
      eq(schema.rentalLineItems.rentalRequestId, rentalRequestId),
      isNull(schema.rentalLineItems.deletedAt),
    ))
    .orderBy(schema.rentalLineItems.id);

  if (rows.length > 0) {
    return rows.map(r => ({
      lineItemId: r.lineItemId,
      rentalFleetId: r.rentalFleetId ?? null,
      equipmentModelId: r.equipmentModelId ?? null,
      itemType: r.itemType,
      quantity: r.quantity,
      brand: r.fleetBrand || r.modelBrand || "",
      model: r.fleetModel || r.modelModel || "",
      category: r.fleetCategory || r.modelCategory || "",
      assetNumber: r.fleetAssetNumber ?? null,
      locationId: r.fleetLocationId ?? null,
      startDate: r.startDate ?? null,
      endDate: r.endDate ?? null,
    }));
  }

  // No line items — fall back to the parent order's single fleet pointer.
  const [parent] = await db
    .select({
      rentalFleetId: schema.rentalRequests.rentalFleetId,
      equipmentModelId: schema.rentalRequests.equipmentModelId,
      startDate: schema.rentalRequests.startDate,
      endDate: schema.rentalRequests.endDate,
      fleetBrand: schema.rentalFleet.brand,
      fleetModel: schema.rentalFleet.model,
      fleetCategory: schema.rentalFleet.category,
      fleetAssetNumber: schema.rentalFleet.assetNumber,
      fleetLocationId: schema.rentalFleet.locationId,
      modelBrand: schema.equipmentModels.brand,
      modelModel: schema.equipmentModels.model,
      modelCategory: schema.equipmentModels.category,
    })
    .from(schema.rentalRequests)
    .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
    .leftJoin(schema.equipmentModels, and(eq(schema.rentalRequests.equipmentModelId, schema.equipmentModels.id), isNull(schema.equipmentModels.deletedAt)))
    .where(and(
      eq(schema.rentalRequests.id, rentalRequestId),
      isNull(schema.rentalRequests.deletedAt),
    ))
    .limit(1);

  if (!parent?.rentalFleetId) return [];
  return [{
    lineItemId: null,
    rentalFleetId: parent.rentalFleetId,
    equipmentModelId: parent.equipmentModelId ?? null,
    itemType: "machine",
    quantity: 1,
    brand: parent.fleetBrand || parent.modelBrand || "",
    model: parent.fleetModel || parent.modelModel || "",
    category: parent.fleetCategory || parent.modelCategory || "",
    assetNumber: parent.fleetAssetNumber ?? null,
    locationId: parent.fleetLocationId ?? null,
    startDate: parent.startDate ?? null,
    endDate: parent.endDate ?? null,
  }];
}

/**
 * Mark every fleet referenced by this rental's line_items as `rented`.
 * Returns ok=false if any unit could not be assigned (already rented to
 * another order, soft-deleted, etc.) — caller decides whether to roll back.
 */
export async function assignAllFleetForRental(
  db: Db,
  rentalRequestId: number,
): Promise<{ ok: boolean; assigned: number[]; failed: Array<{ fleetId: number; error?: string }> }> {
  const ids = await getRentalFleetIds(db, rentalRequestId);
  // Multi-asset orders keep rental_requests.rentalFleetId null so the
  // single/multi discriminator stays correct; only sync the parent pointer
  // for genuine single-asset orders.
  const updateParentPointer = ids.length <= 1;
  const assigned: number[] = [];
  const failed: Array<{ fleetId: number; error?: string }> = [];
  for (const fleetId of ids) {
    const result = await assignFleetAssetToRental(rentalRequestId, fleetId, updateParentPointer);
    if (result.success) assigned.push(fleetId);
    else failed.push({ fleetId, error: result.error });
  }
  return { ok: failed.length === 0, assigned, failed };
}

/**
 * Claim every unit using the caller's open transaction. Any failed compare-and-
 * set throws, causing the rental status write and all earlier fleet claims to
 * roll back together.
 */
export async function claimAllFleetForRental(
  tx: DbOrTx,
  rentalRequestId: number,
): Promise<number[]> {
  const ids = await getRentalFleetIds(tx, rentalRequestId);
  const now = new Date();

  for (const fleetId of ids) {
    const claimed = await tx
      .update(schema.rentalFleet)
      .set({ currentStatus: "rented", updatedAt: now })
      .where(and(
        eq(schema.rentalFleet.id, fleetId),
        fleetOperationalAvailabilityWhere({ excludeRentalId: rentalRequestId }),
      ))
      .returning({ id: schema.rentalFleet.id });

    if (claimed.length === 0) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Fleet asset ${fleetId} is no longer operationally available`,
      });
    }
  }

  if (ids.length === 1) {
    await tx
      .update(schema.rentalRequests)
      .set({ rentalFleetId: ids[0], updatedAt: now })
      .where(eq(schema.rentalRequests.id, rentalRequestId));
  }

  return ids;
}

/** Release every fleet referenced by this rental's line_items (rented → available). */
export async function releaseAllFleetForRental(
  db: Db,
  rentalRequestId: number,
): Promise<void> {
  const ids = await getRentalFleetIds(db, rentalRequestId);
  // Pass the closing rental so release skips units a DIFFERENT active order holds.
  await Promise.all(ids.map(id => releaseFleetAsset(id, rentalRequestId)));
}

/**
 * Push every line item's endDate forward to match a renewal. Only touches
 * lines whose endDate equals (or was earlier than) the old rental endDate —
 * lines with a later endDate keep theirs, in case ops staggered returns.
 *
 * lineSubtotal is left alone here; the supplement invoice tracks the price
 * delta at the rental level. Re-proportioning per-line subtotals is a
 * future enhancement once we ship multi-line UI everywhere.
 */
export async function extendLineItemEndDates(
  db: Db,
  rentalRequestId: number,
  oldEndDate: Date,
  newEndDate: Date,
): Promise<{ updated: number }> {
  const lines = await db
    .select({
      id: schema.rentalLineItems.id,
      endDate: schema.rentalLineItems.endDate,
    })
    .from(schema.rentalLineItems)
    .where(and(
      eq(schema.rentalLineItems.rentalRequestId, rentalRequestId),
      isNull(schema.rentalLineItems.deletedAt),
    ));

  let updated = 0;
  for (const line of lines) {
    if (!line.endDate) continue;
    if (line.endDate.getTime() > oldEndDate.getTime()) continue;
    await db.update(schema.rentalLineItems).set({
      endDate: newEndDate,
      updatedAt: new Date(),
    }).where(eq(schema.rentalLineItems.id, line.id));
    updated++;
  }

  return { updated };
}

/**
 * Keep the rental's outstanding dispatch orders aligned with its dates after a
 * renewal or customer date change. A delivery order is scheduled for the start
 * date, a return pickup for the end date — both are auto-created at approval,
 * so when the rental is extended/shifted they would otherwise still point at the
 * old dates and a driver would arrive to collect equipment that is still on
 * rent (or deliver on the wrong day). Only orders that haven't been completed or
 * cancelled are touched. Pass only the date(s) that actually changed.
 */
export async function syncDispatchScheduleDates(
  db: Db,
  rentalRequestId: number,
  dates: { startDate?: Date; endDate?: Date },
): Promise<{ updated: number }> {
  const now = new Date();
  let updated = 0;

  const apply = async (orderType: "delivery" | "pickup", scheduledDate: Date) => {
    const rows = await db
      .update(schema.dispatchOrders)
      .set({ scheduledDate, updatedAt: now })
      .where(and(
        eq(schema.dispatchOrders.rentalRequestId, rentalRequestId),
        eq(schema.dispatchOrders.orderType, orderType),
        notInArray(schema.dispatchOrders.status, ["completed", "cancelled"]),
        isNull(schema.dispatchOrders.deletedAt),
      ))
      .returning({ id: schema.dispatchOrders.id });
    updated += rows.length;
  };

  if (dates.startDate) await apply("delivery", dates.startDate);
  if (dates.endDate) await apply("pickup", dates.endDate);

  return { updated };
}
