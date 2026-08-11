import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { zMoneyOptional } from "../../shared/zodMoney";
import { getDb, eq, and, isNull, asc } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { calculateDepositFromRules } from "../services/depositCalculation";

export const depositRulesRouter = router({
  list: protectedProcedure.use(moduleGuard('settings', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(schema.depositRules)
      .where(isNull(schema.depositRules.deletedAt))
      .orderBy(asc(schema.depositRules.priority));
  }),

  create: protectedProcedure.use(moduleGuard('settings', 'create'))
    .input(z.object({
      category: z.string().min(1).max(255),
      depositType: z.enum(["percentage", "fixed"]),
      value: z.string(),
      minDeposit: zMoneyOptional(),
      maxDeposit: zMoneyOptional(),
      priority: z.number().min(0).max(9999).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [result] = await db.insert(schema.depositRules).values({
        category: input.category,
        depositType: input.depositType,
        value: input.value,
        minDeposit: input.minDeposit || "500",
        maxDeposit: input.maxDeposit || null,
        priority: input.priority ?? 100,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "deposit_rule",
        entityId: result.id,
        metadata: { category: input.category },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({
      id: z.number(),
      category: z.string().min(1).max(255).optional(),
      depositType: z.enum(["percentage", "fixed"]).optional(),
      value: z.string().optional(),
      minDeposit: zMoneyOptional(),
      maxDeposit: zMoneyOptional(),
      priority: z.number().min(0).max(9999).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { id, ...data } = input;
      const [result] = await db
        .update(schema.depositRules)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(schema.depositRules.id, id), isNull(schema.depositRules.deletedAt)))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND" });

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "deposit_rule",
        entityId: id,
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('settings', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.update(schema.depositRules)
        .set({ deletedAt: new Date() })
        .where(eq(schema.depositRules.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "deposit_rule",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  calculate: protectedProcedure.use(moduleGuard('settings', 'read'))
    .input(z.object({
      category: z.string().optional(),
      msrp: z.number().optional(),
    }))
    .query(async ({ input }) => {
      return calculateDepositFromRules(input.category, input.msrp);
    }),
});
