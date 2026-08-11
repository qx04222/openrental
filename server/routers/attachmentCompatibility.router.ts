import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, inArray } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * Attachment compatibility lives at the catalog (catalog_cache) level — the
 * master product list synced from the source. Both attachments and the
 * machines they mount on are catalog items.
 */
export const attachmentCompatibilityRouter = router({
  // List machine catalog items that an attachment fits onto
  forAttachment: publicProcedure
    .input(z.object({ attachmentCatalogId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.attachmentCompatibility.id,
          machineCatalogId: schema.attachmentCompatibility.machineCatalogId,
          notes: schema.attachmentCompatibility.notes,
          machineCategory: schema.catalogCache.category,
          machineBrand: schema.catalogCache.brand,
          machineModel: schema.catalogCache.model,
          machineModelYear: schema.catalogCache.modelYear,
        })
        .from(schema.attachmentCompatibility)
        .innerJoin(
          schema.catalogCache,
          eq(schema.attachmentCompatibility.machineCatalogId, schema.catalogCache.id),
        )
        .where(eq(schema.attachmentCompatibility.attachmentCatalogId, input.attachmentCatalogId));
    }),

  // List attachments compatible with a given machine catalog item
  forMachine: publicProcedure
    .input(z.object({ machineCatalogId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.attachmentCompatibility.id,
          attachmentCatalogId: schema.attachmentCompatibility.attachmentCatalogId,
          notes: schema.attachmentCompatibility.notes,
          attachmentCategory: schema.catalogCache.category,
          attachmentBrand: schema.catalogCache.brand,
          attachmentModel: schema.catalogCache.model,
          attachmentModelYear: schema.catalogCache.modelYear,
        })
        .from(schema.attachmentCompatibility)
        .innerJoin(
          schema.catalogCache,
          eq(schema.attachmentCompatibility.attachmentCatalogId, schema.catalogCache.id),
        )
        .where(and(
          eq(schema.attachmentCompatibility.machineCatalogId, input.machineCatalogId),
          eq(schema.catalogCache.equipmentType, "attachment"),
        ));
    }),

  // Admin: replace the whole compatibility list for an attachment in one call.
  // Diff against existing rows so unchanged pairs keep their createdAt/notes.
  setCompatibleMachines: protectedProcedure.use(moduleGuard('fleet', 'update'))
    .input(z.object({
      attachmentCatalogId: z.number(),
      machineCatalogIds: z.array(z.number()),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [attachment] = await db
        .select({ id: schema.catalogCache.id, equipmentType: schema.catalogCache.equipmentType })
        .from(schema.catalogCache)
        .where(eq(schema.catalogCache.id, input.attachmentCatalogId))
        .limit(1);

      if (!attachment) throw new TRPCError({ code: "NOT_FOUND", message: "Attachment catalog item not found" });
      if (attachment.equipmentType !== "attachment") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Catalog item is not marked as an attachment" });
      }

      if (input.machineCatalogIds.length > 0) {
        const machines = await db
          .select({ id: schema.catalogCache.id, equipmentType: schema.catalogCache.equipmentType })
          .from(schema.catalogCache)
          .where(inArray(schema.catalogCache.id, input.machineCatalogIds));
        if (machines.length !== input.machineCatalogIds.length) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "One or more machine catalog items not found" });
        }
        for (const m of machines) {
          if (m.equipmentType !== "machine") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Compatible target must be a machine" });
          }
        }
      }

      const existing = await db
        .select({ machineCatalogId: schema.attachmentCompatibility.machineCatalogId })
        .from(schema.attachmentCompatibility)
        .where(eq(schema.attachmentCompatibility.attachmentCatalogId, input.attachmentCatalogId));
      const existingSet = new Set(existing.map(e => e.machineCatalogId));
      const incomingSet = new Set(input.machineCatalogIds);

      const toAdd = input.machineCatalogIds.filter(id => !existingSet.has(id));
      const toRemove = [...existingSet].filter(id => !incomingSet.has(id));

      if (toAdd.length > 0) {
        await db.insert(schema.attachmentCompatibility).values(
          toAdd.map(machineId => ({
            attachmentCatalogId: input.attachmentCatalogId,
            machineCatalogId: machineId,
          })),
        );
      }
      if (toRemove.length > 0) {
        await db
          .delete(schema.attachmentCompatibility)
          .where(and(
            eq(schema.attachmentCompatibility.attachmentCatalogId, input.attachmentCatalogId),
            inArray(schema.attachmentCompatibility.machineCatalogId, toRemove),
          ));
      }

      return { added: toAdd.length, removed: toRemove.length };
    }),
});
