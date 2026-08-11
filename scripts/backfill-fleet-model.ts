import "dotenv/config";
import { getDb, eq, and, isNull, ne, sql } from "../server/db";
import * as schema from "../drizzle/schema";

/**
 * One-off: backfill rental_fleet.equipmentModelId (and best-effort
 * catalogCacheId) for rows that were entered without linking to the
 * aggregation / catalog layers.
 *
 * Why: the public listing's grouping and the admin swap-asset feature
 * both prefer rental_fleet.equipmentModelId / catalogCacheId for "is this
 * the same model?" decisions. Rows without either FK fall back to
 * brand+model, which works but is slower to query and breaks if data
 * entry typos differ between rows of the truly-same model.
 *
 * Strategy per non-linked fleet row:
 *   1. Look for an existing equipment_models row matching
 *      (category, brand, model) case-insensitively. Link it if found.
 *   2. Otherwise create a fresh equipment_models row from the fleet's
 *      own (category, brand, model[, displayName, dailyRate, ...]).
 *      Skip rows where category is null — equipment_models requires it.
 *   3. Best-effort: also link catalogCacheId by case-insensitive match
 *      on (brand, model). Don't create catalog rows here (catalog comes
 *      from external sync, not derived data).
 *
 * Usage:
 *   tsx scripts/backfill-fleet-model.ts             # dry-run (default — prints, no writes)
 *   tsx scripts/backfill-fleet-model.ts --commit    # actually write the changes
 */

type FleetRow = {
  id: number;
  brand: string;
  model: string;
  category: string | null;
  year: number | null;
  catalogCacheId: number | null;
  equipmentModelId: number | null;
  imageUrl: string | null;
  dailyRate: string | null;
  weeklyRate: string | null;
  monthlyRate: string | null;
  twentyEightDayRate: string | null;
};

