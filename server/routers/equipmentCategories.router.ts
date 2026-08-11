import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, publicProcedure, moduleGuard } from "../_core/trpc";
import { zMoneyOptional } from "../../shared/zodMoney";
import { getDb, eq, and, isNull, asc, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { recordCategoryRates } from "../services/priceVersions";

export const equipmentCategoriesRouter = router({
  // Full list for admin (includes equipment counts)
  list: protectedProcedure.use(moduleGuard('fleet', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];

    const categories = await db
      .select()
      .from(schema.equipmentCategories)
      .where(isNull(schema.equipmentCategories.deletedAt))
      .orderBy(asc(schema.equipmentCategories.displayOrder), asc(schema.equipmentCategories.name));

    // Count equipment models per category
    const modelCounts = await db
      .select({
        category: schema.equipmentModels.category,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.equipmentModels)
      .where(isNull(schema.equipmentModels.deletedAt))
      .groupBy(schema.equipmentModels.category);

    // Count fleet assets per category
    const fleetCounts = await db
      .select({
        category: schema.rentalFleet.category,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.rentalFleet)
      .where(isNull(schema.rentalFleet.deletedAt))
      .groupBy(schema.rentalFleet.category);

    // Count catalog items per category
    const catalogCounts = await db
      .select({
        category: schema.catalogCache.category,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.catalogCache)
      .groupBy(schema.catalogCache.category);

    const modelMap = new Map(modelCounts.map(c => [c.category, c.count]));
    const fleetMap = new Map(fleetCounts.map(c => [c.category, c.count]));
    const catalogMap = new Map(catalogCounts.map(c => [c.category, c.count]));

    return categories.map(cat => ({
      ...cat,
      modelCount: modelMap.get(cat.name) || 0,
      fleetCount: fleetMap.get(cat.name) || 0,
      catalogCount: catalogMap.get(cat.name) || 0,
    }));
  }),

  // Active-only list for dropdowns (public — no auth required).
  // `type` narrows to machine or attachment categories; omitted = all.
  listActive: publicProcedure
    .input(z.object({ type: z.enum(["machine", "attachment"]).optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const filters = [
        isNull(schema.equipmentCategories.deletedAt),
        eq(schema.equipmentCategories.isActive, true),
      ];
      if (input?.type) filters.push(eq(schema.equipmentCategories.equipmentType, input.type));

      return db
        .select({
          id: schema.equipmentCategories.id,
          name: schema.equipmentCategories.name,
          equipmentType: schema.equipmentCategories.equipmentType,
        })
        .from(schema.equipmentCategories)
        .where(and(...filters))
        .orderBy(asc(schema.equipmentCategories.displayOrder), asc(schema.equipmentCategories.name));
    }),

  create: protectedProcedure.use(moduleGuard('fleet', 'create'))
    .input(z.object({
      name: z.string().min(1).max(255),
      description: z.string().max(2000).optional(),
      displayOrder: z.number().min(0).max(9999).optional(),
      equipmentType: z.enum(["machine", "attachment"]).optional(),
      // Optional rates — recorded immediately via the category-pricing
      // mechanism (carrier "Default" model), same as the Category Pricing page.
      dailyRate: zMoneyOptional(),
      weeklyRate: zMoneyOptional(),
      monthlyRate: zMoneyOptional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Check uniqueness
      const [existing] = await db
        .select()
        .from(schema.equipmentCategories)
        .where(and(
          eq(schema.equipmentCategories.name, input.name),
          isNull(schema.equipmentCategories.deletedAt),
        ))
        .limit(1);

      if (existing) {
        throw new TRPCError({ code: "CONFLICT", message: "A category with this name already exists" });
      }

      const [result] = await db.insert(schema.equipmentCategories).values({
        name: input.name,
        description: input.description,
        displayOrder: input.displayOrder ?? 0,
        equipmentType: input.equipmentType ?? "machine",
      }).returning();

      const rates = { dailyRate: input.dailyRate, weeklyRate: input.weeklyRate, monthlyRate: input.monthlyRate };
      const hasRates = Object.values(rates).some((v) => v !== undefined);
      if (hasRates) {
        await recordCategoryRates(db, {
          category: input.name,
          changes: rates,
          createdBy: ctx.user?.id ?? null,
        });
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "equipment_category",
        entityId: result.id,
        metadata: { name: input.name, equipmentType: input.equipmentType ?? "machine", ...(hasRates ? rates : {}) },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('fleet', 'update'))
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(255).optional(),
      description: z.string().max(2000).optional(),
      displayOrder: z.number().min(0).max(9999).optional(),
      isActive: z.boolean().optional(),
      equipmentType: z.enum(["machine", "attachment"]).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.equipmentCategories)
        .where(and(eq(schema.equipmentCategories.id, input.id), isNull(schema.equipmentCategories.deletedAt)))
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      const { id, ...data } = input;
      const oldName = existing.name;
      const newName = data.name;

      // If renaming, check uniqueness
      if (newName && newName !== oldName) {
        const [dup] = await db
          .select()
          .from(schema.equipmentCategories)
          .where(and(
            eq(schema.equipmentCategories.name, newName),
            isNull(schema.equipmentCategories.deletedAt),
          ))
          .limit(1);

        if (dup) {
          throw new TRPCError({ code: "CONFLICT", message: "A category with this name already exists" });
        }
      }

      const [result] = await db
        .update(schema.equipmentCategories)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(schema.equipmentCategories.id, id))
        .returning();

      // Cascade rename across all 6 referencing tables
      if (newName && newName !== oldName) {
        await db.update(schema.equipmentModels)
          .set({ category: newName, updatedAt: new Date() })
          .where(eq(schema.equipmentModels.category, oldName));

        await db.update(schema.rentalFleet)
          .set({ category: newName, updatedAt: new Date() })
          .where(eq(schema.rentalFleet.category, oldName));

        await db.update(schema.catalogCache)
          .set({ category: newName, updatedAt: new Date() })
          .where(eq(schema.catalogCache.category, oldName));

        await db.update(schema.customerPricing)
          .set({ category: newName, updatedAt: new Date() })
          .where(eq(schema.customerPricing.category, oldName));

        await db.update(schema.depositRules)
          .set({ category: newName, updatedAt: new Date() })
          .where(eq(schema.depositRules.category, oldName));

        await db.update(schema.shippingPricingRules)
          .set({ category: newName, updatedAt: new Date() })
          .where(eq(schema.shippingPricingRules.category, oldName));
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "equipment_category",
        entityId: id,
        metadata: newName && newName !== oldName
          ? { oldName, newName, cascadeRename: true }
          : undefined,
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('fleet', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.equipmentCategories)
        .where(and(eq(schema.equipmentCategories.id, input.id), isNull(schema.equipmentCategories.deletedAt)))
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      // Check references — refuse if any table still uses this category
      const [fleetRef] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.rentalFleet)
        .where(and(
          eq(schema.rentalFleet.category, existing.name),
          isNull(schema.rentalFleet.deletedAt),
        ));

      if ((fleetRef?.count || 0) > 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Cannot delete: category is referenced by ${fleetRef?.count || 0} fleet assets`,
        });
      }

      // Soft-delete the category
      await db.update(schema.equipmentCategories)
        .set({ deletedAt: new Date() })
        .where(eq(schema.equipmentCategories.id, input.id));

      // Cascade: soft-delete orphaned equipment models for this category
      await db.update(schema.equipmentModels)
        .set({ deletedAt: new Date() })
        .where(and(
          eq(schema.equipmentModels.category, existing.name),
          isNull(schema.equipmentModels.deletedAt),
        ));

      // Cascade: remove catalog cache entries for this category
      await db.delete(schema.catalogCache)
        .where(eq(schema.catalogCache.category, existing.name));

      // Cascade: remove pricing/deposit/shipping rules for this category
      await db.delete(schema.customerPricing)
        .where(eq(schema.customerPricing.category, existing.name));

      await db.update(schema.depositRules)
        .set({ deletedAt: new Date() })
        .where(and(
          eq(schema.depositRules.category, existing.name),
          isNull(schema.depositRules.deletedAt),
        ));

      await db.delete(schema.shippingPricingRules)
        .where(eq(schema.shippingPricingRules.category, existing.name));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "equipment_category",
        entityId: input.id,
        metadata: { name: existing.name },
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),
});
