import { z } from "zod";
import { zMoneyOptional } from "../../shared/zodMoney";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, desc, and, inArray, sql, isNull, gte, lte, or } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { uploadToSupabaseStorage } from "../services/storage";
import { nanoid } from "nanoid";
import { resolvePricing } from "../services/pricingResolution";
import { parseCalendarDate } from "../_core/dateUtils";
import { listOperationalFleetBlocks, listUnbookableFleetIds } from "../services/fleetAvailability";
import { i18nError } from "../_core/i18nError";

const FLEET_IMAGE_BUCKET = "fleet-images";
const MAX_BASE64_SIZE = 10_000_000; // ~7.5MB decoded

async function uploadFleetImage(base64: string): Promise<string> {
  const path = `fleet-images/${Date.now()}_${nanoid(8)}`;
  return uploadToSupabaseStorage(base64, path, FLEET_IMAGE_BUCKET);
}

async function generateAssetNumber(db: NonNullable<Awaited<ReturnType<typeof getDb>>>): Promise<string> {
  const [result] = await db
    .select({ assetNumber: schema.rentalFleet.assetNumber })
    .from(schema.rentalFleet)
    .where(and(sql`${schema.rentalFleet.assetNumber} IS NOT NULL`, isNull(schema.rentalFleet.deletedAt)))
    .orderBy(desc(schema.rentalFleet.assetNumber))
    .limit(1);

  let nextNum = 1;
  if (result?.assetNumber) {
    const match = result.assetNumber.match(/FLEET-(\d+)/);
    if (match) nextNum = parseInt(match[1], 10) + 1;
  }
  return `FLEET-${String(nextNum).padStart(3, "0")}`;
}

// The customer-facing catalog endpoints (getAvailable / getAvailableGroups) are
// publicProcedure — anonymous visitors read their response verbatim in devtools.
// The full rental_fleet row carries internal-only data (purchaseCost, vin,
// internalId, serialNumber, notes, engineHours, odometerReading,
// maintenanceStatus, purchaseDate…), so every rental_fleet object handed back to
// those endpoints' callers must go through this whitelist.
//
// Kept fields = exactly what the public UI consumes:
//   RentEquipment.tsx      → id, brand, model, category, imageUrl
//   EquipmentCard.tsx      → id, brand, model, category, year, imageUrl,
//                            dailyRate, weeklyRate, monthlyRate, currentStatus
//                            (year = subtitle, currentStatus = maintenance badge)
//   useRentalRequest.ts    → id, dailyRate, weeklyRate, monthlyRate (rate fallback)
//
// Server-side logic keeps selecting and reading the full row (pricing resolution,
// grouping, availability); only the response shape is narrowed.
type PublicFleetFields = Pick<
  typeof schema.rentalFleet.$inferSelect,
  | "id"
  | "brand"
  | "model"
  | "category"
  | "year"
  | "imageUrl"
  | "dailyRate"
  | "weeklyRate"
  | "monthlyRate"
  | "currentStatus"
>;

function toPublicFleet(f: typeof schema.rentalFleet.$inferSelect): PublicFleetFields {
  return {
    id: f.id,
    brand: f.brand,
    model: f.model,
    category: f.category,
    year: f.year,
    imageUrl: f.imageUrl,
    dailyRate: f.dailyRate,
    weeklyRate: f.weeklyRate,
    monthlyRate: f.monthlyRate,
    currentStatus: f.currentStatus,
  };
}

const fleetInputFields = {
  catalogCacheId: z.number().nullable().optional(),
  brand: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  category: z.string().max(100).optional(),
  year: z.number().min(1900).max(2100).optional(),
  serialNumber: z.string().max(100).optional(),
  internalId: z.string().max(100).optional(),
  locationId: z.number().optional(),
  division: z.string().max(50).optional(),
  dailyRate: zMoneyOptional(),
  weeklyRate: zMoneyOptional(),
  monthlyRate: zMoneyOptional(),
  engineHours: z.number().min(0).optional(),
  odometerReading: z.number().min(0).optional(),
  condition: z.enum(["excellent", "good", "fair", "poor"]).optional(),
  notes: z.string().max(5000).optional(),
  imageUrl: z.string().max(2000).optional(),
  vin: z.string().max(17).optional(),
  purchaseDate: z.string().max(30).optional(),
  purchaseCost: zMoneyOptional(),
  lastMaintenanceDate: z.string().max(30).optional(),
  nextMaintenanceDate: z.string().max(30).optional(),
  lastServiceHours: z.number().min(0).optional(),
  serviceInterval: z.number().min(0).optional(),
  maintenanceStatus: z.string().max(20).optional(),
};

