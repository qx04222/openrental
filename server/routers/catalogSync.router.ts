import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq } from "../db";
import * as schema from "../../drizzle/schema";
import { uploadToSupabaseStorage } from "../services/storage";
import { nanoid } from "nanoid";

const CATALOG_BUCKET = "fleet-images";

async function uploadCatalogFile(base64: string, prefix: string): Promise<string> {
  const path = `catalog/${prefix}_${Date.now()}_${nanoid(8)}`;
  return uploadToSupabaseStorage(base64, path, CATALOG_BUCKET);
}

// Note: the "sync" prefix is historical — TerraX integration was retired
// and this router now only manages the local catalog_cache table.
export const catalogSyncRouter = router({
  getStatus: protectedProcedure.use(moduleGuard('fleet', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return { cacheCount: 0 };

    const cacheItems = await db.select({ id: schema.catalogCache.id }).from(schema.catalogCache);
    return { cacheCount: cacheItems.length };
  }),

  getCatalog: publicProcedure
    .input(z.object({ sourceType: z.enum(["industrial", "powersports", "manual"]).optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      if (input?.sourceType) {
        return db
          .select()
          .from(schema.catalogCache)
          .where(eq(schema.catalogCache.sourceType, input.sourceType))
          .orderBy(schema.catalogCache.displayOrder, schema.catalogCache.brand);
      }

      return db.select().from(schema.catalogCache).orderBy(schema.catalogCache.displayOrder, schema.catalogCache.brand);
    }),

  createItem: protectedProcedure.use(moduleGuard('fleet', 'create'))
    .input(z.object({
      brand: z.string().min(1).max(200),
      model: z.string().min(1).max(200),
      category: z.string().min(1).max(100),
      modelYear: z.number().min(1900).max(2100).optional(),
      description: z.string().max(5000).optional(),
      specifications: z.string().max(10000).optional(),
      msrp: z.string().max(20).optional(),
      imageUrl: z.string().optional(),
      enginePower: z.string().max(100).optional(),
      operatingWeight: z.string().max(100).optional(),
      bucketCapacity: z.string().max(100).optional(),
      ratedLoad: z.string().max(100).optional(),
      availabilityStatus: z.string().max(50).optional(),
      leadTimeDays: z.number().min(0).optional(),
      displayOrder: z.number().min(0).optional(),
      brochureUrl: z.string().optional(),
      videoUrl: z.string().optional(),
      equipmentType: z.enum(["machine", "attachment"]).optional(),
      // sourceType used to be "manual" for everything created here. Now the
      // admin form picks the kind directly so we pass it through.
      sourceType: z.enum(["industrial", "powersports", "manual"]).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Auto-upload base64 files to Supabase Storage
      if (input.imageUrl?.startsWith("data:")) {
        input.imageUrl = await uploadCatalogFile(input.imageUrl, "img");
      }
      if (input.brochureUrl?.startsWith("data:")) {
        input.brochureUrl = await uploadCatalogFile(input.brochureUrl, "brochure");
      }
      if (input.videoUrl?.startsWith("data:")) {
        input.videoUrl = await uploadCatalogFile(input.videoUrl, "video");
      }

      const [result] = await db.insert(schema.catalogCache).values({
        sourceType: input.sourceType ?? "industrial",
        sourceId: null,
        checksum: null,
        brand: input.brand,
        model: input.model,
        category: input.category,
        modelYear: input.modelYear,
        description: input.description,
        specifications: input.specifications,
        msrp: input.msrp,
        imageUrl: input.imageUrl,
        enginePower: input.enginePower,
        operatingWeight: input.operatingWeight,
        bucketCapacity: input.bucketCapacity,
        ratedLoad: input.ratedLoad,
        availabilityStatus: input.availabilityStatus || "available",
        leadTimeDays: input.leadTimeDays,
        displayOrder: input.displayOrder ?? 0,
        brochureUrl: input.brochureUrl,
        videoUrl: input.videoUrl,
        equipmentType: input.equipmentType ?? "machine",
      }).returning();

      return result;
    }),

  updateItem: protectedProcedure.use(moduleGuard('fleet', 'update'))
    .input(z.object({
      id: z.number(),
      brand: z.string().max(200).optional(),
      model: z.string().max(200).optional(),
      category: z.string().max(100).optional(),
      modelYear: z.number().min(1900).max(2100).nullable().optional(),
      description: z.string().max(5000).nullable().optional(),
      specifications: z.string().max(5000).nullable().optional(),
      msrp: z.string().max(20).nullable().optional(),
      imageUrl: z.string().nullable().optional(),
      enginePower: z.string().max(100).nullable().optional(),
      operatingWeight: z.string().max(100).nullable().optional(),
      bucketCapacity: z.string().max(100).nullable().optional(),
      ratedLoad: z.string().max(100).nullable().optional(),
      availabilityStatus: z.string().max(50).optional(),
      leadTimeDays: z.number().min(0).nullable().optional(),
      displayOrder: z.number().min(0).optional(),
      brochureUrl: z.string().nullable().optional(),
      videoUrl: z.string().nullable().optional(),
      equipmentType: z.enum(["machine", "attachment"]).optional(),
      sourceType: z.enum(["industrial", "powersports", "manual"]).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Auto-upload base64 files to Supabase Storage
      if (input.imageUrl?.startsWith("data:")) {
        input.imageUrl = await uploadCatalogFile(input.imageUrl, "img");
      }
      if (input.brochureUrl?.startsWith("data:")) {
        input.brochureUrl = await uploadCatalogFile(input.brochureUrl, "brochure");
      }
      if (input.videoUrl?.startsWith("data:")) {
        input.videoUrl = await uploadCatalogFile(input.videoUrl, "video");
      }

      const { id, ...data } = input;
      const [result] = await db
        .update(schema.catalogCache)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(schema.catalogCache.id, id))
        .returning();

      return result;
    }),

  deleteItem: protectedProcedure.use(moduleGuard('fleet', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [item] = await db
        .select({ id: schema.catalogCache.id })
        .from(schema.catalogCache)
        .where(eq(schema.catalogCache.id, input.id))
        .limit(1);

      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Item not found" });

      await db.delete(schema.catalogCache).where(eq(schema.catalogCache.id, input.id));
      return { success: true };
    }),
});