const COMMIT = process.argv.includes("--commit");

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable — check DATABASE_URL");

  console.log(COMMIT ? "── COMMIT mode (writes will happen) ──" : "── DRY-RUN (no writes; pass --commit to apply) ──");

  // Pull non-deleted, non-retired fleet rows that need backfill.
  const candidates = await db
    .select({
      id: schema.rentalFleet.id,
      brand: schema.rentalFleet.brand,
      model: schema.rentalFleet.model,
      category: schema.rentalFleet.category,
      year: schema.rentalFleet.year,
      catalogCacheId: schema.rentalFleet.catalogCacheId,
      equipmentModelId: schema.rentalFleet.equipmentModelId,
      imageUrl: schema.rentalFleet.imageUrl,
      dailyRate: schema.rentalFleet.dailyRate,
      weeklyRate: schema.rentalFleet.weeklyRate,
      monthlyRate: schema.rentalFleet.monthlyRate,
      twentyEightDayRate: schema.rentalFleet.twentyEightDayRate,
    })
    .from(schema.rentalFleet)
    .where(and(
      isNull(schema.rentalFleet.deletedAt),
      ne(schema.rentalFleet.currentStatus, "retired"),
    ));

  console.log(`Scanning ${candidates.length} non-retired fleet rows.`);

  // In-memory cache of equipment_models we've matched/created in this run, keyed
  // by `${category}|${brand}|${model}` lowercased.
  const modelCache = new Map<string, number>();

  let linkedExisting = 0;
  let linkedCreated = 0;
  let linkedCatalog = 0;
  let skippedAlready = 0;
  let skippedNoCategory = 0;
  let failed = 0;

  for (const row of candidates as FleetRow[]) {
    if (row.equipmentModelId) {
      skippedAlready += 1;
      continue;
    }
    if (!row.category) {
      skippedNoCategory += 1;
      console.warn(`  fleet#${row.id} ${row.brand} ${row.model}: SKIP — no category, can't create model`);
      continue;
    }

    try {
      const cacheKey = `${row.category.trim().toLowerCase()}|${row.brand.trim().toLowerCase()}|${row.model.trim().toLowerCase()}`;
      let modelId = modelCache.get(cacheKey);

      if (!modelId) {
        // Case-insensitive lookup of an existing equipment_models row.
        const existing = await db
          .select({ id: schema.equipmentModels.id })
          .from(schema.equipmentModels)
          .where(and(
            isNull(schema.equipmentModels.deletedAt),
            sql`lower(${schema.equipmentModels.category}) = lower(${row.category})`,
            sql`lower(${schema.equipmentModels.brand}) = lower(${row.brand})`,
            sql`lower(${schema.equipmentModels.model}) = lower(${row.model})`,
          ))
          .limit(1);

        if (existing.length > 0) {
          modelId = existing[0].id;
          modelCache.set(cacheKey, modelId);
          linkedExisting += 1;
          console.log(`  fleet#${row.id} ${row.brand} ${row.model} → existing model#${modelId}`);
        } else if (COMMIT) {
          const [created] = await db
            .insert(schema.equipmentModels)
            .values({
              category: row.category,
              brand: row.brand,
              model: row.model,
              displayName: `${row.brand} ${row.model}`,
              imageUrl: row.imageUrl ?? null,
              dailyRate: row.dailyRate ?? null,
              weeklyRate: row.weeklyRate ?? null,
              monthlyRate: row.monthlyRate ?? null,
              twentyEightDayRate: row.twentyEightDayRate ?? null,
            })
            .returning({ id: schema.equipmentModels.id });
          modelId = created.id;
          modelCache.set(cacheKey, modelId);
          linkedCreated += 1;
          console.log(`  fleet#${row.id} ${row.brand} ${row.model} → CREATED model#${modelId}`);
        } else {
          // Dry-run + no existing match: pretend we'd create one.
          modelCache.set(cacheKey, -1);
          modelId = -1;
          linkedCreated += 1;
          console.log(`  fleet#${row.id} ${row.brand} ${row.model} → would CREATE new equipment_model`);
        }
      } else if (modelId === -1) {
        // Dry-run sentinel — same group already counted above.
      } else {
        linkedExisting += 1;
        console.log(`  fleet#${row.id} ${row.brand} ${row.model} → existing model#${modelId} (cached)`);
      }

      // Best-effort catalog link.
      let newCatalogId = row.catalogCacheId;
      if (!newCatalogId) {
        const [match] = await db
          .select({ id: schema.catalogCache.id })
          .from(schema.catalogCache)
          .where(and(
            sql`lower(${schema.catalogCache.brand}) = lower(${row.brand})`,
            sql`lower(${schema.catalogCache.model}) = lower(${row.model})`,
          ))
          .limit(1);
        if (match) {
          newCatalogId = match.id;
          linkedCatalog += 1;
          console.log(`    + catalog#${match.id} matched`);
        }
      }

      // Apply updates.
      if (COMMIT && modelId && modelId !== -1) {
        const update: Record<string, unknown> = { updatedAt: new Date() };
        update.equipmentModelId = modelId;
        if (newCatalogId && newCatalogId !== row.catalogCacheId) {
          update.catalogCacheId = newCatalogId;
        }
        await db.update(schema.rentalFleet).set(update).where(eq(schema.rentalFleet.id, row.id));
      }
    } catch (err) {
      failed += 1;
      console.error(`  fleet#${row.id} ${row.brand} ${row.model}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log("");
  console.log(`Summary (${COMMIT ? "WROTE" : "would write"}):`);
  console.log(`  linked to existing model:  ${linkedExisting}`);
  console.log(`  ${COMMIT ? "created" : "would create"} new model:    ${linkedCreated}`);
  console.log(`  catalog FK ${COMMIT ? "set" : "would set"}:          ${linkedCatalog}`);
  console.log(`  already linked (skipped):  ${skippedAlready}`);
  console.log(`  no category (skipped):     ${skippedNoCategory}`);
  console.log(`  failed:                    ${failed}`);
  if (!COMMIT) console.log("\n(re-run with --commit to apply)");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
