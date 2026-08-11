/**
 * Effective-dated pricing for equipment models.
 *
 * `equipment_models.{daily,weekly,monthly,twentyEightDay}Rate` is a denormalized
 * "currently effective" cache. `equipment_model_price_versions` is the source of
 * truth for the full price history plus future-scheduled changes. Versions for a
 * model form a non-overlapping [effective_from, effective_to) chain with exactly
 * one open (effective_to = null) tail.
 *
 * - Live quotes read the cache (= today's rate), so they need no change.
 * - Recording a change supersedes/splits the covering version (never overwrites
 *   history) and refreshes the cache when the change is effective as of now.
 * - A daily cron (promoteEffectiveRates) flips the cache to a future version
 *   once its effective_from arrives.
 * - priceRecalculation resolves the rate as-of an order's creation date.
 *
 * The interval math is isolated in pure functions (selectVersionAsOf /
 * planVersionChange) so it is unit-testable without a database.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { zonedDayRangeUtc } from "../_core/dateUtils";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface RateSet {
  dailyRate: string | null;
  weeklyRate: string | null;
  monthlyRate: string | null;
  twentyEightDayRate: string | null;
}

export type RateChanges = { dailyRate?: string; weeklyRate?: string; monthlyRate?: string; twentyEightDayRate?: string };

/** The full rate set a version must carry = current model rates overlaid with
 *  the provided (defined) changes. `undefined` means "unchanged". */
export function mergeRates(current: Partial<RateSet>, changes: RateChanges): RateSet {
  const pick = (k: keyof RateSet): string | null =>
    changes[k] !== undefined ? changes[k]! : (current[k] ?? null);
  return {
    dailyRate: pick("dailyRate"),
    weeklyRate: pick("weeklyRate"),
    monthlyRate: pick("monthlyRate"),
    twentyEightDayRate: pick("twentyEightDayRate"),
  };
}

