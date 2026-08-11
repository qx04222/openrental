import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { getDb } from "../db";
import * as schema from "../../drizzle/schema";

export interface FleetRentalClaim {
  rentalFleetId: number;
  rentalId: number;
  rentalNumber: string | null;
  customerName: string;
  status: string;
}

export interface FleetRentalConflict {
  rentalFleetId: number;
  rentals: Array<Omit<FleetRentalClaim, "rentalFleetId">>;
}

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ConflictReadDb = Pick<AppDb, "select">;

export function deriveFleetRentalConflicts(
  claims: FleetRentalClaim[],
): Map<number, FleetRentalConflict> {
  const byFleet = new Map<number, Map<number, Omit<FleetRentalClaim, "rentalFleetId">>>();
  for (const claim of claims) {
    const rentals = byFleet.get(claim.rentalFleetId) ?? new Map();
    rentals.set(claim.rentalId, {
      rentalId: claim.rentalId,
      rentalNumber: claim.rentalNumber,
      customerName: claim.customerName,
      status: claim.status,
    });
    byFleet.set(claim.rentalFleetId, rentals);
  }

  const conflicts = new Map<number, FleetRentalConflict>();
  for (const [rentalFleetId, rentals] of byFleet) {
    if (rentals.size < 2) continue;
    conflicts.set(rentalFleetId, {
      rentalFleetId,
      rentals: [...rentals.values()].sort((left, right) => left.rentalId - right.rentalId),
    });
  }
  return conflicts;
}

export async function getFleetRentalConflicts(
  db: ConflictReadDb,
  fleetIds: number[],
): Promise<Map<number, FleetRentalConflict>> {
  const uniqueFleetIds = [...new Set(fleetIds)];
  if (uniqueFleetIds.length === 0) return new Map();

  // Physical-possession semantics: which live rentals actually hold this unit
  // right now. Deliberately NARROWER than BOOKING_OCCUPYING_STATUSES (which also
  // counts pending/approved reservations): a not-yet-picked-up reservation is
  // not a possession conflict, so only on-hire states (active + overdue) count.
  const openStatuses = ["active", "overdue"] as const;
  const [parentClaims, lineClaims] = await Promise.all([
    db.select({
      rentalFleetId: schema.rentalRequests.rentalFleetId,
      rentalId: schema.rentalRequests.id,
      rentalNumber: schema.rentalRequests.rentalNumber,
      customerName: schema.rentalRequests.customerName,
      status: schema.rentalRequests.status,
    })
      .from(schema.rentalRequests)
      .where(and(
        inArray(schema.rentalRequests.rentalFleetId, uniqueFleetIds),
        inArray(schema.rentalRequests.status, openStatuses),
        isNull(schema.rentalRequests.deletedAt),
      )),
    db.select({
      rentalFleetId: schema.rentalLineItems.rentalFleetId,
      rentalId: schema.rentalRequests.id,
      rentalNumber: schema.rentalRequests.rentalNumber,
      customerName: schema.rentalRequests.customerName,
      status: schema.rentalRequests.status,
    })
      .from(schema.rentalLineItems)
      .innerJoin(schema.rentalRequests, eq(schema.rentalLineItems.rentalRequestId, schema.rentalRequests.id))
      .where(and(
        inArray(schema.rentalLineItems.rentalFleetId, uniqueFleetIds),
        inArray(schema.rentalRequests.status, openStatuses),
        isNull(schema.rentalLineItems.deletedAt),
        isNull(schema.rentalRequests.deletedAt),
      )),
  ]);

  const claims = [...parentClaims, ...lineClaims].flatMap((claim) => (
    claim.rentalFleetId == null ? [] : [{ ...claim, rentalFleetId: claim.rentalFleetId }]
  ));
  return deriveFleetRentalConflicts(claims);
}

export async function assertFleetRentalPairUnambiguous(
  db: ConflictReadDb,
  rentalId: number,
  fleetId: number,
): Promise<void> {
  const conflict = (await getFleetRentalConflicts(db, [fleetId])).get(fleetId);
  if (!conflict || !conflict.rentals.some((rental) => rental.rentalId === rentalId)) return;
  const labels = conflict.rentals.map((rental) => rental.rentalNumber ?? `#${rental.rentalId}`);
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `Fleet occupancy conflict: ${labels.join(", ")}`,
  });
}
