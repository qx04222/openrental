import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { parseCalendarDate } from "../_core/dateUtils";

export const driversRouter = router({
  list: protectedProcedure.use(moduleGuard('drivers', 'read'))
    .input(z.object({
      activeOnly: z.boolean().optional(),
      limit: z.number().min(1).max(500).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [isNull(schema.drivers.deletedAt)];
      if (input?.activeOnly) conditions.push(eq(schema.drivers.isActive, true));

      return db
        .select()
        .from(schema.drivers)
        .where(and(...conditions))
        .orderBy(desc(schema.drivers.createdAt))
        .limit(input?.limit ?? 200);
    }),

  getById: protectedProcedure.use(moduleGuard('drivers', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [result] = await db
        .select()
        .from(schema.drivers)
        .where(and(eq(schema.drivers.id, input.id), isNull(schema.drivers.deletedAt)))
        .limit(1);

      return result || null;
    }),

  create: protectedProcedure.use(moduleGuard('drivers', 'create'))
    .input(z.object({
      name: z.string().min(1).max(255),
      phone: z.string().max(50).optional(),
      email: z.string().email().max(255).optional(),
      userId: z.number().optional(),
      licenseNumber: z.string().max(100).optional(),
      licenseExpiry: z.string().optional(),
      vehicleInfo: z.string().max(2000).optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [result] = await db.insert(schema.drivers).values({
        name: input.name,
        phone: input.phone,
        email: input.email,
        userId: input.userId,
        licenseNumber: input.licenseNumber,
        licenseExpiry: input.licenseExpiry ? parseCalendarDate(input.licenseExpiry) : undefined,
        vehicleInfo: input.vehicleInfo,
        notes: input.notes,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "driver",
        entityId: result.id,
        metadata: { name: input.name },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('drivers', 'update'))
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(255).optional(),
      phone: z.string().max(50).optional(),
      email: z.string().email().max(255).optional(),
      userId: z.number().nullable().optional(),
      licenseNumber: z.string().max(100).optional(),
      licenseExpiry: z.string().nullable().optional(),
      vehicleInfo: z.string().max(2000).optional(),
      isActive: z.boolean().optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { id, licenseExpiry, ...rest } = input;
      const updateData: Record<string, unknown> = { ...rest, updatedAt: new Date() };
      if (licenseExpiry !== undefined) {
        updateData.licenseExpiry = licenseExpiry ? parseCalendarDate(licenseExpiry) : null;
      }

      const [result] = await db
        .update(schema.drivers)
        .set(updateData)
        .where(and(eq(schema.drivers.id, id), isNull(schema.drivers.deletedAt)))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND" });

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "driver",
        entityId: id,
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('drivers', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.update(schema.drivers).set({ deletedAt: new Date() }).where(eq(schema.drivers.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "driver",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),
});
