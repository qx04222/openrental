import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { zMoneyOptional } from "../../shared/zodMoney";
import { getDb, eq, and, desc, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import type { SQL } from "drizzle-orm";

export const customerPricingRouter = router({
  list: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({
      customerId: z.number().optional(),
      rentalFleetId: z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions: SQL[] = [];
      if (input?.customerId) conditions.push(eq(schema.customerPricing.customerId, input.customerId));
      if (input?.rentalFleetId) conditions.push(eq(schema.customerPricing.rentalFleetId, input.rentalFleetId));

      return db
        .select()
        .from(schema.customerPricing)
        .leftJoin(schema.customers, and(eq(schema.customerPricing.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.rentalFleet, and(eq(schema.customerPricing.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.customerPricing.createdAt))
        .limit(500);
    }),

  create: protectedProcedure.use(moduleGuard('customers', 'create'))
    .input(z.object({
      customerId: z.number(),
      rentalFleetId: z.number().optional(),
      category: z.string().max(100).optional(),
      dailyRate: zMoneyOptional(),
      weeklyRate: zMoneyOptional(),
      monthlyRate: zMoneyOptional(),
      twentyEightDayRate: zMoneyOptional(),
      discountPercent: zMoneyOptional(),
      validFrom: z.string(),
      validTo: z.string().optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [result] = await db.insert(schema.customerPricing).values({
        customerId: input.customerId,
        rentalFleetId: input.rentalFleetId,
        category: input.category,
        dailyRate: input.dailyRate,
        weeklyRate: input.weeklyRate,
        monthlyRate: input.monthlyRate,
        twentyEightDayRate: input.twentyEightDayRate,
        discountPercent: input.discountPercent,
        validFrom: new Date(input.validFrom),
        validTo: input.validTo ? new Date(input.validTo) : undefined,
        notes: input.notes,
        createdBy: ctx.user?.id,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "customer_pricing",
        entityId: result.id,
        metadata: { customerId: input.customerId },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('customers', 'update'))
    .input(z.object({
      id: z.number(),
      dailyRate: zMoneyOptional(),
      weeklyRate: zMoneyOptional(),
      monthlyRate: zMoneyOptional(),
      twentyEightDayRate: zMoneyOptional(),
      discountPercent: zMoneyOptional(),
      validTo: z.string().optional(),
      isActive: z.boolean().optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { id, ...data } = input;
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (data.dailyRate !== undefined) updateData.dailyRate = data.dailyRate;
      if (data.weeklyRate !== undefined) updateData.weeklyRate = data.weeklyRate;
      if (data.monthlyRate !== undefined) updateData.monthlyRate = data.monthlyRate;
      if (data.twentyEightDayRate !== undefined) updateData.twentyEightDayRate = data.twentyEightDayRate;
      if (data.discountPercent !== undefined) updateData.discountPercent = data.discountPercent;
      if (data.validTo !== undefined) updateData.validTo = data.validTo ? new Date(data.validTo) : null;
      if (data.isActive !== undefined) updateData.isActive = data.isActive;
      if (data.notes !== undefined) updateData.notes = data.notes;

      const [result] = await db
        .update(schema.customerPricing)
        .set(updateData)
        .where(eq(schema.customerPricing.id, id))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Pricing not found" });

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "customer_pricing",
        entityId: id,
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('customers', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.delete(schema.customerPricing).where(eq(schema.customerPricing.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "customer_pricing",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),
});
