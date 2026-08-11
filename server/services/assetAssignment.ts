import { getDb, eq, and, isNull, isNotNull, sql, inArray, lte, gte } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * Auto-assign an available fleet asset for a given equipment model.
 * Picks the best-condition, lowest-hours asset that has no date conflict.
 */
export async function autoAssignAsset(
  equipmentModelId: number,
  startDate: Date,
  endDate: Date,
  excludeFleetId?: number,
): Promise<{ fleetId: number; assetNumber: string | null } | null> {
  const db = await getDb();
  if (!db) return null;

  // Get all fleet items of this model that are available
  const candidates = await db
    .select({
      id: schema.rentalFleet.id,
      assetNumber: schema.rentalFleet.assetNumber,
      condition: schema.rentalFleet.condition,
      engineHours: schema.rentalFleet.engineHours,
    })
    .from(schema.rentalFleet)
    .where(and(
      eq(schema.rentalFleet.equipmentModelId, equipmentModelId),
      eq(schema.rentalFleet.currentStatus, "available"),
      isNull(schema.rentalFleet.deletedAt),
      excludeFleetId ? sql`${schema.rentalFleet.id} != ${excludeFleetId}` : sql`1=1`,
    ));

  if (candidates.length === 0) return null;

  // Get fleet IDs with date conflicts
  const conflicting = await db
    .select({ rentalFleetId: schema.rentalRequests.rentalFleetId })
    .from(schema.rentalRequests)
    .where(and(
      isNotNull(schema.rentalRequests.rentalFleetId),
      inArray(schema.rentalRequests.rentalFleetId, candidates.map(c => c.id)),
      // Typed operators apply the column's mapToDriverValue (Date → timestamp string);
      // a raw sql`` template passes the Date straight to postgres-js, which throws
      // ERR_INVALID_ARG_TYPE under prepare:false. See repro in PR.
      lte(schema.rentalRequests.startDate, endDate),
      gte(schema.rentalRequests.endDate, startDate),
      inArray(schema.rentalRequests.status, ["active", "approved", "pending"]),
      isNull(schema.rentalRequests.deletedAt),
    ));

  const conflictIds = new Set(conflicting.map(c => c.rentalFleetId));

  // Filter out conflicting assets
  const available = candidates.filter(c => !conflictIds.has(c.id));

  if (available.length === 0) return null;

  // Sort: excellent > good > fair > poor, then lowest engine hours
  const conditionOrder: Record<string, number> = { excellent: 0, good: 1, fair: 2, poor: 3 };
  available.sort((a, b) => {
    const ca = conditionOrder[a.condition || "good"] ?? 1;
    const cb = conditionOrder[b.condition || "good"] ?? 1;
    if (ca !== cb) return ca - cb;
    return (a.engineHours || 0) - (b.engineHours || 0);
  });

  return { fleetId: available[0].id, assetNumber: available[0].assetNumber };
}

export interface ConflictingRental {
  id: number;
  rentalNumber: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface ModelAvailabilityResult {
  total: number;
  available: number;
  /** Conflicting rentals for the specific fleet asset (only populated when rentalFleetId is given) */
  conflictingRentals?: ConflictingRental[];
  /** Alternative available assets of the same model */
  alternatives?: Array<{ id: number; brand: string; model: string; assetNumber: string | null; serialNumber: string | null }>;
}

/**
 * Get availability count for an equipment model in a date range.
 * When `rentalFleetId` is supplied, also returns conflicting rental details
 * for that specific asset and a list of alternative available assets.
 */
export async function getModelAvailability(
  equipmentModelId: number,
  startDate?: Date,
  endDate?: Date,
  rentalFleetId?: number,
): Promise<ModelAvailabilityResult> {
  const db = await getDb();
  if (!db) return { total: 0, available: 0 };

  const allAssets = await db
    .select({ id: schema.rentalFleet.id, currentStatus: schema.rentalFleet.currentStatus })
    .from(schema.rentalFleet)
    .where(and(
      eq(schema.rentalFleet.equipmentModelId, equipmentModelId),
      isNull(schema.rentalFleet.deletedAt),
      sql`${schema.rentalFleet.currentStatus} != 'retired'`,
    ));

  const total = allAssets.length;

  // Guard: invalid dates slip past handler-level checks if callers bypass validation.
  const datesValid = startDate instanceof Date && !isNaN(startDate.getTime())
    && endDate instanceof Date && !isNaN(endDate.getTime());

  if (!datesValid || total === 0) {
    // Count currently available (no date range)
    const avail = await db
      .select({ id: schema.rentalFleet.id })
      .from(schema.rentalFleet)
      .where(and(
        eq(schema.rentalFleet.equipmentModelId, equipmentModelId),
        eq(schema.rentalFleet.currentStatus, "available"),
        isNull(schema.rentalFleet.deletedAt),
      ));
    return { total, available: avail.length };
  }

  // Check date conflicts for all assets of this model
  const conflicting = await db
    .select({
      rentalFleetId: schema.rentalRequests.rentalFleetId,
      id: schema.rentalRequests.id,
      rentalNumber: schema.rentalRequests.rentalNumber,
      startDate: schema.rentalRequests.startDate,
      endDate: schema.rentalRequests.endDate,
    })
    .from(schema.rentalRequests)
    .where(and(
      inArray(schema.rentalRequests.rentalFleetId, allAssets.map(a => a.id)),
      lte(schema.rentalRequests.startDate, endDate),
      gte(schema.rentalRequests.endDate, startDate),
      inArray(schema.rentalRequests.status, ["active", "approved", "pending"]),
      isNull(schema.rentalRequests.deletedAt),
    ));

  // A unit is available only when it is NOT in maintenance AND has no overlapping
  // rental — same rule as listWithAvailability's per-unit availabilityStatus.
  // (Previously maintenance units were wrongly counted as available.)
  const conflictIds = new Set(conflicting.map(c => c.rentalFleetId));
  const isFree = (a: { id: number; currentStatus: string | null }) =>
    a.currentStatus !== "maintenance" && !conflictIds.has(a.id);
  const available = allAssets.filter(isFree).length;

  const result: ModelAvailabilityResult = { total, available };

  // If a specific fleet asset was requested, return its conflict details + alternatives
  if (rentalFleetId !== undefined) {
    const assetConflicts = conflicting
      .filter(c => c.rentalFleetId === rentalFleetId)
      .map(c => ({
        id: c.id,
        rentalNumber: c.rentalNumber,
        startDate: c.startDate ? String(c.startDate) : null,
        endDate: c.endDate ? String(c.endDate) : null,
      }));

    result.conflictingRentals = assetConflicts;

    if (assetConflicts.length > 0) {
      // Find alternative available assets of same model (excl. maintenance + conflicts)
      const availableAssetIds = allAssets.filter(isFree).map(a => a.id);
      if (availableAssetIds.length > 0) {
        const altAssets = await db
          .select({
            id: schema.rentalFleet.id,
            brand: schema.rentalFleet.brand,
            model: schema.rentalFleet.model,
            assetNumber: schema.rentalFleet.assetNumber,
            serialNumber: schema.rentalFleet.serialNumber,
          })
          .from(schema.rentalFleet)
          .where(and(
            inArray(schema.rentalFleet.id, availableAssetIds),
            isNull(schema.rentalFleet.deletedAt),
          ));
        result.alternatives = altAssets;
      } else {
        result.alternatives = [];
      }
    }
  }

  return result;
}