export interface PriceVersionRow extends RateSet {
  id: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** The version whose [from, to) interval contains `asOf`, or null. */
export function selectVersionAsOf<T extends { effectiveFrom: Date; effectiveTo: Date | null }>(
  versions: T[],
  asOf: Date,
): T | null {
  const t = asOf.getTime();
  let best: T | null = null;
  for (const v of versions) {
    const from = v.effectiveFrom.getTime();
    const to = v.effectiveTo ? v.effectiveTo.getTime() : Infinity;
    if (from <= t && t < to) {
      if (!best || from > best.effectiveFrom.getTime()) best = v;
    }
  }
  return best;
}

export type VersionPlan =
  | { action: "update"; id: number; rates: RateSet }
  | { action: "split"; closeId: number; closeTo: Date; insert: { effectiveFrom: Date; effectiveTo: Date | null; rates: RateSet } }
  | { action: "insert"; insert: { effectiveFrom: Date; effectiveTo: Date | null; rates: RateSet } };

/**
 * Pure: how to record `rates` effective from `effectiveFrom` given a model's
 * existing versions. Forward-only — the caller guarantees effectiveFrom is today
 * or later, so the covering version is always the open tail or a future closed
 * interval (never a past one), and history is never rewritten.
 *
 * - same start as the covering version → edit it in place (same-day re-edit)
 * - otherwise → split: close the covering version at effectiveFrom, insert a new
 *   one spanning [effectiveFrom, covering.effectiveTo) (tail stays open)
 * - no covering version (empty chain) → insert an open tail
 */
export function planVersionChange(
  versions: PriceVersionRow[],
  effectiveFrom: Date,
  rates: RateSet,
): VersionPlan {
  const containing = selectVersionAsOf(versions, effectiveFrom);
  if (!containing) {
    return { action: "insert", insert: { effectiveFrom, effectiveTo: null, rates } };
  }
  if (containing.effectiveFrom.getTime() === effectiveFrom.getTime()) {
    return { action: "update", id: containing.id, rates };
  }
  return {
    action: "split",
    closeId: containing.id,
    closeTo: effectiveFrom,
    insert: { effectiveFrom, effectiveTo: containing.effectiveTo, rates },
  };
}

const RATE_KEYS = ["dailyRate", "weeklyRate", "monthlyRate", "twentyEightDayRate"] as const;

function ratesEqual(a: RateSet, b: RateSet): boolean {
  return RATE_KEYS.every((k) => parseFloat(a[k] || "0") === parseFloat(b[k] || "0"));
}

function pickRates(row: RateSet): RateSet {
  return {
    dailyRate: row.dailyRate,
    weeklyRate: row.weeklyRate,
    monthlyRate: row.monthlyRate,
    twentyEightDayRate: row.twentyEightDayRate,
  };
}

async function loadVersions(db: Db, modelId: number): Promise<PriceVersionRow[]> {
  return db
    .select({
      id: schema.equipmentModelPriceVersions.id,
      dailyRate: schema.equipmentModelPriceVersions.dailyRate,
      weeklyRate: schema.equipmentModelPriceVersions.weeklyRate,
      monthlyRate: schema.equipmentModelPriceVersions.monthlyRate,
      twentyEightDayRate: schema.equipmentModelPriceVersions.twentyEightDayRate,
      effectiveFrom: schema.equipmentModelPriceVersions.effectiveFrom,
      effectiveTo: schema.equipmentModelPriceVersions.effectiveTo,
    })
    .from(schema.equipmentModelPriceVersions)
    .where(eq(schema.equipmentModelPriceVersions.equipmentModelId, modelId))
    .orderBy(schema.equipmentModelPriceVersions.effectiveFrom);
}

export interface RecordPriceVersionOpts {
  modelId: number;
  rates: RateSet;
  effectiveFrom: Date;
  source?: string;
  note?: string | null;
  createdBy?: number | null;
  /** Injectable "now" for tests; defaults to the wall clock. */
  now?: Date;
}

/**
 * Record a price change as a new version (supersede/split — never overwrite),
 * and refresh the equipment_models cache when the change is effective as of now.
 * Returns whether the cache was updated (i.e. the change is live, not future).
 */
export async function recordPriceVersion(db: Db, opts: RecordPriceVersionOpts): Promise<{ effectiveNow: boolean }> {
  const now = opts.now ?? new Date();
  const versions = await loadVersions(db, opts.modelId);
  const plan = planVersionChange(versions, opts.effectiveFrom, opts.rates);
  const meta = { source: opts.source ?? "manual", note: opts.note ?? null, createdBy: opts.createdBy ?? null };

  if (plan.action === "update") {
    await db
      .update(schema.equipmentModelPriceVersions)
      .set({ ...plan.rates, ...meta })
      .where(eq(schema.equipmentModelPriceVersions.id, plan.id));
  } else if (plan.action === "split") {
    await db
      .update(schema.equipmentModelPriceVersions)
      .set({ effectiveTo: plan.closeTo, supersededAt: now })
      .where(eq(schema.equipmentModelPriceVersions.id, plan.closeId));
    await db.insert(schema.equipmentModelPriceVersions).values({
      equipmentModelId: opts.modelId,
      ...plan.insert.rates,
      effectiveFrom: plan.insert.effectiveFrom,
      effectiveTo: plan.insert.effectiveTo,
      ...meta,
    });
  } else {
    await db.insert(schema.equipmentModelPriceVersions).values({
      equipmentModelId: opts.modelId,
      ...plan.insert.rates,
      effectiveFrom: plan.insert.effectiveFrom,
      effectiveTo: plan.insert.effectiveTo,
      ...meta,
    });
  }

  const effectiveNow = opts.effectiveFrom.getTime() <= now.getTime();
  if (effectiveNow) {
    await db
      .update(schema.equipmentModels)
      .set({ ...opts.rates, updatedAt: now })
      .where(eq(schema.equipmentModels.id, opts.modelId));
  }
  return { effectiveNow };
}

/**
 * The rate set in effect for `modelId` on `asOf`. Falls back to the
 * equipment_models cache for models that have no covering version row.
 */
export async function getModelRatesAsOf(db: Db, modelId: number, asOf: Date): Promise<RateSet | null> {
  const versions = await loadVersions(db, modelId);
  const v = selectVersionAsOf(versions, asOf);
  if (v) return pickRates(v);

  const [m] = await db
    .select({
      dailyRate: schema.equipmentModels.dailyRate,
      weeklyRate: schema.equipmentModels.weeklyRate,
      monthlyRate: schema.equipmentModels.monthlyRate,
      twentyEightDayRate: schema.equipmentModels.twentyEightDayRate,
    })
    .from(schema.equipmentModels)
    .where(eq(schema.equipmentModels.id, modelId))
    .limit(1);
  return m ? pickRates(m) : null;
}

/**
 * Sync every model's cache to the version effective `now`. Idempotent —
 * run daily so future-scheduled changes go live on their effective date.
 * Returns the number of models whose cache changed.
 */
export async function promoteEffectiveRates(db: Db, now: Date = new Date()): Promise<number> {
  const models = await db
    .select({
      id: schema.equipmentModels.id,
      dailyRate: schema.equipmentModels.dailyRate,
      weeklyRate: schema.equipmentModels.weeklyRate,
      monthlyRate: schema.equipmentModels.monthlyRate,
      twentyEightDayRate: schema.equipmentModels.twentyEightDayRate,
    })
    .from(schema.equipmentModels);

  let changed = 0;
  for (const m of models) {
    const versions = await loadVersions(db, m.id);
    const v = selectVersionAsOf(versions, now);
    if (!v) continue;
    if (!ratesEqual(pickRates(m), pickRates(v))) {
      await db
        .update(schema.equipmentModels)
        .set({
          dailyRate: v.dailyRate,
          weeklyRate: v.weeklyRate,
          monthlyRate: v.monthlyRate,
          twentyEightDayRate: v.twentyEightDayRate,
          updatedAt: now,
        })
        .where(eq(schema.equipmentModels.id, m.id));
      changed++;
    }
  }
  return changed;
}

/** Convenience for callers that have a db handle from getDb(). */
export async function promoteEffectiveRatesNow(now: Date = new Date()): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  return promoteEffectiveRates(db, now);
}

