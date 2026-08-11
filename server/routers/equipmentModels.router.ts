import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, superAdminProcedure, moduleGuard } from "../_core/trpc";
import { zMoneyOptional } from "../../shared/zodMoney";
import { getDb, eq, and, isNull, desc, sql, inArray } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { parseCalendarDate, zonedDayRangeUtc } from "../_core/dateUtils";
import { recordPriceVersion, recordCategoryRates, mergeRates, type RateChanges } from "../services/priceVersions";

/** Toronto midnight (today) as a UTC instant — default/earliest effective date. */
function torontoStartOfToday(now: Date = new Date()): Date {
  return zonedDayRangeUtc(now, 0).startUtc;
}

/** Resolve an optional "YYYY-MM-DD" effective date, defaulting to today
 *  (Toronto). Rejects dates before today — we never rewrite price history. */
function resolveEffectiveFrom(raw: string | undefined, now: Date = new Date()): Date {
  const today = torontoStartOfToday(now);
  if (!raw) return today;
  const d = parseCalendarDate(raw);
  if (d.getTime() < today.getTime()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Effective date cannot be in the past" });
  }
  return d;
}

export const equipmentModelsRouter = router({
  list: protectedProcedure.use(moduleGuard('fleet', 'read'))
    .input(z.object({
      category: z.string().optional(),
      search: z.string().optional(),
      onlyWithAssets: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      // equipment_type is no longer the source of truth — it lives on
      // catalog_cache after migration 093. Removed the filter input rather
      // than join through rental_fleet → catalog_cache here, since no
      // client called this with the equipmentType filter set.
      const models = await db
        .select()
        .from(schema.equipmentModels)
        .where(isNull(schema.equipmentModels.deletedAt))
        .orderBy(schema.equipmentModels.category, schema.equipmentModels.brand, schema.equipmentModels.model);

      // Get asset counts per model
      const counts = await db
        .select({
          equipmentModelId: schema.rentalFleet.equipmentModelId,
          totalAssets: sql<number>`count(*)::int`,
          availableAssets: sql<number>`count(CASE WHEN ${schema.rentalFleet.currentStatus} = 'available' THEN 1 END)::int`,
        })
        .from(schema.rentalFleet)
        .where(and(
          isNull(schema.rentalFleet.deletedAt),
          sql`${schema.rentalFleet.equipmentModelId} IS NOT NULL`,
        ))
        .groupBy(schema.rentalFleet.equipmentModelId);

      const countMap = new Map(counts.map(c => [c.equipmentModelId, c]));

      const enriched = models.map(m => ({
        ...m,
        totalAssets: countMap.get(m.id)?.totalAssets || 0,
        availableAssets: countMap.get(m.id)?.availableAssets || 0,
      }));

      return input?.onlyWithAssets ? enriched.filter(m => m.totalAssets > 0) : enriched;
    }),

  getById: protectedProcedure.use(moduleGuard('fleet', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [model] = await db
        .select()
        .from(schema.equipmentModels)
        .where(and(eq(schema.equipmentModels.id, input.id), isNull(schema.equipmentModels.deletedAt)))
        .limit(1);

      if (!model) return null;

      const assets = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(
          eq(schema.rentalFleet.equipmentModelId, input.id),
          isNull(schema.rentalFleet.deletedAt),
        ));

      return { ...model, assets };
    }),

  create: protectedProcedure.use(moduleGuard('fleet', 'create'))
    .input(z.object({
      category: z.string().min(1).max(255),
      brand: z.string().min(1).max(255),
      model: z.string().min(1).max(255),
      displayName: z.string().max(500).optional(),
      imageUrl: z.string().max(2000).optional(),
      dailyRate: zMoneyOptional(),
      weeklyRate: zMoneyOptional(),
      monthlyRate: zMoneyOptional(),
      twentyEightDayRate: zMoneyOptional(),
      description: z.string().max(5000).optional(),
      equipmentType: z.enum(["machine", "attachment"]).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [result] = await db.insert(schema.equipmentModels).values({
        category: input.category,
        brand: input.brand,
        model: input.model,
        displayName: input.displayName || `${input.brand} ${input.model} ${input.category}`,
        imageUrl: input.imageUrl,
        dailyRate: input.dailyRate,
        weeklyRate: input.weeklyRate,
        monthlyRate: input.monthlyRate,
        twentyEightDayRate: input.twentyEightDayRate,
        description: input.description,
        equipmentType: input.equipmentType ?? "machine",
      }).returning();

      // Seed the baseline price version so every model has a version timeline.
      await recordPriceVersion(db, {
        modelId: result.id,
        rates: mergeRates({}, {
          dailyRate: input.dailyRate,
          weeklyRate: input.weeklyRate,
          monthlyRate: input.monthlyRate,
          twentyEightDayRate: input.twentyEightDayRate,
        }),
        effectiveFrom: torontoStartOfToday(),
        source: "manual",
        createdBy: ctx.user?.id ?? null,
      });

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "equipment_model",
        entityId: result.id,
        metadata: { brand: input.brand, model: input.model },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('fleet', 'update'))
    .input(z.object({
      id: z.number(),
      displayName: z.string().max(500).optional(),
      imageUrl: z.string().max(2000).optional(),
      dailyRate: zMoneyOptional(),
      weeklyRate: zMoneyOptional(),
      monthlyRate: zMoneyOptional(),
      twentyEightDayRate: zMoneyOptional(),
      description: z.string().max(5000).optional(),
      equipmentType: z.enum(["machine", "attachment"]).optional(),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const now = new Date();
      const { id, effectiveFrom, dailyRate, weeklyRate, monthlyRate, twentyEightDayRate, ...nonRate } = input;

      // Non-rate fields update in place; rate changes go through effective-dated
      // versioning so history is preserved and future changes can be scheduled.
      const [result] = await db
        .update(schema.equipmentModels)
        .set({ ...nonRate, updatedAt: now })
        .where(and(eq(schema.equipmentModels.id, id), isNull(schema.equipmentModels.deletedAt)))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND" });

      const rateChanges: RateChanges = { dailyRate, weeklyRate, monthlyRate, twentyEightDayRate };
      if (Object.values(rateChanges).some((v) => v !== undefined)) {
        await recordPriceVersion(db, {
          modelId: id,
          rates: mergeRates(result, rateChanges),
          effectiveFrom: resolveEffectiveFrom(effectiveFrom, now),
          source: "manual",
          createdBy: ctx.user?.id ?? null,
          now,
        });
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "equipment_model",
        entityId: id,
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('fleet', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.update(schema.equipmentModels)
        .set({ deletedAt: new Date() })
        .where(eq(schema.equipmentModels.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "equipment_model",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  // Batch update rates for all models in a category. Rates are stored as
  // effective-dated versions (history preserved, future changes schedulable);
  // the equipment_models columns remain the "currently effective" cache.
  updateCategoryRates: protectedProcedure.use(moduleGuard('fleet', 'update'))
    .input(z.object({
      category: z.string().min(1),
      dailyRate: zMoneyOptional(),
      weeklyRate: zMoneyOptional(),
      monthlyRate: zMoneyOptional(),
      twentyEightDayRate: zMoneyOptional(),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      note: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const now = new Date();
      const { category, effectiveFrom, note, ...rates } = input;
      const effFrom = resolveEffectiveFrom(effectiveFrom, now);

      const { updatedCount } = await recordCategoryRates(db, {
        category,
        changes: rates,
        effectiveFrom: effFrom,
        note,
        createdBy: ctx.user?.id ?? null,
        now,
      });

      const scheduled = effFrom.getTime() > torontoStartOfToday(now).getTime();
      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "equipment_model",
        entityId: 0,
        metadata: { category, updatedCount, effectiveFrom: effFrom.toISOString(), scheduled, ...rates },
        ipAddress: ctx.req?.ip,
      });

      return { updatedCount, scheduled, effectiveFrom: effFrom.toISOString() };
    }),

  // Effective-dated price timeline for a category (current + history + future).
  categoryPriceTimeline: protectedProcedure.use(moduleGuard('fleet', 'read'))
    .input(z.object({ category: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const models = await db
        .select({ id: schema.equipmentModels.id })
        .from(schema.equipmentModels)
        .where(and(eq(schema.equipmentModels.category, input.category), isNull(schema.equipmentModels.deletedAt)));
      if (models.length === 0) return [];

      const rows = await db
        .select({
          dailyRate: schema.equipmentModelPriceVersions.dailyRate,
          weeklyRate: schema.equipmentModelPriceVersions.weeklyRate,
          monthlyRate: schema.equipmentModelPriceVersions.monthlyRate,
          twentyEightDayRate: schema.equipmentModelPriceVersions.twentyEightDayRate,
          effectiveFrom: schema.equipmentModelPriceVersions.effectiveFrom,
          effectiveTo: schema.equipmentModelPriceVersions.effectiveTo,
          source: schema.equipmentModelPriceVersions.source,
          note: schema.equipmentModelPriceVersions.note,
        })
        .from(schema.equipmentModelPriceVersions)
        .where(inArray(schema.equipmentModelPriceVersions.equipmentModelId, models.map((m) => m.id)))
        .orderBy(desc(schema.equipmentModelPriceVersions.effectiveFrom));

      // Models in a category share uniform rates, so collapse to one timeline by
      // effective_from (keep the first row seen per date).
      const now = Date.now();
      const seen = new Set<number>();
      const timeline = [];
      for (const r of rows) {
        const key = r.effectiveFrom.getTime();
        if (seen.has(key)) continue;
        seen.add(key);
        const to = r.effectiveTo ? r.effectiveTo.getTime() : Infinity;
        timeline.push({
          effectiveFrom: r.effectiveFrom,
          effectiveTo: r.effectiveTo,
          dailyRate: r.dailyRate,
          weeklyRate: r.weeklyRate,
          monthlyRate: r.monthlyRate,
          twentyEightDayRate: r.twentyEightDayRate,
          source: r.source,
          note: r.note,
          isCurrent: key <= now && now < to,
          isFuture: key > now,
        });
      }
      return timeline;
    }),

  // Used by fleet creation to auto-link or create model
  findOrCreate: protectedProcedure.use(moduleGuard('fleet', 'create'))
    .input(z.object({
      category: z.string().min(1).max(255),
      brand: z.string().min(1).max(255),
      model: z.string().min(1).max(255),
      dailyRate: zMoneyOptional(),
      weeklyRate: zMoneyOptional(),
      monthlyRate: zMoneyOptional(),
      imageUrl: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Try find existing
      const [existing] = await db
        .select()
        .from(schema.equipmentModels)
        .where(and(
          eq(schema.equipmentModels.brand, input.brand),
          eq(schema.equipmentModels.model, input.model),
          eq(schema.equipmentModels.category, input.category),
          isNull(schema.equipmentModels.deletedAt),
        ))
        .limit(1);

      if (existing) return existing;

      // Create new
      const [created] = await db.insert(schema.equipmentModels).values({
        category: input.category,
        brand: input.brand,
        model: input.model,
        displayName: `${input.brand} ${input.model} ${input.category}`,
        dailyRate: input.dailyRate,
        weeklyRate: input.weeklyRate,
        monthlyRate: input.monthlyRate,
        imageUrl: input.imageUrl,
      }).returning();

      // Seed the baseline price version so every model has a version timeline.
      await recordPriceVersion(db, {
        modelId: created.id,
        rates: mergeRates({}, {
          dailyRate: input.dailyRate,
          weeklyRate: input.weeklyRate,
          monthlyRate: input.monthlyRate,
        }),
        effectiveFrom: torontoStartOfToday(),
        source: "manual",
      });

      return created;
    }),

  /**
   * Phase 4: One-time data backfill for category pricing migration.
   * Super admin only.
   *
   * Step 4a: Link orphaned fleet assets to equipmentModels (or create models)
   * Step 4b: Sync rates — copy fleet rates to models that have no rates
   * Step 4c: Clear duplicate fleet rates where fleet.rate == model.rate
   */
  backfillCategoryPricing: superAdminProcedure
    .input(z.object({ dryRun: z.boolean().default(true) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const results = {
        step4a: { linked: 0, created: 0, alreadyLinked: 0 },
        step4b: { synced: 0, skipped: 0 },
        step4c: { cleared: 0, kept: 0 },
        dryRun: input.dryRun,
      };

      // ─── Step 4a: Link orphaned fleet → equipmentModels ───
      const orphanedFleet = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(
          isNull(schema.rentalFleet.equipmentModelId),
          isNull(schema.rentalFleet.deletedAt),
        ));

      for (const fleet of orphanedFleet) {
        const category = fleet.category || "Uncategorized";

        // Try to find existing model
        const [existingModel] = await db
          .select()
          .from(schema.equipmentModels)
          .where(and(
            eq(schema.equipmentModels.brand, fleet.brand),
            eq(schema.equipmentModels.model, fleet.model),
            eq(schema.equipmentModels.category, category),
            isNull(schema.equipmentModels.deletedAt),
          ))
          .limit(1);

        if (existingModel) {
          if (!input.dryRun) {
            await db.update(schema.rentalFleet)
              .set({ equipmentModelId: existingModel.id, updatedAt: new Date() })
              .where(eq(schema.rentalFleet.id, fleet.id));
          }
          results.step4a.linked++;
        } else {
          // Create new model
          if (!input.dryRun) {
            const [newModel] = await db.insert(schema.equipmentModels).values({
              category,
              brand: fleet.brand,
              model: fleet.model,
              displayName: `${fleet.brand} ${fleet.model}${category !== 'Uncategorized' ? ' ' + category : ''}`,
            }).returning();
            await db.update(schema.rentalFleet)
              .set({ equipmentModelId: newModel.id, updatedAt: new Date() })
              .where(eq(schema.rentalFleet.id, fleet.id));
          }
          results.step4a.created++;
        }
      }

      results.step4a.alreadyLinked = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.rentalFleet)
        .where(and(
          sql`${schema.rentalFleet.equipmentModelId} IS NOT NULL`,
          isNull(schema.rentalFleet.deletedAt),
        ))
        .then(r => r[0]?.count || 0);

      // ─── Step 4b: Sync fleet rates → models (only if model has no rates) ───
      const allModels = await db
        .select()
        .from(schema.equipmentModels)
        .where(isNull(schema.equipmentModels.deletedAt));

      for (const model of allModels) {
        const hasRates = (model.dailyRate && parseFloat(model.dailyRate) > 0) ||
                         (model.weeklyRate && parseFloat(model.weeklyRate) > 0) ||
                         (model.monthlyRate && parseFloat(model.monthlyRate) > 0);

        if (hasRates) {
          results.step4b.skipped++;
          continue;
        }

        // Find the first fleet asset with rates for this model
        const [donor] = await db
          .select()
          .from(schema.rentalFleet)
          .where(and(
            eq(schema.rentalFleet.equipmentModelId, model.id),
            isNull(schema.rentalFleet.deletedAt),
            sql`(${schema.rentalFleet.dailyRate} IS NOT NULL AND ${schema.rentalFleet.dailyRate} != '0')`,
          ))
          .limit(1);

        if (donor) {
          if (!input.dryRun) {
            await db.update(schema.equipmentModels)
              .set({
                dailyRate: donor.dailyRate,
                weeklyRate: donor.weeklyRate,
                monthlyRate: donor.monthlyRate,
                twentyEightDayRate: donor.twentyEightDayRate,
                updatedAt: new Date(),
              })
              .where(eq(schema.equipmentModels.id, model.id));
          }
          results.step4b.synced++;
        } else {
          results.step4b.skipped++;
        }
      }

      // ─── Step 4c: Clear duplicate fleet rates (fleet == model → set fleet to NULL) ───
      // Re-fetch models after step 4b may have updated them
      const updatedModels = input.dryRun ? allModels : await db
        .select()
        .from(schema.equipmentModels)
        .where(isNull(schema.equipmentModels.deletedAt));

      const modelMap = new Map(updatedModels.map(m => [m.id, m]));

      const allFleet = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(
          sql`${schema.rentalFleet.equipmentModelId} IS NOT NULL`,
          isNull(schema.rentalFleet.deletedAt),
          sql`(${schema.rentalFleet.dailyRate} IS NOT NULL OR ${schema.rentalFleet.weeklyRate} IS NOT NULL OR ${schema.rentalFleet.monthlyRate} IS NOT NULL)`,
        ));

      for (const fleet of allFleet) {
        const model = modelMap.get(fleet.equipmentModelId!);
        if (!model) continue;

        // Check if fleet rates match model rates exactly (use parseFloat for reliable numeric comparison)
        const dailyMatch = parseFloat(fleet.dailyRate || "0") === parseFloat(model.dailyRate || "0");
        const weeklyMatch = parseFloat(fleet.weeklyRate || "0") === parseFloat(model.weeklyRate || "0");
        const monthlyMatch = parseFloat(fleet.monthlyRate || "0") === parseFloat(model.monthlyRate || "0");

        if (dailyMatch && weeklyMatch && monthlyMatch) {
          if (!input.dryRun) {
            await db.update(schema.rentalFleet)
              .set({
                dailyRate: null,
                weeklyRate: null,
                monthlyRate: null,
                twentyEightDayRate: null,
                updatedAt: new Date(),
              })
              .where(eq(schema.rentalFleet.id, fleet.id));
          }
          results.step4c.cleared++;
        } else {
          results.step4c.kept++;
        }
      }

      return results;
    }),
});
