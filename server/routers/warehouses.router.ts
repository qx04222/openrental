import { z } from "zod";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, isNull } from "../db";
import { logAudit } from "../services/auditLog";
import * as schema from "../../drizzle/schema";

export const warehousesRouter = router({
  list: protectedProcedure.use(moduleGuard('warehouses', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(schema.warehouses).where(isNull(schema.warehouses.deletedAt));
  }),

  // Public endpoint for rental request pickup location selector
  listPublic: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select({
        id: schema.warehouses.id,
        name: schema.warehouses.name,
        address: schema.warehouses.address,
        city: schema.warehouses.city,
        province: schema.warehouses.province,
      })
      .from(schema.warehouses)
      .where(and(isNull(schema.warehouses.deletedAt), eq(schema.warehouses.isActive, true)));
  }),

  create: protectedProcedure.use(moduleGuard('warehouses', 'create'))
    .input(z.object({
      name: z.string().min(1).max(255),
      address: z.string().max(1000).optional(),
      city: z.string().max(100).optional(),
      province: z.string().max(100).optional(),
      postalCode: z.string().max(20).optional(),
      phone: z.string().max(50).optional(),
      isPrimary: z.boolean().optional(),
      contactName: z.string().max(255).optional(),
      contactPhone: z.string().max(50).optional(),
      contactEmail: z.string().email().max(255).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [r] = await db.insert(schema.warehouses).values(input).returning();
      return r;
    }),

  update: protectedProcedure.use(moduleGuard('warehouses', 'update'))
    .input(z.object({
      id: z.number(),
      name: z.string().max(255).optional(),
      address: z.string().max(1000).optional(),
      city: z.string().max(100).optional(),
      province: z.string().max(100).optional(),
      postalCode: z.string().max(20).optional(),
      phone: z.string().max(50).optional(),
      isActive: z.boolean().optional(),
      isPrimary: z.boolean().optional(),
      contactName: z.string().max(255).optional(),
      contactPhone: z.string().max(50).optional(),
      contactEmail: z.string().email().max(255).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const { id, ...data } = input;
      const [r] = await db.update(schema.warehouses).set({ ...data, updatedAt: new Date() }).where(eq(schema.warehouses.id, id)).returning();
      return r;
    }),

  delete: protectedProcedure.use(moduleGuard('warehouses', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [existing] = await db.select().from(schema.warehouses).where(and(eq(schema.warehouses.id, input.id), isNull(schema.warehouses.deletedAt))).limit(1);

      await db.update(schema.warehouses).set({ deletedAt: new Date() }).where(eq(schema.warehouses.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "warehouse",
        entityId: input.id,
        metadata: existing ? { name: existing.name } : undefined,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),
});
