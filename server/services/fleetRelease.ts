/**
 * Fleet maintenance-release helper.
 *
 * Extracted from workOrders.updateStatus so both the tRPC work-order flow and
 * the inbound workshop webhook (server/routes/workshop.ts) share ONE mutual-
 * exclusion check instead of drifting copies.
 *
 * A unit parked in `maintenance` only returns to `available` when nothing else
 * still claims it: no other open openrental work order covers it, and no active/
 * overdue rental points at it (pointer or line item). `completed` from any
 * single repair must NOT unconditionally flip it available.
 */
import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "./auditLog";
import { hasFleetCustodyBlocker } from "./fleetAvailability";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface MaybeReleaseOptions {
  /** An openrental work order to ignore when checking for other open coverage
   *  (the one that just closed). Omit when the caller is not an openrental WO. */
  excludeWorkOrderId?: number;
  /** When a release actually happens, write this audit entry. */
  audit?: {
    userId?: number | null;
    action: string;
    metadata?: Record<string, unknown>;
    ipAddress?: string;
  };
}

/**
 * Release `fleetId` back to `available` iff it is currently in `maintenance`
 * and no other open work order / active rental still claims it. Returns true
 * only when the row was actually flipped.
 */
export async function maybeReleaseFleet(
  db: Db,
  fleetId: number,
  opts: MaybeReleaseOptions = {},
): Promise<boolean> {
  const [asset] = await db
    .select({ currentStatus: schema.rentalFleet.currentStatus })
    .from(schema.rentalFleet)
    .where(and(eq(schema.rentalFleet.id, fleetId), isNull(schema.rentalFleet.deletedAt)))
    .limit(1);
  if (asset?.currentStatus !== "maintenance") return false;

  if (await hasFleetCustodyBlocker(db, fleetId, {
    excludeWorkOrderId: opts.excludeWorkOrderId,
  })) return false;

  const released = await db
    .update(schema.rentalFleet)
    .set({ currentStatus: "available", updatedAt: new Date() })
    .where(and(eq(schema.rentalFleet.id, fleetId), eq(schema.rentalFleet.currentStatus, "maintenance")))
    .returning({ id: schema.rentalFleet.id });

  if (released.length === 0) return false;

  if (opts.audit) {
    await logAudit({
      userId: opts.audit.userId,
      action: opts.audit.action,
      entityType: "fleet",
      entityId: fleetId,
      metadata: opts.audit.metadata,
      ipAddress: opts.audit.ipAddress,
    });
  }
  return true;
}
