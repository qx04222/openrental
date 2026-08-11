import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, asc } from "../db";
import * as schema from "../../drizzle/schema";
import { seedDefaultContractTemplate } from "../services/contractTemplateSeed";

export const contractTemplatesRouter = router({
  list: protectedProcedure.use(moduleGuard('settings', 'read'))
    .input(z.object({ includeInactive: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = input?.includeInactive
        ? undefined
        : eq(schema.contractTemplates.isActive, true);

      return db
        .select()
        .from(schema.contractTemplates)
        .where(conditions)
        .orderBy(asc(schema.contractTemplates.id));
    }),

  getById: protectedProcedure.use(moduleGuard('settings', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [template] = await db
        .select()
        .from(schema.contractTemplates)
        .where(eq(schema.contractTemplates.id, input.id))
        .limit(1);

      if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      return template;
    }),

  create: protectedProcedure.use(moduleGuard('settings', 'create'))
    .input(z.object({
      name: z.string().min(1).max(200),
      content: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [result] = await db.insert(schema.contractTemplates).values({
        name: input.name,
        content: input.content,
        isDefault: false,
        isActive: true,
      }).returning();

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(200).optional(),
      content: z.string().min(1).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { id, ...data } = input;
      const [result] = await db
        .update(schema.contractTemplates)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(schema.contractTemplates.id, id))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('settings', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Cannot delete the default template
      const [template] = await db
        .select()
        .from(schema.contractTemplates)
        .where(eq(schema.contractTemplates.id, input.id))
        .limit(1);

      if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      if (template.isDefault) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot delete the default template" });
      }

      // Soft-deactivate
      await db
        .update(schema.contractTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(schema.contractTemplates.id, input.id));

      return { success: true };
    }),

  setDefault: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Verify template exists and is active
      const [template] = await db
        .select()
        .from(schema.contractTemplates)
        .where(and(
          eq(schema.contractTemplates.id, input.id),
          eq(schema.contractTemplates.isActive, true),
        ))
        .limit(1);

      if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });

      // Unset all defaults
      await db
        .update(schema.contractTemplates)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(schema.contractTemplates.isDefault, true));

      // Set new default
      const [result] = await db
        .update(schema.contractTemplates)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(schema.contractTemplates.id, input.id))
        .returning();

      return result;
    }),

  seedDefault: protectedProcedure.use(moduleGuard('settings', 'create'))
    .mutation(async () => {
      return seedDefaultContractTemplate();
    }),

  duplicate: protectedProcedure.use(moduleGuard('settings', 'create'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [source] = await db
        .select()
        .from(schema.contractTemplates)
        .where(eq(schema.contractTemplates.id, input.id))
        .limit(1);

      if (!source) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });

      const [result] = await db.insert(schema.contractTemplates).values({
        name: `${source.name} (Copy)`,
        content: source.content,
        isDefault: false,
        isActive: true,
      }).returning();

      return result;
    }),
});
