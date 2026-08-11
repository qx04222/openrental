/**
 * recordCategoryRates — category-level pricing entry point shared by the
 * Category Pricing page (updateCategoryRates) and equipmentCategories.create.
 * Covers: carrier-model auto-creation for empty categories, per-model version
 * recording for populated ones, and mergeRates overlay semantics.
 */
import { describe, it, expect } from "vitest";
import * as schema from "../drizzle/schema";
import { recordCategoryRates, mergeRates } from "../server/services/priceVersions";

type Row = Record<string, unknown>;

/** Minimal drizzle-shaped fake: select() consumes `selectQueue` in call order;
 *  insert/update record their rows for assertions. */
function makeFakeDb(selectQueue: Row[][]) {
  const inserts: { table: unknown; values: Row }[] = [];
  const updates: { table: unknown; values: Row }[] = [];
  let nextId = 1000;

  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (rows: Row[]) => void) => resolve(selectQueue.shift() ?? []);
    return chain;
  };

  const db = {
    select: () => makeSelectChain(),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        inserts.push({ table, values });
        return {
          returning: async () => [{ id: nextId++, ...values }],
          then: (resolve: () => void) => resolve(),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => {
        updates.push({ table, values });
        return { where: async () => undefined };
      },
    }),
  };

  return { db: db as never, inserts, updates };
}

describe("mergeRates", () => {
  it("overlays defined changes and keeps current values for undefined ones", () => {
    const merged = mergeRates(
      { dailyRate: "100", weeklyRate: "500", monthlyRate: null, twentyEightDayRate: null },
      { weeklyRate: "550" },
    );
    expect(merged).toEqual({ dailyRate: "100", weeklyRate: "550", monthlyRate: null, twentyEightDayRate: null });
  });
});

describe("recordCategoryRates", () => {
  it("auto-creates a carrier Default model for an empty category and records its rates", async () => {
    const { db, inserts, updates } = makeFakeDb([
      [], // models in category → none
      [], // loadVersions for the new carrier model → empty chain
    ]);

    const result = await recordCategoryRates(db, {
      category: "Hydraulic Breaker",
      changes: { dailyRate: "150", weeklyRate: "750" },
    });

    expect(result.updatedCount).toBe(1);

    const modelInsert = inserts.find((i) => i.table === schema.equipmentModels);
    expect(modelInsert?.values).toMatchObject({
      category: "Hydraulic Breaker",
      brand: "Hydraulic Breaker",
      model: "Default",
      displayName: "Hydraulic Breaker",
    });

    const versionInsert = inserts.find((i) => i.table === schema.equipmentModelPriceVersions);
    expect(versionInsert?.values).toMatchObject({
      dailyRate: "150",
      weeklyRate: "750",
      monthlyRate: null,
      effectiveTo: null,
    });

    // Default effectiveFrom = today → change is live, so the cache refreshes.
    const cacheUpdate = updates.find((u) => u.table === schema.equipmentModels);
    expect(cacheUpdate?.values).toMatchObject({ dailyRate: "150", weeklyRate: "750" });
  });

  it("records a version per existing model without creating a carrier", async () => {
    const models = [
      { id: 1, dailyRate: "100", weeklyRate: null, monthlyRate: null, twentyEightDayRate: null },
      { id: 2, dailyRate: null, weeklyRate: "480", monthlyRate: null, twentyEightDayRate: null },
    ];
    const { db, inserts } = makeFakeDb([
      models, // models in category
      [],     // loadVersions model 1
      [],     // loadVersions model 2
    ]);

    const result = await recordCategoryRates(db, {
      category: "Excavator",
      changes: { dailyRate: "120" },
    });

    expect(result.updatedCount).toBe(2);
    expect(inserts.filter((i) => i.table === schema.equipmentModels)).toHaveLength(0);

    const versions = inserts.filter((i) => i.table === schema.equipmentModelPriceVersions);
    expect(versions).toHaveLength(2);
    // Change overlays each model's own current rates (weekly kept on model 2).
    expect(versions[0].values).toMatchObject({ equipmentModelId: 1, dailyRate: "120", weeklyRate: null });
    expect(versions[1].values).toMatchObject({ equipmentModelId: 2, dailyRate: "120", weeklyRate: "480" });
  });
});
