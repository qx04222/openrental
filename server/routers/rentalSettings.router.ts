import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, sql, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { calculateTax, getAllTaxRates } from "../services/taxCalculation";
import { INSURANCE_OPTIONS } from "../../shared/insurance";

export const rentalSettingsRouter = router({
  getAll: protectedProcedure.use(moduleGuard('settings', 'read'))
    .input(z.object({ category: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const results = await db.select().from(schema.rentalSettings);
      if (input?.category) {
        return results.filter((r) => r.category === input.category);
      }
      return results;
    }),

  getByKey: protectedProcedure.use(moduleGuard('settings', 'read'))
    .input(z.object({ key: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [result] = await db
        .select()
        .from(schema.rentalSettings)
        .where(eq(schema.rentalSettings.key, input.key))
        .limit(1);
      return result || null;
    }),

  update: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({ key: z.string(), value: z.string(), description: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.execute(sql`
        INSERT INTO rental_settings (key, value, description, "updatedAt")
        VALUES (${input.key}, ${input.value}, ${input.description || null}, NOW())
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          description = COALESCE(EXCLUDED.description, rental_settings.description),
          "updatedAt" = NOW()
      `);
      return true;
    }),

  create: protectedProcedure.use(moduleGuard('settings', 'create'))
    .input(
      z.object({
        key: z.string(),
        value: z.string(),
        description: z.string().optional(),
        category: z.enum(["insurance", "deposits", "pricing", "rental_rules"]).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [result] = await db
        .insert(schema.rentalSettings)
        .values({
          key: input.key,
          value: input.value,
          description: input.description,
          category: input.category,
        })
        .returning();
      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('settings', 'delete'))
    .input(z.object({ key: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.delete(schema.rentalSettings).where(eq(schema.rentalSettings.key, input.key));
      return true;
    }),

  getBusinessHours: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { start: "08:00", end: "17:00", days: "Mon,Tue,Wed,Thu,Fri" };

    const results = await db.select().from(schema.rentalSettings);
    const settingsMap = Object.fromEntries(results.map((r) => [r.key, r.value]));

    return {
      start: settingsMap["business_hours_start"] || "08:00",
      end: settingsMap["business_hours_end"] || "17:00",
      days: settingsMap["business_days"] || "Mon,Tue,Wed,Thu,Fri",
    };
  }),

  saveBusinessHours: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({ start: z.string(), end: z.string(), days: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      for (const [key, value] of [
        ["business_hours_start", input.start],
        ["business_hours_end", input.end],
        ["business_days", input.days],
      ]) {
        await db.execute(sql`
          INSERT INTO rental_settings (key, value, category, "updatedAt")
          VALUES (${key}, ${value}, 'rental_rules', NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW()
        `);
      }
      return true;
    }),

  getInsuranceOptions: publicProcedure.query(async () => {
    // Return static options + dynamic rates from settings
    const db = await getDb();
    if (!db) return INSURANCE_OPTIONS;

    const results = await db.select().from(schema.rentalSettings);
    const settingsMap = Object.fromEntries(results.map((r) => [r.key, r.value]));

    return {
      none: INSURANCE_OPTIONS.none,
      basic: {
        ...INSURANCE_OPTIONS.basic,
        costPercentage: parseFloat(settingsMap["insurance_basic_rate"] || "0.15"),
        deductible: parseInt(settingsMap["insurance_basic_deductible"] || "1000"),
      },
      full: {
        ...INSURANCE_OPTIONS.full,
        costPercentage: parseFloat(settingsMap["insurance_full_rate"] || "0.25"),
        deductible: parseInt(settingsMap["insurance_full_deductible"] || "0"),
      },
    };
  }),

  calculateDepositForFleet: publicProcedure
    .input(z.object({ rentalFleetId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [fleet] = await db
        .select()
        .from(schema.rentalFleet)
        .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
        .where(and(eq(schema.rentalFleet.id, input.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);

      if (!fleet) throw new TRPCError({ code: "NOT_FOUND", message: "Equipment not found" });

      const msrp = fleet.catalog_cache?.msrp ? parseFloat(fleet.catalog_cache.msrp) : null;
      const { calculateDepositFromRules } = await import("../services/depositCalculation");
      const result = await calculateDepositFromRules(
        fleet.rental_fleet.category,
        msrp,
      );
      return { deposit: result.deposit, msrp, division: fleet.rental_fleet.division, rule: result.rule, breakdown: result.breakdown };
    }),

  calculateTaxForProvince: publicProcedure
    .input(
      z.object({
        province: z.string().min(2).max(2),
        rentalAmount: z.number(),
        shippingAmount: z.number().default(0),
        ldwAmount: z.number().default(0),
        depositAmount: z.number().default(0),
      })
    )
    .query(async ({ input }) => {
      return calculateTax(input);
    }),

  getTaxRates: publicProcedure.query(async () => {
    return getAllTaxRates();
  }),

  addTaxRate: protectedProcedure
    .input(z.object({
      province: z.string().min(2).max(2),
      provinceName: z.string().min(1),
      gstRate: z.number().min(0).max(1),
      pstRate: z.number().min(0).max(1),
      hstRate: z.number().min(0).max(1),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can add tax rates" });
      }
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.execute(sql`
        INSERT INTO tax_rates (province, "provinceName", "gstRate", "pstRate", "hstRate", "isActive")
        VALUES (${input.province.toUpperCase()}, ${input.provinceName}, ${input.gstRate}, ${input.pstRate}, ${input.hstRate}, true)
        ON CONFLICT (province) DO UPDATE SET
          "provinceName" = EXCLUDED."provinceName",
          "gstRate" = EXCLUDED."gstRate",
          "pstRate" = EXCLUDED."pstRate",
          "hstRate" = EXCLUDED."hstRate",
          "isActive" = true
      `);
      return true;
    }),

  updateTaxRate: protectedProcedure
    .input(z.object({
      province: z.string().min(2).max(2),
      gstRate: z.number().min(0).max(1),
      pstRate: z.number().min(0).max(1),
      hstRate: z.number().min(0).max(1),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can update tax rates" });
      }
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await db.execute(sql`
        UPDATE tax_rates
        SET "gstRate" = ${input.gstRate}, "pstRate" = ${input.pstRate}, "hstRate" = ${input.hstRate}
        WHERE province = ${input.province.toUpperCase()}
      `);
      return true;
    }),
});