export interface RecordCategoryRatesOpts {
  category: string;
  changes: RateChanges;
  /** Defaults to today (Toronto midnight) — i.e. effective immediately. */
  effectiveFrom?: Date;
  source?: string;
  note?: string | null;
  createdBy?: number | null;
  now?: Date;
}

/**
 * Record a rate change for every model in a category. Categories with no
 * models get an auto-created carrier model (brand=category, model="Default")
 * so a bare category can still hold rates — the same convention the Category
 * Pricing page has always relied on. Returns the number of models touched.
 */
export async function recordCategoryRates(db: Db, opts: RecordCategoryRatesOpts): Promise<{ updatedCount: number }> {
  const now = opts.now ?? new Date();
  const effectiveFrom = opts.effectiveFrom ?? zonedDayRangeUtc(now, 0).startUtc;

  let models = await db
    .select({
      id: schema.equipmentModels.id,
      dailyRate: schema.equipmentModels.dailyRate,
      weeklyRate: schema.equipmentModels.weeklyRate,
      monthlyRate: schema.equipmentModels.monthlyRate,
      twentyEightDayRate: schema.equipmentModels.twentyEightDayRate,
    })
    .from(schema.equipmentModels)
    .where(and(eq(schema.equipmentModels.category, opts.category), isNull(schema.equipmentModels.deletedAt)));

  if (models.length === 0) {
    const [newModel] = await db.insert(schema.equipmentModels).values({
      category: opts.category,
      brand: opts.category,
      model: "Default",
      displayName: opts.category,
    }).returning();
    models = [{ id: newModel.id, dailyRate: null, weeklyRate: null, monthlyRate: null, twentyEightDayRate: null }];
  }

  for (const m of models) {
    await recordPriceVersion(db, {
      modelId: m.id,
      rates: mergeRates(m, opts.changes),
      effectiveFrom,
      source: opts.source ?? "manual",
      note: opts.note ?? null,
      createdBy: opts.createdBy ?? null,
      now,
    });
  }

  return { updatedCount: models.length };
}
