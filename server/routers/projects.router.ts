import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, isNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { parseCalendarDate } from "../_core/dateUtils";

export const projectsRouter = router({
  list: protectedProcedure.use(moduleGuard('projects', 'read'))
    .input(z.object({
      customerId: z.number().optional(),
      status: z.string().optional(),
      limit: z.number().min(1).max(1000).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [isNull(schema.projects.deletedAt)];
      if (input?.customerId) conditions.push(eq(schema.projects.customerId, input.customerId));
      if (input?.status) conditions.push(eq(schema.projects.status, input.status));

      return db
        .select()
        .from(schema.projects)
        .leftJoin(schema.customers, and(eq(schema.projects.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .where(and(...conditions))
        .orderBy(desc(schema.projects.createdAt))
        .limit(input?.limit ?? 500);
    }),

  getById: protectedProcedure.use(moduleGuard('projects', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [result] = await db
        .select()
        .from(schema.projects)
        .leftJoin(schema.customers, and(eq(schema.projects.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .where(and(eq(schema.projects.id, input.id), isNull(schema.projects.deletedAt)))
        .limit(1);

      if (!result) return null;

      // Get related rentals
      const rentals = await db
        .select({
          id: schema.rentalRequests.id,
          status: schema.rentalRequests.status,
          totalAmount: schema.rentalRequests.totalAmount,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
          customerName: schema.rentalRequests.customerName,
        })
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.projectId, input.id),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .orderBy(desc(schema.rentalRequests.createdAt));

      // Get related invoices
      const invoices = await db
        .select({
          id: schema.invoices.id,
          invoiceNumber: schema.invoices.invoiceNumber,
          status: schema.invoices.status,
          totalAmount: schema.invoices.totalAmount,
          balanceDue: schema.invoices.balanceDue,
          issueDate: schema.invoices.issueDate,
        })
        .from(schema.invoices)
        .where(and(
          eq(schema.invoices.projectId, input.id),
          isNull(schema.invoices.deletedAt),
        ))
        .orderBy(desc(schema.invoices.createdAt));

      return { ...result, rentals, invoices };
    }),

  create: protectedProcedure.use(moduleGuard('projects', 'create'))
    .input(z.object({
      customerId: z.number(),
      name: z.string().min(1).max(255),
      poNumber: z.string().max(100).optional(),
      siteAddress: z.string().max(1000).optional(),
      city: z.string().max(100).optional(),
      province: z.string().max(2).optional(),
      postalCode: z.string().max(10).optional(),
      contactName: z.string().max(255).optional(),
      contactPhone: z.string().max(50).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [result] = await db.insert(schema.projects).values({
        customerId: input.customerId,
        name: input.name,
        poNumber: input.poNumber,
        siteAddress: input.siteAddress,
        city: input.city,
        province: input.province,
        postalCode: input.postalCode,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        startDate: input.startDate ? parseCalendarDate(input.startDate) : undefined,
        endDate: input.endDate ? parseCalendarDate(input.endDate) : undefined,
        notes: input.notes,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "project",
        entityId: result.id,
        metadata: { name: input.name, customerId: input.customerId },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('projects', 'update'))
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(255).optional(),
      poNumber: z.string().max(100).optional(),
      siteAddress: z.string().max(1000).optional(),
      city: z.string().max(100).optional(),
      province: z.string().max(2).optional(),
      postalCode: z.string().max(10).optional(),
      contactName: z.string().max(255).optional(),
      contactPhone: z.string().max(50).optional(),
      status: z.enum(["active", "completed", "on_hold"]).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { id, startDate, endDate, ...data } = input;
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (startDate) updateData.startDate = parseCalendarDate(startDate);
      if (endDate) updateData.endDate = parseCalendarDate(endDate);

      const [result] = await db
        .update(schema.projects)
        .set(updateData)
        .where(and(eq(schema.projects.id, id), isNull(schema.projects.deletedAt)))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "project",
        entityId: id,
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('projects', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.update(schema.projects).set({ deletedAt: new Date() }).where(eq(schema.projects.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "project",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  // Summary: total cost per project
  summary: protectedProcedure.use(moduleGuard('projects', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { totalRentals: 0, totalRevenue: 0, activeRentals: 0 };

      const [stats] = await db
        .select({
          totalRentals: sql<number>`count(*)::int`,
          totalRevenue: sql<string>`coalesce(sum(${schema.rentalRequests.totalAmount}::numeric), 0)`,
          activeRentals: sql<number>`count(CASE WHEN ${schema.rentalRequests.status} = 'active' THEN 1 END)::int`,
        })
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.projectId, input.id),
          isNull(schema.rentalRequests.deletedAt),
        ));

      return {
        totalRentals: stats?.totalRentals || 0,
        totalRevenue: parseFloat(stats?.totalRevenue || "0"),
        activeRentals: stats?.activeRentals || 0,
      };
    }),
});
