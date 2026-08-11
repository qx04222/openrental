import { z } from "zod";
import { router, protectedProcedure, publicProcedure, moduleGuard } from "../_core/trpc";
import { zMoneyOptional } from "../../shared/zodMoney";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, desc, isNull, sql, inArray } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { parseCalendarDate } from "../_core/dateUtils";

export const promotionsRouter = router({
  list: protectedProcedure.use(moduleGuard('promotions', 'read'))
    .input(z.object({
      activeOnly: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [isNull(schema.promotions.deletedAt)];
      if (input?.activeOnly) {
        conditions.push(eq(schema.promotions.isActive, true));
      }

      const rows = await db
        .select()
        .from(schema.promotions)
        .where(and(...conditions))
        .orderBy(desc(schema.promotions.createdAt));

      // Aggregate stats per promotion
      const stats = await db
        .select({
          promotionId: schema.referralCodes.promotionId,
          totalCodes: sql<number>`count(*)::int`,
          activeCodes: sql<number>`count(*) filter (where ${schema.referralCodes.isActive})::int`,
          totalUses: sql<number>`coalesce(sum(${schema.referralCodes.totalUses}), 0)::int`,
          totalCommission: sql<string>`coalesce(sum(${schema.referralCodes.totalCommission}::numeric), 0)`,
        })
        .from(schema.referralCodes)
        .groupBy(schema.referralCodes.promotionId);

      const statsMap = new Map(stats.map(s => [s.promotionId, s]));

      return rows.map(p => ({
        ...p,
        stats: statsMap.get(p.id) || { totalCodes: 0, activeCodes: 0, totalUses: 0, totalCommission: "0" },
      }));
    }),

  getById: protectedProcedure.use(moduleGuard('promotions', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [promo] = await db
        .select()
        .from(schema.promotions)
        .where(and(eq(schema.promotions.id, input.id), isNull(schema.promotions.deletedAt)))
        .limit(1);

      if (!promo) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion not found" });
      return promo;
    }),

  create: protectedProcedure.use(moduleGuard('promotions', 'create'))
    .input(z.object({
      name: z.string().min(1).max(255),
      type: z.string().max(50).optional(),
      discountPercent: zMoneyOptional(),
      commissionPercent: zMoneyOptional(),
      commissionBase: z.string().max(50).optional(),
      startDate: z.string(),
      endDate: z.string(),
      maxUsesPerCode: z.number().optional(),
      description: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [result] = await db.insert(schema.promotions).values({
        name: input.name,
        type: input.type || "driver_referral",
        discountPercent: input.discountPercent || "5.00",
        commissionPercent: input.commissionPercent || "5.00",
        commissionBase: input.commissionBase || "rental_fee",
        startDate: parseCalendarDate(input.startDate),
        endDate: parseCalendarDate(input.endDate),
        maxUsesPerCode: input.maxUsesPerCode,
        description: input.description,
        createdBy: ctx.user?.id,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "promotion",
        entityId: result.id,
        metadata: { name: input.name },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  update: protectedProcedure.use(moduleGuard('promotions', 'update'))
    .input(z.object({
      id: z.number(),
      name: z.string().max(255).optional(),
      discountPercent: zMoneyOptional(),
      commissionPercent: zMoneyOptional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      isActive: z.boolean().optional(),
      maxUsesPerCode: z.number().nullable().optional(),
      description: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { id, startDate, endDate, ...rest } = input;
      const data: Record<string, unknown> = { ...rest, updatedAt: new Date() };
      if (startDate) data.startDate = parseCalendarDate(startDate);
      if (endDate) data.endDate = parseCalendarDate(endDate);

      const [result] = await db.update(schema.promotions)
        .set(data)
        .where(and(eq(schema.promotions.id, id), isNull(schema.promotions.deletedAt)))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion not found" });

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "promotion",
        entityId: id,
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('promotions', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.update(schema.promotions)
        .set({ deletedAt: new Date() })
        .where(eq(schema.promotions.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "promotion",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  // ─── Referral Codes ──────────────────────────────────────

  generateCodes: protectedProcedure.use(moduleGuard('promotions', 'create'))
    .input(z.object({
      promotionId: z.number(),
      driverIds: z.array(z.number()).min(1),
      codePrefix: z.string().max(20).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Verify promotion exists
      const [promo] = await db.select().from(schema.promotions)
        .where(and(eq(schema.promotions.id, input.promotionId), isNull(schema.promotions.deletedAt)))
        .limit(1);
      if (!promo) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion not found" });

      // Get drivers
      const ops = await db.select().from(schema.drivers)
        .where(and(
          inArray(schema.drivers.id, input.driverIds),
          isNull(schema.drivers.deletedAt),
        ));

      const results = [];
      for (const op of ops) {
        // Check if code already exists for this driver in this promotion
        const [existing] = await db.select().from(schema.referralCodes)
          .where(and(
            eq(schema.referralCodes.promotionId, input.promotionId),
            eq(schema.referralCodes.driverId, op.id),
          ))
          .limit(1);

        if (existing) continue; // skip duplicate

        const prefix = input.codePrefix || "DR";
        // Generate random 4-char alphanumeric suffix, retry on collision
        let code = "";
        for (let attempt = 0; attempt < 10; attempt++) {
          const rand = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
          code = `${prefix}${rand}`;
          const [dup] = await db.select({ id: schema.referralCodes.id }).from(schema.referralCodes).where(eq(schema.referralCodes.code, code)).limit(1);
          if (!dup) break;
        }

        const [created] = await db.insert(schema.referralCodes).values({
          promotionId: input.promotionId,
          driverId: op.id,
          code,
        }).returning();
        results.push(created);
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "referral_codes",
        entityId: input.promotionId,
        metadata: { count: results.length },
        ipAddress: ctx.req?.ip,
      });

      return results;
    }),

  listCodes: protectedProcedure.use(moduleGuard('promotions', 'read'))
    .input(z.object({
      promotionId: z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [];
      if (input?.promotionId) {
        conditions.push(eq(schema.referralCodes.promotionId, input.promotionId));
      }

      return db
        .select({
          code: schema.referralCodes,
          driver: {
            id: schema.drivers.id,
            name: schema.drivers.name,
            phone: schema.drivers.phone,
          },
        })
        .from(schema.referralCodes)
        .leftJoin(schema.drivers, and(eq(schema.referralCodes.driverId, schema.drivers.id), isNull(schema.drivers.deletedAt)))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.referralCodes.createdAt));
    }),

  updateCode: protectedProcedure.use(moduleGuard('promotions', 'update'))
    .input(z.object({
      id: z.number(),
      code: z.string().max(50).optional(),
      isActive: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { id, ...data } = input;
      const [result] = await db.update(schema.referralCodes)
        .set(data)
        .where(eq(schema.referralCodes.id, id))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Referral code not found" });
      return result;
    }),

  deleteCode: protectedProcedure.use(moduleGuard('promotions', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // The referral_ledger FK onto referral_codes is ON DELETE CASCADE, so a
      // hard delete of a code with commission history would permanently destroy
      // that ledger (unauditable financial data loss). If any ledger rows
      // reference this code, deactivate it instead of deleting.
      const [{ count: ledgerCount } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.referralLedger)
        .where(eq(schema.referralLedger.referralCodeId, input.id));

      if (ledgerCount > 0) {
        const [deactivated] = await db.update(schema.referralCodes)
          .set({ isActive: false })
          .where(eq(schema.referralCodes.id, input.id))
          .returning();
        if (!deactivated) throw new TRPCError({ code: "NOT_FOUND", message: "Referral code not found" });
        await logAudit({
          userId: ctx.user?.id,
          action: "update",
          entityType: "referral_code",
          entityId: input.id,
          metadata: { deactivated: true, reason: "has commission ledger history" },
          ipAddress: ctx.req?.ip,
        });
        return { success: true, deactivated: true };
      }

      const [result] = await db.delete(schema.referralCodes)
        .where(eq(schema.referralCodes.id, input.id))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Referral code not found" });

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "referral_code",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  // ─── Public: Validate referral code ──────────────────────

  validateCode: publicProcedure
    .input(z.object({ code: z.string().max(50) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { valid: false, message: "Service unavailable" };

      const [rc] = await db
        .select({
          code: schema.referralCodes,
          promotion: schema.promotions,
          driverName: schema.drivers.name,
        })
        .from(schema.referralCodes)
        .innerJoin(schema.promotions, eq(schema.referralCodes.promotionId, schema.promotions.id))
        .leftJoin(schema.drivers, and(eq(schema.referralCodes.driverId, schema.drivers.id), isNull(schema.drivers.deletedAt)))
        .where(and(
          eq(schema.referralCodes.code, input.code.toUpperCase()),
          eq(schema.referralCodes.isActive, true),
          isNull(schema.promotions.deletedAt),
        ))
        .limit(1);

      if (!rc) return { valid: false, message: "Invalid referral code" };

      const now = new Date();
      const promo = rc.promotion;
      if (!promo.isActive) return { valid: false, message: "Promotion is no longer active" };
      if (now < promo.startDate || now > promo.endDate) return { valid: false, message: "Promotion has expired" };

      if (promo.maxUsesPerCode && rc.code.totalUses >= promo.maxUsesPerCode) {
        return { valid: false, message: "Referral code usage limit reached" };
      }

      return {
        valid: true,
        discountPercent: promo.discountPercent,
        driverName: rc.driverName,
        promotionName: promo.name,
      };
    }),
});