export const rentalFleetRouter = router({
  list: protectedProcedure.use(moduleGuard('fleet', 'read'))
    .input(z.object({ limit: z.number().min(1).max(1000).optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      // Get category-level rates aggregated across all models per category
      const categoryRates = await db
        .select({
          category: schema.equipmentModels.category,
          dailyRate: sql<string>`MAX(${schema.equipmentModels.dailyRate})`,
          weeklyRate: sql<string>`MAX(${schema.equipmentModels.weeklyRate})`,
          monthlyRate: sql<string>`MAX(${schema.equipmentModels.monthlyRate})`,
        })
        .from(schema.equipmentModels)
        .where(isNull(schema.equipmentModels.deletedAt))
        .groupBy(schema.equipmentModels.category);

      const catRateMap = new Map(categoryRates.map(c => [c.category, c]));

      const rows = await db
        .select({
          rental_fleet: schema.rentalFleet,
          catalog_cache: {
            id: schema.catalogCache.id,
            brand: schema.catalogCache.brand,
            model: schema.catalogCache.model,
            category: schema.catalogCache.category,
            modelYear: schema.catalogCache.modelYear,
            imageUrl: schema.catalogCache.imageUrl,
          },
          warehouses: {
            id: schema.warehouses.id,
            name: schema.warehouses.name,
          },
        })
        .from(schema.rentalFleet)
        .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
        .leftJoin(schema.warehouses, and(eq(schema.rentalFleet.locationId, schema.warehouses.id), isNull(schema.warehouses.deletedAt)))
        .where(isNull(schema.rentalFleet.deletedAt))
        .orderBy(desc(schema.rentalFleet.createdAt))
        .limit(input?.limit ?? 200);

      return rows.map((r) => {
        const catRate = catRateMap.get(r.rental_fleet.category || "");
        const resolved = resolvePricing(
          r.rental_fleet,
          catRate ? { dailyRate: catRate.dailyRate, weeklyRate: catRate.weeklyRate, monthlyRate: catRate.monthlyRate } : null,
        );
        return {
          ...r,
          resolvedDailyRate: resolved.dailyRate,
          resolvedWeeklyRate: resolved.weeklyRate,
          resolvedMonthlyRate: resolved.monthlyRate,
          pricingSource: resolved.source,
        };
      });
    }),

  // Lightweight list for dropdowns (create order modal, etc.)
  listForDropdown: protectedProcedure.use(moduleGuard('fleet', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];

    // Get category-level rates aggregated across all models per category
    const categoryRates = await db
      .select({
        category: schema.equipmentModels.category,
        dailyRate: sql<string>`MAX(${schema.equipmentModels.dailyRate})`,
        weeklyRate: sql<string>`MAX(${schema.equipmentModels.weeklyRate})`,
        monthlyRate: sql<string>`MAX(${schema.equipmentModels.monthlyRate})`,
      })
      .from(schema.equipmentModels)
      .where(isNull(schema.equipmentModels.deletedAt))
      .groupBy(schema.equipmentModels.category);

    const catRateMap = new Map(categoryRates.map(c => [c.category, c]));

    const rows = await db
      .select({
        id: schema.rentalFleet.id,
        brand: schema.rentalFleet.brand,
        model: schema.rentalFleet.model,
        year: schema.rentalFleet.year,
        category: schema.rentalFleet.category,
        currentStatus: schema.rentalFleet.currentStatus,
        assetNumber: schema.rentalFleet.assetNumber,
        serialNumber: schema.rentalFleet.serialNumber,
        dailyRate: schema.rentalFleet.dailyRate,
        weeklyRate: schema.rentalFleet.weeklyRate,
        monthlyRate: schema.rentalFleet.monthlyRate,
      })
      .from(schema.rentalFleet)
      .where(isNull(schema.rentalFleet.deletedAt))
      .orderBy(schema.rentalFleet.brand, schema.rentalFleet.model)
      .limit(500);

    return rows.map((r) => {
      const catRate = catRateMap.get(r.category || "");
      const resolved = resolvePricing(
        { dailyRate: r.dailyRate, weeklyRate: r.weeklyRate, monthlyRate: r.monthlyRate },
        catRate ? { dailyRate: catRate.dailyRate, weeklyRate: catRate.weeklyRate, monthlyRate: catRate.monthlyRate } : null,
      );
      return {
        id: r.id,
        brand: r.brand,
        model: r.model,
        year: r.year,
        category: r.category,
        currentStatus: r.currentStatus,
        assetNumber: r.assetNumber,
        serialNumber: r.serialNumber,
        dailyRate: r.dailyRate,
        weeklyRate: r.weeklyRate,
        monthlyRate: r.monthlyRate,
        resolvedDailyRate: resolved.dailyRate,
        resolvedWeeklyRate: resolved.weeklyRate,
        resolvedMonthlyRate: resolved.monthlyRate,
        pricingSource: resolved.source,
      };
    });
  }),

  getById: protectedProcedure.use(moduleGuard('fleet', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [result] = await db
        .select()
        .from(schema.rentalFleet)
        .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
        .where(and(eq(schema.rentalFleet.id, input.id), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);

      return result || null;
    }),

  create: protectedProcedure.use(moduleGuard('fleet', 'create'))
    .input(z.object(fleetInputFields))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const assetNumber = await generateAssetNumber(db);

      // Auto-upload base64 images to Supabase Storage
      if (input.imageUrl && input.imageUrl.startsWith("data:image/")) {
        input.imageUrl = await uploadFleetImage(input.imageUrl);
      }

      // Auto-link to equipment model
      let equipmentModelId: number | null = null;
      if (input.brand && input.category) {
        const [existingModel] = await db
          .select()
          .from(schema.equipmentModels)
          .where(and(
            eq(schema.equipmentModels.brand, input.brand),
            eq(schema.equipmentModels.model, input.model),
            eq(schema.equipmentModels.category, input.category || "Uncategorized"),
            isNull(schema.equipmentModels.deletedAt),
          ))
          .limit(1);

        if (existingModel) {
          equipmentModelId = existingModel.id;
        } else {
          // Build displayName: prefer "Category - Weight" from catalog, fallback to brand+model
          let displayName = `${input.brand} ${input.model}${input.category ? ' ' + input.category : ''}`;
          if (input.catalogCacheId) {
            const [catalogItem] = await db
              .select({ category: schema.catalogCache.category, operatingWeight: schema.catalogCache.operatingWeight })
              .from(schema.catalogCache)
              .where(eq(schema.catalogCache.id, input.catalogCacheId))
              .limit(1);
            if (catalogItem?.category && catalogItem?.operatingWeight) {
              displayName = `${catalogItem.category} - ${catalogItem.operatingWeight}`;
            } else if (catalogItem?.category) {
              displayName = catalogItem.category;
            }
          }
          // Create model without rates — rates are managed via Category Pricing page
          const [newModel] = await db.insert(schema.equipmentModels).values({
            category: input.category || "Uncategorized",
            brand: input.brand,
            model: input.model,
            displayName,
          }).returning();
          equipmentModelId = newModel.id;
        }
      }

      const dbValues = { ...input, assetNumber, equipmentModelId } as typeof schema.rentalFleet.$inferInsert;
      if (input.purchaseDate) dbValues.purchaseDate = parseCalendarDate(input.purchaseDate);
      else delete dbValues.purchaseDate;
      if (input.lastMaintenanceDate) dbValues.lastMaintenanceDate = parseCalendarDate(input.lastMaintenanceDate);
      else delete dbValues.lastMaintenanceDate;
      if (input.nextMaintenanceDate) dbValues.nextMaintenanceDate = parseCalendarDate(input.nextMaintenanceDate);
      else delete dbValues.nextMaintenanceDate;

      const [result] = await db.insert(schema.rentalFleet).values(dbValues).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "fleet",
        entityId: result.id,
        metadata: { brand: input.brand, model: input.model, assetNumber },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('fleet', 'update'))
    .input(z.object({
      id: z.number(),
      catalogCacheId: z.number().nullable().optional(),
      brand: z.string().max(100).optional(),
      model: z.string().max(200).optional(),
      category: z.string().max(100).optional(),
      year: z.number().min(1900).max(2100).optional(),
      serialNumber: z.string().max(100).optional(),
      internalId: z.string().max(100).optional(),
      currentStatus: z.enum(["available", "rented", "maintenance", "retired"]).optional(),
      locationId: z.number().nullable().optional(),
      division: z.string().max(50).optional(),
      dailyRate: z.string().max(20).optional(),
      weeklyRate: z.string().max(20).optional(),
      monthlyRate: z.string().max(20).optional(),
      engineHours: z.number().min(0).optional(),
      odometerReading: z.number().min(0).optional(),
      condition: z.enum(["excellent", "good", "fair", "poor"]).optional(),
      notes: z.string().max(5000).optional(),
      imageUrl: z.string().max(2000).optional(),
      assetNumber: z.string().max(20).optional(),
      vin: z.string().max(17).optional(),
      purchaseDate: z.string().max(30).nullable().optional(),
      purchaseCost: zMoneyOptional(),
      lastMaintenanceDate: z.string().max(30).nullable().optional(),
      nextMaintenanceDate: z.string().max(30).nullable().optional(),
      lastServiceHours: z.number().min(0).optional(),
      serviceInterval: z.number().min(0).optional(),
      maintenanceStatus: z.string().max(20).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Fetch current values for audit diff
      const [existing] = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(eq(schema.rentalFleet.id, input.id), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);

      // Auto-upload base64 images to Supabase Storage
      if (input.imageUrl && input.imageUrl.startsWith("data:image/")) {
        input.imageUrl = await uploadFleetImage(input.imageUrl);
      }

      // Re-link equipment model if brand/model/category changed
      if (existing && (input.brand || input.model || input.category)) {
        const brand = input.brand || existing.brand;
        const model = input.model || existing.model;
        const category = input.category || existing.category || "Uncategorized";

        if (brand !== existing.brand || model !== existing.model || (input.category !== undefined && input.category !== existing.category)) {
          // 1. Try exact match (brand + model + category)
          const [exactModel] = await db
            .select()
            .from(schema.equipmentModels)
            .where(and(
              eq(schema.equipmentModels.brand, brand),
              eq(schema.equipmentModels.model, model),
              eq(schema.equipmentModels.category, category),
              isNull(schema.equipmentModels.deletedAt),
            ))
            .limit(1);

          if (exactModel) {
            (input as Record<string, unknown>).equipmentModelId = exactModel.id;
          } else {
            // 2. Fallback: find the Default model for this category (inherits category pricing)
            const [defaultModel] = await db
              .select()
              .from(schema.equipmentModels)
              .where(and(
                eq(schema.equipmentModels.category, category),
                eq(schema.equipmentModels.brand, "Default"),
                eq(schema.equipmentModels.model, "Default"),
                isNull(schema.equipmentModels.deletedAt),
              ))
              .limit(1);

            if (defaultModel) {
              // Link to Default model so fleet inherits category pricing
              (input as Record<string, unknown>).equipmentModelId = defaultModel.id;
            } else {
              // 3. No Default model — create a brand-specific model without rates.
              // Use onConflictDoNothing so a concurrent update for the same brand/model/category
              // (which would violate the categoryBrandModelUnique constraint) doesn't throw.
              const [newModel] = await db.insert(schema.equipmentModels).values({
                category,
                brand,
                model,
                displayName: `${brand} ${model}${category !== 'Uncategorized' ? ' ' + category : ''}`,
              }).onConflictDoNothing().returning();
              if (newModel) {
                (input as Record<string, unknown>).equipmentModelId = newModel.id;
              } else {
                // Race: another request already inserted this model; look it up.
                const [racedModel] = await db
                  .select()
                  .from(schema.equipmentModels)
                  .where(and(
                    eq(schema.equipmentModels.category, category),
                    eq(schema.equipmentModels.brand, brand),
                    eq(schema.equipmentModels.model, model),
                    isNull(schema.equipmentModels.deletedAt),
                  ))
                  .limit(1);
                if (racedModel) {
                  (input as Record<string, unknown>).equipmentModelId = racedModel.id;
                }
              }
            }
          }

          // Clear fleet-level rate overrides so category pricing takes effect
          (input as Record<string, unknown>).dailyRate = null;
          (input as Record<string, unknown>).weeklyRate = null;
          (input as Record<string, unknown>).monthlyRate = null;
          (input as Record<string, unknown>).twentyEightDayRate = null;
        }
      }

      const { id, purchaseDate, lastMaintenanceDate, nextMaintenanceDate, ...rest } = input;
      const data: Record<string, unknown> = { ...rest, updatedAt: new Date() };
      if (purchaseDate !== undefined) data.purchaseDate = purchaseDate ? parseCalendarDate(purchaseDate) : null;
      if (lastMaintenanceDate !== undefined) data.lastMaintenanceDate = lastMaintenanceDate ? parseCalendarDate(lastMaintenanceDate) : null;
      if (nextMaintenanceDate !== undefined) data.nextMaintenanceDate = nextMaintenanceDate ? parseCalendarDate(nextMaintenanceDate) : null;

      const [result] = await db
        .update(schema.rentalFleet)
        .set(data)
        .where(eq(schema.rentalFleet.id, id))
        .returning();

      // Audit log: fleet update
      if (existing) {
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        for (const [key, val] of Object.entries(rest)) {
          const existingVal = existing[key as keyof typeof existing];
          if (val !== undefined && String(val) !== String(existingVal ?? "")) {
            changes[key] = { old: existingVal, new: val };
          }
        }
        if (Object.keys(changes).length > 0) {
          await logAudit({
            userId: ctx.user?.id,
            action: "update",
            entityType: "fleet",
            entityId: id,
            changes,
            metadata: { brand: existing.brand, model: existing.model },
            ipAddress: ctx.req?.ip,
          });
        }
      }

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('fleet', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Fetch current record for audit log before deletion
      const [existing] = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(eq(schema.rentalFleet.id, input.id), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);

      // Check for active or pending rentals before deleting
      const activeRentals = await db
        .select({ id: schema.rentalRequests.id })
        .from(schema.rentalRequests)
        .where(
          and(
            eq(schema.rentalRequests.rentalFleetId, input.id),
            inArray(schema.rentalRequests.status, ["pending", "approved", "active"]),
            isNull(schema.rentalRequests.deletedAt)
          )
        )
        .limit(1);

      if (activeRentals.length > 0) {
        throw i18nError({
          code: "CONFLICT",
          message: "Cannot delete equipment with active or pending rentals",
          i18nKey: "errors.fleet.activeRentalDeleteBlocked",
        });
      }

      await db.update(schema.rentalFleet).set({ deletedAt: new Date() }).where(eq(schema.rentalFleet.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "fleet",
        entityId: input.id,
        metadata: existing ? { brand: existing.brand, model: existing.model, serialNumber: existing.serialNumber } : undefined,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  uploadImage: protectedProcedure.use(moduleGuard('fleet', 'update'))
    .input(z.object({
      base64Image: z.string().max(MAX_BASE64_SIZE),
    }))
    .mutation(async ({ input }) => {
      const url = await uploadFleetImage(input.base64Image);
      return { url };
    }),

  // Public endpoint: available categories with counts
  getCategories: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select({
        category: schema.rentalFleet.category,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.rentalFleet)
      .where(and(
        isNull(schema.rentalFleet.deletedAt),
        sql`${schema.rentalFleet.currentStatus} NOT IN ('retired')`,
        sql`${schema.rentalFleet.category} IS NOT NULL`,
      ))
      .groupBy(schema.rentalFleet.category)
      .orderBy(schema.rentalFleet.category);

    return rows as { category: string; count: number }[];
  }),

  // Public endpoint for customer-facing equipment listing
  // Shows all non-retired equipment; optionally checks date availability
  getAvailable: publicProcedure
    .input(z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      category: z.string().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [
        isNull(schema.rentalFleet.deletedAt),
        sql`${schema.rentalFleet.currentStatus} NOT IN ('retired')`,
      ];

      if (input?.category) {
        conditions.push(eq(schema.rentalFleet.category, input.category));
      }

      // Get category-level rates aggregated across all models per category
      const categoryRates = await db
        .select({
          category: schema.equipmentModels.category,
          dailyRate: sql<string>`MAX(${schema.equipmentModels.dailyRate})`,
          weeklyRate: sql<string>`MAX(${schema.equipmentModels.weeklyRate})`,
          monthlyRate: sql<string>`MAX(${schema.equipmentModels.monthlyRate})`,
          twentyEightDayRate: sql<string>`MAX(${schema.equipmentModels.twentyEightDayRate})`,
        })
        .from(schema.equipmentModels)
        .where(isNull(schema.equipmentModels.deletedAt))
        .groupBy(schema.equipmentModels.category);

      const catRateMap = new Map(categoryRates.map(c => [c.category, c]));

      // Get all non-retired equipment with catalog info for display
      const allEquipment = await db
        .select({
          rental_fleet: schema.rentalFleet,
          catalog_cache: {
            id: schema.catalogCache.id,
            brand: schema.catalogCache.brand,
            model: schema.catalogCache.model,
            category: schema.catalogCache.category,
            modelYear: schema.catalogCache.modelYear,
            imageUrl: schema.catalogCache.imageUrl,
            operatingWeight: schema.catalogCache.operatingWeight,
            description: schema.catalogCache.description,
            specifications: schema.catalogCache.specifications,
            enginePower: schema.catalogCache.enginePower,
            bucketCapacity: schema.catalogCache.bucketCapacity,
            ratedLoad: schema.catalogCache.ratedLoad,
            galleryImages: schema.catalogCache.galleryImages,
            brochureUrl: schema.catalogCache.brochureUrl,
            videoUrl: schema.catalogCache.videoUrl,
          },
          warehouse: {
            id: schema.warehouses.id,
            name: schema.warehouses.name,
            city: schema.warehouses.city,
            province: schema.warehouses.province,
          },
        })
        .from(schema.rentalFleet)
        .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
        .leftJoin(schema.warehouses, and(eq(schema.rentalFleet.locationId, schema.warehouses.id), isNull(schema.warehouses.deletedAt)))
        .where(and(...conditions))
        .orderBy(schema.rentalFleet.brand, schema.rentalFleet.model);

      // Build displayName from catalog: "Category - Weight" > category > brand+model
      // Resolve pricing: fleet override → category (aggregated) → none
      const withDisplay = allEquipment.map((item) => {
        const cat = item.catalog_cache?.category;
        const weight = item.catalog_cache?.operatingWeight;
        let displayName: string | null = null;
        if (cat && weight) displayName = `${cat} - ${weight}`;
        else if (cat) displayName = cat;

        const fleetCategory = item.rental_fleet.category || "";
        const catRate = catRateMap.get(fleetCategory);
        const resolved = resolvePricing(
          item.rental_fleet,
          catRate ? { dailyRate: catRate.dailyRate, weeklyRate: catRate.weeklyRate, monthlyRate: catRate.monthlyRate, twentyEightDayRate: catRate.twentyEightDayRate } : null,
        );
        return {
          ...item,
          // Public endpoint: never ship the full fleet row to anonymous callers.
          rental_fleet: toPublicFleet(item.rental_fleet),
          displayName,
          resolvedDailyRate: resolved.dailyRate,
          resolvedWeeklyRate: resolved.weeklyRate,
          resolvedMonthlyRate: resolved.monthlyRate,
          resolvedTwentyEightDayRate: resolved.twentyEightDayRate,
          pricingSource: resolved.source,
        };
      });

      // If no dates provided, return all with availability unknown
      if (!input?.startDate || !input?.endDate) {
        return withDisplay.map((item) => ({
          ...item,
          availableForDates: null as boolean | null,
        }));
      }

      // One shared rule for what a customer may be offered — overlapping
      // bookings, overdue rentals, open work orders and unfinished returns all
      // included. This endpoint used to roll its own and missed the last three.
      const unavailableIds = await listUnbookableFleetIds(db, {
        start: new Date(input.startDate),
        end: new Date(input.endDate),
      });

      return withDisplay.map((item) => ({
        ...item,
        availableForDates: item.rental_fleet.currentStatus === "maintenance"
          ? false
          : !unavailableIds.has(item.rental_fleet.id),
      }));
    }),

  // Customer-facing: same data as getAvailable but pre-grouped by model identity.
  // Each group represents one bookable model with availability counts. Frontend
  // renders groups directly without doing its own aggregation.
  getAvailableGroups: publicProcedure
    .input(z.object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      category: z.string().optional(),
      equipmentType: z.enum(["machine", "attachment"]).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [
        isNull(schema.rentalFleet.deletedAt),
        sql`${schema.rentalFleet.currentStatus} NOT IN ('retired')`,
      ];

      if (input?.category) {
        conditions.push(eq(schema.rentalFleet.category, input.category));
      }

      // Source of truth for attachment marking: catalog_cache.equipment_type
      // (migration 093). Build a catalog_id → type map for downstream tagging.
      const catalogTypeRows = await db
        .select({
          id: schema.catalogCache.id,
          equipmentType: schema.catalogCache.equipmentType,
        })
        .from(schema.catalogCache);
      const catalogTypeMap = new Map(catalogTypeRows.map(r => [r.id, r.equipmentType]));

      const categoryRates = await db
        .select({
          category: schema.equipmentModels.category,
          dailyRate: sql<string>`MAX(${schema.equipmentModels.dailyRate})`,
          weeklyRate: sql<string>`MAX(${schema.equipmentModels.weeklyRate})`,
          monthlyRate: sql<string>`MAX(${schema.equipmentModels.monthlyRate})`,
          twentyEightDayRate: sql<string>`MAX(${schema.equipmentModels.twentyEightDayRate})`,
        })
        .from(schema.equipmentModels)
        .where(isNull(schema.equipmentModels.deletedAt))
        .groupBy(schema.equipmentModels.category);
      const catRateMap = new Map(categoryRates.map(c => [c.category, c]));

      const allEquipment = await db
        .select({
          rental_fleet: schema.rentalFleet,
          catalog_cache: {
            id: schema.catalogCache.id,
            brand: schema.catalogCache.brand,
            model: schema.catalogCache.model,
            category: schema.catalogCache.category,
            modelYear: schema.catalogCache.modelYear,
            imageUrl: schema.catalogCache.imageUrl,
            operatingWeight: schema.catalogCache.operatingWeight,
            description: schema.catalogCache.description,
            specifications: schema.catalogCache.specifications,
            enginePower: schema.catalogCache.enginePower,
            bucketCapacity: schema.catalogCache.bucketCapacity,
            ratedLoad: schema.catalogCache.ratedLoad,
            galleryImages: schema.catalogCache.galleryImages,
            brochureUrl: schema.catalogCache.brochureUrl,
            videoUrl: schema.catalogCache.videoUrl,
          },
          warehouse: {
            id: schema.warehouses.id,
            name: schema.warehouses.name,
            city: schema.warehouses.city,
            province: schema.warehouses.province,
          },
        })
        .from(schema.rentalFleet)
        .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
        .leftJoin(schema.warehouses, and(eq(schema.rentalFleet.locationId, schema.warehouses.id), isNull(schema.warehouses.deletedAt)))
        .where(and(...conditions))
        .orderBy(schema.rentalFleet.brand, schema.rentalFleet.model);

      // Compute date-based blockers up front
      const hasDates = !!(input?.startDate && input?.endDate);
      let blocked = new Set<number>();
      if (hasDates) {
        // Same shared rule as getAvailable — these two endpoints answer the
        // same customer-facing question and must not diverge again.
        blocked = await listUnbookableFleetIds(db, {
          start: new Date(input!.startDate!),
          end: new Date(input!.endDate!),
        });
      }

      // Group key: model_id > catalog_id > brand|model|category (normalized)
      const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();
      const groupKey = (f: typeof schema.rentalFleet.$inferSelect) => {
        if (f.equipmentModelId) return `model:${f.equipmentModelId}`;
        if (f.catalogCacheId) return `catalog:${f.catalogCacheId}`;
        return `bm:${norm(f.brand)}|${norm(f.model)}|${norm(f.category)}`;
      };

      // Score for picking the representative unit (prefer available, non-maintenance)
      const repScore = (
        f: typeof schema.rentalFleet.$inferSelect,
        isAvailable: boolean | null,
      ) =>
        (isAvailable === true ? 4 : 0) +
        (isAvailable === null ? 2 : 0) +
        (f.currentStatus !== "maintenance" ? 1 : 0);

      type Item = (typeof allEquipment)[number];
      // Public endpoint: the representative's fleet row is narrowed to the
      // whitelist before it leaves the server.
      type PublicItem = Omit<Item, "rental_fleet"> & { rental_fleet: PublicFleetFields };
      type Group = {
        groupKey: string;
        representative: PublicItem & { displayName: string | null };
        equipmentType: "machine" | "attachment";
        equipmentModelId: number | null;
        totalUnits: number;
        availableUnits: number | null;
        rentedUnits: number;
        maintenanceUnits: number;
        warehouseIds: Set<number | null>;
        availableFleetIds: number[];
        memberFleetIds: number[];
        firstAvailableFleetId: number | null;
        _repScore: number;
        resolvedDailyRate: string | null;
        resolvedWeeklyRate: string | null;
        resolvedMonthlyRate: string | null;
        resolvedTwentyEightDayRate: string | null;
        pricingSource: string;
      };

      const groupMap = new Map<string, Group>();

      for (const item of allEquipment) {
        const f = item.rental_fleet;
        const k = groupKey(f);
        const cat = item.catalog_cache?.category;
        const weight = item.catalog_cache?.operatingWeight;
        const displayName: string | null =
          cat && weight ? `${cat} - ${weight}` : cat || null;

        const fleetCategory = f.category || "";
        const catRate = catRateMap.get(fleetCategory);
        const resolved = resolvePricing(
          f,
          catRate ? { dailyRate: catRate.dailyRate, weeklyRate: catRate.weeklyRate, monthlyRate: catRate.monthlyRate, twentyEightDayRate: catRate.twentyEightDayRate } : null,
        );

        const isMaintenance = f.currentStatus === "maintenance";
        const isRentedByStatus = f.currentStatus === "rented";
        const isBlocked = hasDates && blocked.has(f.id);
        const isAvailable: boolean | null = !hasDates
          ? null
          : isMaintenance
            ? false
            : !isBlocked;

        const enriched = { ...item, rental_fleet: toPublicFleet(f), displayName };
        const score = repScore(f, isAvailable);

        const existing = groupMap.get(k);
        let g: Group;
        if (existing) {
          g = existing;
          if (score > g._repScore) {
            g.representative = enriched;
            g._repScore = score;
          }
        } else {
          const groupModelId = f.equipmentModelId ?? null;
          const groupCatalogId = f.catalogCacheId ?? null;
          const groupType = (groupCatalogId && catalogTypeMap.get(groupCatalogId)) || "machine";
          g = {
            groupKey: k,
            representative: enriched,
            equipmentType: groupType,
            equipmentModelId: groupModelId,
            totalUnits: 0,
            availableUnits: hasDates ? 0 : null,
            rentedUnits: 0,
            maintenanceUnits: 0,
            warehouseIds: new Set<number | null>(),
            availableFleetIds: [],
            memberFleetIds: [],
            firstAvailableFleetId: null,
            _repScore: score,
            resolvedDailyRate: resolved.dailyRate,
            resolvedWeeklyRate: resolved.weeklyRate,
            resolvedMonthlyRate: resolved.monthlyRate,
            resolvedTwentyEightDayRate: resolved.twentyEightDayRate ?? null,
            pricingSource: resolved.source || "",
          };
          groupMap.set(k, g);
        }

        g.totalUnits += 1;
        g.warehouseIds.add(item.warehouse?.id ?? null);
        g.memberFleetIds.push(f.id);
        if (isMaintenance) g.maintenanceUnits += 1;
        if (isRentedByStatus || isBlocked) g.rentedUnits += 1;
        if (isAvailable === true) {
          g.availableUnits = (g.availableUnits ?? 0) + 1;
          g.availableFleetIds.push(f.id);
          if (g.firstAvailableFleetId === null) g.firstAvailableFleetId = f.id;
        } else if (!hasDates && !isMaintenance) {
          // No date filter: any non-maintenance unit is "potentially available"
          g.availableFleetIds.push(f.id);
          if (g.firstAvailableFleetId === null) g.firstAvailableFleetId = f.id;
        }
      }

      // Strip private _repScore and convert Set to array for JSON
      let groups = Array.from(groupMap.values()).map(({ _repScore, warehouseIds, ...rest }) => ({
        ...rest,
        multipleLocations: warehouseIds.size > 1,
      }));

      // Apply equipment_type filter at the end so customers can split machines vs attachments
      if (input?.equipmentType) {
        groups = groups.filter(g => g.equipmentType === input.equipmentType);
      }

      return groups;
    }),

  // Admin endpoint: list fleet items with availability status for a date range
  listWithAvailability: protectedProcedure.use(moduleGuard('fleet', 'read'))
    .input(z.object({
      startDate: z.string(),
      endDate: z.string(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const reqStart = new Date(input.startDate);
      const reqEnd = new Date(input.endDate);

      if (isNaN(reqStart.getTime()) || isNaN(reqEnd.getTime())) return [];

      // Get category-level rates
      const categoryRates = await db
        .select({
          category: schema.equipmentModels.category,
          dailyRate: sql<string>`MAX(${schema.equipmentModels.dailyRate})`,
          weeklyRate: sql<string>`MAX(${schema.equipmentModels.weeklyRate})`,
          monthlyRate: sql<string>`MAX(${schema.equipmentModels.monthlyRate})`,
        })
        .from(schema.equipmentModels)
        .where(isNull(schema.equipmentModels.deletedAt))
        .groupBy(schema.equipmentModels.category);

      const catRateMap = new Map(categoryRates.map(c => [c.category, c]));

      // Get all non-retired fleet items
      const rows = await db
        .select({
          id: schema.rentalFleet.id,
          equipmentModelId: schema.rentalFleet.equipmentModelId,
          brand: schema.rentalFleet.brand,
          model: schema.rentalFleet.model,
          year: schema.rentalFleet.year,
          category: schema.rentalFleet.category,
          currentStatus: schema.rentalFleet.currentStatus,
          assetNumber: schema.rentalFleet.assetNumber,
          serialNumber: schema.rentalFleet.serialNumber,
          dailyRate: schema.rentalFleet.dailyRate,
          weeklyRate: schema.rentalFleet.weeklyRate,
          monthlyRate: schema.rentalFleet.monthlyRate,
        })
        .from(schema.rentalFleet)
        .where(and(
          isNull(schema.rentalFleet.deletedAt),
          sql`${schema.rentalFleet.currentStatus} NOT IN ('retired')`,
        ))
        .orderBy(schema.rentalFleet.brand, schema.rentalFleet.model)
        .limit(500);

      // Find all conflicting rentals for the date range
      const conflicting = await db
        .select({
          rentalFleetId: schema.rentalRequests.rentalFleetId,
          endDate: schema.rentalRequests.endDate,
          status: schema.rentalRequests.status,
        })
        .from(schema.rentalRequests)
        .where(and(
          isNull(schema.rentalRequests.deletedAt),
          sql`${schema.rentalRequests.rentalFleetId} IS NOT NULL`,
          lte(schema.rentalRequests.startDate, reqEnd),
          gte(schema.rentalRequests.endDate, reqStart),
          or(
            eq(schema.rentalRequests.status, "active"),
            eq(schema.rentalRequests.status, "approved"),
            eq(schema.rentalRequests.status, "pending"),
          ),
        ));

      // Build a map of fleet ID -> latest conflicting rental end date
      const conflictMap = new Map<number, Date>();
      for (const c of conflicting) {
        if (c.rentalFleetId) {
          const existing = conflictMap.get(c.rentalFleetId);
          const cEnd = new Date(c.endDate);
          if (!existing || cEnd > existing) {
            conflictMap.set(c.rentalFleetId, cEnd);
          }
        }
      }
      const operationalBlocks = await listOperationalFleetBlocks(db);

      return rows.map((r) => {
        const catRate = catRateMap.get(r.category || "");
        const resolved = resolvePricing(
          { dailyRate: r.dailyRate, weeklyRate: r.weeklyRate, monthlyRate: r.monthlyRate },
          catRate ? { dailyRate: catRate.dailyRate, weeklyRate: catRate.weeklyRate, monthlyRate: catRate.monthlyRate } : null,
        );

        // Three distinct reasons a unit cannot be picked, kept distinct on the
        // wire. "blocked" is NOT "rented": a machine held by an open work order
        // or an unfinished return is in our own yard, not at a customer's site,
        // and telling the operator otherwise sends them looking for the wrong
        // document to clear.
        let availabilityStatus: 'available' | 'rented' | 'maintenance' | 'blocked' = 'available';
        let conflictingRentalEnd: string | null = null;
        let blockReason: 'return' | 'work_order' | null = null;
        let blockRefs: string[] = [];

        const block = operationalBlocks.get(r.id);

        if (r.currentStatus === 'maintenance') {
          availabilityStatus = 'maintenance';
        } else if (conflictMap.has(r.id) || block?.reason === 'rental') {
          availabilityStatus = 'rented';
          conflictingRentalEnd = conflictMap.get(r.id)?.toISOString().split('T')[0] ?? null;
          blockRefs = block?.reason === 'rental' ? block.refs : [];
        } else if (block) {
          availabilityStatus = 'blocked';
          blockReason = block.reason === 'return' ? 'return' : 'work_order';
          blockRefs = block.refs;
        }

        return {
          id: r.id,
          equipmentModelId: r.equipmentModelId,
          brand: r.brand,
          model: r.model,
          year: r.year,
          category: r.category,
          currentStatus: r.currentStatus,
          assetNumber: r.assetNumber,
          serialNumber: r.serialNumber,
          dailyRate: r.dailyRate,
          weeklyRate: r.weeklyRate,
          monthlyRate: r.monthlyRate,
          resolvedDailyRate: resolved.dailyRate,
          resolvedWeeklyRate: resolved.weeklyRate,
          resolvedMonthlyRate: resolved.monthlyRate,
          pricingSource: resolved.source,
          availabilityStatus,
          conflictingRentalEnd,
          blockReason,
          blockRefs,
        };
      });
    }),

  // Which units are held by something operational (live rental / unfinished
  // return / open work order), for the fleet list to mark alongside the physical
  // currentStatus badge. Deliberately separate from `list` so the badge query
  // stays cheap and the two pages read the same custody rule.
  operationalBlocks: protectedProcedure.use(moduleGuard('fleet', 'read'))
    .query(async () => {
      const db = await getDb();
      if (!db) return [];
      const blocks = await listOperationalFleetBlocks(db);
      return Array.from(blocks.entries()).map(([fleetId, block]) => ({
        fleetId,
        reason: block.reason,
        refs: block.refs,
      }));
    }),

  // Lifetime usage + revenue + payback per fleet asset. One query so the
  // list and detail dialog can both feed off it.
  //
  // Days: SUM(endDate - startDate + 1) from non-deleted rental_line_items on
  //   non-deleted rentals in active/completed/overdue status. Pre-mig-092
  //   line items have null dates → COALESCE to parent rental_requests dates.
  //
  // Hours: per rental, MAX-MIN of (engineHours OR hourMeter) across ≥2
  //   inspections; SUM across rentals per fleet. hasHoursData=false when no
  //   rental has a complete pre/post pair so the UI can show "—" instead of 0.
  //
  // Revenue: SUM(rental_requests.rentalFee). Prod is single-line-item per
  //   rental (verified), so fee maps 1:1 to the line's fleet asset; if multi-
  //   line rentals ever appear, this will over-count and we should pivot to
  //   rental_line_items.lineSubtotal (currently unused in prod).
  //
  // Payback: lifetimeRevenue / purchaseCost — null when purchaseCost unset or
  //   zero so the UI can distinguish "no data" from "0% paid back".
  usageStats: protectedProcedure.use(moduleGuard('fleet', 'read'))
    .input(z.object({ fleetIds: z.array(z.number()).max(500).optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      type Row = {
        fleetId: number;
        purchaseCost: number | null;
        totalRentedDays: number;
        totalOperatingHours: number;
        lastUsedDate: string | null;
        hasHoursData: boolean;
        rentalCount: number;
        lifetimeRevenue: number;
        revenuePerDay: number | null;
        revenuePerHour: number | null;
        paybackProgress: number | null;
        paybackRemaining: number | null;
        isPaidBack: boolean;
      };
      if (!db) return [] as Row[];

      const ids = input?.fleetIds;
      const idFilter = ids && ids.length > 0
        ? sql`AND rf.id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})`
        : sql``;

      const result = await db.execute(sql`
        WITH fleet_links AS (
          -- One row per (asset, rental): fleet-bearing line items, PLUS the asset
          -- stored directly on the rental when it has no fleet-bearing line item.
          -- Single-item rentals keep the asset on rental_requests (not as a line
          -- item); without the second branch ~half of revenue/usage is dropped.
          SELECT
            li."rentalFleetId" AS "fleetId",
            rr.id AS "rentalRequestId",
            COALESCE(li."startDate", rr."startDate") AS "startDate",
            COALESCE(li."endDate", rr."endDate") AS "endDate",
            rr."rentalFee" AS "rentalFee",
            rr.status AS status
          FROM rental_line_items li
          JOIN rental_requests rr ON rr.id = li."rentalRequestId"
          WHERE li."deletedAt" IS NULL
            AND rr."deletedAt" IS NULL
            AND li."rentalFleetId" IS NOT NULL
          UNION ALL
          SELECT
            rr."rentalFleetId" AS "fleetId",
            rr.id AS "rentalRequestId",
            rr."startDate" AS "startDate",
            rr."endDate" AS "endDate",
            rr."rentalFee" AS "rentalFee",
            rr.status AS status
          FROM rental_requests rr
          WHERE rr."deletedAt" IS NULL
            AND rr."rentalFleetId" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM rental_line_items li
              WHERE li."rentalRequestId" = rr.id
                AND li."deletedAt" IS NULL
                AND li."rentalFleetId" IS NOT NULL
            )
        ),
        days_per_fleet AS (
          SELECT
            "fleetId",
            -- Cap the end at "now" so open-ended rentals (credit orders carry the
            -- 2099-12-31 sentinel endDate) and any not-yet-returned active rental
            -- count days only up to today — without this the sentinel produces
            -- ~26,875 lifetime days. Completed rentals are unaffected (their
            -- endDate is already in the past, so LEAST() is a no-op).
            SUM(GREATEST(0,
              DATE_PART('day', LEAST("endDate"::timestamp, NOW()::timestamp) - "startDate"::timestamp) + 1
            ))::int AS "totalRentedDays",
            MAX(LEAST("endDate", NOW())) AS "lastUsedDate",
            COUNT(DISTINCT "rentalRequestId")::int AS "rentalCount"
          FROM fleet_links
          WHERE status IN ('active', 'completed', 'overdue')
          GROUP BY "fleetId"
        ),
        revenue_per_fleet AS (
          SELECT
            "fleetId",
            SUM("rentalFee"::numeric)::numeric(14,2) AS "lifetimeRevenue"
          FROM fleet_links
          WHERE status IN ('active', 'completed', 'overdue')
            AND "rentalFee" IS NOT NULL
          GROUP BY "fleetId"
        ),
        hours_per_rental AS (
          SELECT
            i."rentalFleetId" AS "fleetId",
            i."rentalId",
            MAX(COALESCE(i."engineHours", i."hourMeter"))
              - MIN(COALESCE(i."engineHours", i."hourMeter")) AS "hoursUsed"
          FROM inspections i
          WHERE i."deletedAt" IS NULL
            AND i."rentalFleetId" IS NOT NULL
            AND COALESCE(i."engineHours", i."hourMeter") IS NOT NULL
          GROUP BY i."rentalFleetId", i."rentalId"
          HAVING COUNT(*) >= 2
        ),
        hours_per_fleet AS (
          SELECT
            "fleetId",
            SUM(GREATEST(0, "hoursUsed"))::int AS "totalOperatingHours",
            COUNT(*)::int AS "rentalsWithHours"
          FROM hours_per_rental
          GROUP BY "fleetId"
        )
        SELECT
          rf.id AS "fleetId",
          rf."purchaseCost"::text AS "purchaseCost",
          COALESCE(d."totalRentedDays", 0)::int AS "totalRentedDays",
          COALESCE(h."totalOperatingHours", 0)::int AS "totalOperatingHours",
          d."lastUsedDate"::text AS "lastUsedDate",
          (COALESCE(h."rentalsWithHours", 0) > 0) AS "hasHoursData",
          COALESCE(d."rentalCount", 0)::int AS "rentalCount",
          COALESCE(r."lifetimeRevenue", 0)::text AS "lifetimeRevenue"
        FROM rental_fleet rf
        LEFT JOIN days_per_fleet d ON d."fleetId" = rf.id
        LEFT JOIN hours_per_fleet h ON h."fleetId" = rf.id
        LEFT JOIN revenue_per_fleet r ON r."fleetId" = rf.id
        WHERE rf."deletedAt" IS NULL
        ${idFilter}
      `);

      const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows
        ?? (result as unknown as Array<Record<string, unknown>>);
      return (Array.isArray(rows) ? rows : []).map((r): Row => {
        const purchaseCost = r.purchaseCost != null ? Number(r.purchaseCost) : null;
        const totalRentedDays = Number(r.totalRentedDays ?? 0);
        const totalOperatingHours = Number(r.totalOperatingHours ?? 0);
        const hasHoursData = Boolean(r.hasHoursData);
        const lifetimeRevenue = Number(r.lifetimeRevenue ?? 0);
        const revenuePerDay = totalRentedDays > 0 ? lifetimeRevenue / totalRentedDays : null;
        const revenuePerHour = hasHoursData && totalOperatingHours > 0 ? lifetimeRevenue / totalOperatingHours : null;
        const hasCost = purchaseCost != null && purchaseCost > 0;
        const paybackProgress = hasCost ? lifetimeRevenue / purchaseCost! : null;
        const paybackRemaining = hasCost ? Math.max(0, purchaseCost! - lifetimeRevenue) : null;
        const isPaidBack = hasCost ? lifetimeRevenue >= purchaseCost! : false;
        return {
          fleetId: Number(r.fleetId),
          purchaseCost,
          totalRentedDays,
          totalOperatingHours,
          lastUsedDate: (r.lastUsedDate as string | null) ?? null,
          hasHoursData,
          rentalCount: Number(r.rentalCount ?? 0),
          lifetimeRevenue,
          revenuePerDay,
          revenuePerHour,
          paybackProgress,
          paybackRemaining,
          isPaidBack,
        };
      });
    }),
});
