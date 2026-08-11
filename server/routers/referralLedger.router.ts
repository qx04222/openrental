import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, desc, sql } from "../db";
import * as schema from "../../drizzle/schema";

export const referralLedgerRouter = router({
  list: protectedProcedure.use(moduleGuard('promotions', 'read'))
    .input(z.object({
      promotionId: z.number().optional(),
      driverId: z.number().optional(),
      status: z.enum(["pending", "approved", "paid", "cancelled"]).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [];
      if (input?.driverId) {
        conditions.push(eq(schema.referralLedger.driverId, input.driverId));
      }
      if (input?.status) {
        conditions.push(eq(schema.referralLedger.commissionStatus, input.status));
      }

      // If promotionId filter, join through referralCodes
      const rows = await db
        .select({
          ledger: schema.referralLedger,
          code: {
            id: schema.referralCodes.id,
            code: schema.referralCodes.code,
            promotionId: schema.referralCodes.promotionId,
          },
          driver: {
            id: schema.drivers.id,
            name: schema.drivers.name,
          },
          customer: {
            id: schema.customers.id,
            name: schema.customers.name,
            company: schema.customers.company,
          },
          rental: {
            id: schema.rentalRequests.id,
            rentalNumber: schema.rentalRequests.rentalNumber,
          },
        })
        .from(schema.referralLedger)
        .leftJoin(schema.referralCodes, eq(schema.referralLedger.referralCodeId, schema.referralCodes.id))
        .leftJoin(schema.drivers, eq(schema.referralLedger.driverId, schema.drivers.id))
        .leftJoin(schema.customers, eq(schema.referralLedger.customerId, schema.customers.id))
        .leftJoin(schema.rentalRequests, eq(schema.referralLedger.rentalRequestId, schema.rentalRequests.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.referralLedger.createdAt));

      // Filter by promotionId if needed
      if (input?.promotionId) {
        return rows.filter(r => r.code?.promotionId === input.promotionId);
      }
      return rows;
    }),

  summary: protectedProcedure.use(moduleGuard('promotions', 'read'))
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
          driverId: schema.referralLedger.driverId,
          driverName: schema.drivers.name,
          totalEntries: sql<number>`count(*)::int`,
          totalRentalFee: sql<string>`coalesce(sum(${schema.referralLedger.rentalFee}::numeric), 0)`,
          totalDiscount: sql<string>`coalesce(sum(${schema.referralLedger.discountAmount}::numeric), 0)`,
          totalCommission: sql<string>`coalesce(sum(${schema.referralLedger.commissionAmount}::numeric), 0)`,
          pendingCommission: sql<string>`coalesce(sum(case when ${schema.referralLedger.commissionStatus} = 'pending' then ${schema.referralLedger.commissionAmount}::numeric else 0 end), 0)`,
          approvedCommission: sql<string>`coalesce(sum(case when ${schema.referralLedger.commissionStatus} = 'approved' then ${schema.referralLedger.commissionAmount}::numeric else 0 end), 0)`,
          paidCommission: sql<string>`coalesce(sum(case when ${schema.referralLedger.commissionStatus} = 'paid' then ${schema.referralLedger.commissionAmount}::numeric else 0 end), 0)`,
        })
        .from(schema.referralLedger)
        .leftJoin(schema.drivers, eq(schema.referralLedger.driverId, schema.drivers.id))
        .leftJoin(schema.referralCodes, eq(schema.referralLedger.referralCodeId, schema.referralCodes.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .groupBy(schema.referralLedger.driverId, schema.drivers.name);
    }),

  approve: protectedProcedure.use(moduleGuard('promotions', 'update'))
    .input(z.object({
      ids: z.array(z.number()).min(1),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      let updated = 0;
      for (const id of input.ids) {
        const [result] = await db.update(schema.referralLedger)
          .set({ commissionStatus: "approved" })
          .where(and(
            eq(schema.referralLedger.id, id),
            eq(schema.referralLedger.commissionStatus, "pending"),
          ))
          .returning();
        if (result) updated++;
      }
      return { updated };
    }),

  markPaid: protectedProcedure.use(moduleGuard('promotions', 'update'))
    .input(z.object({
      ids: z.array(z.number()).min(1),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      let updated = 0;
      for (const id of input.ids) {
        const [result] = await db.update(schema.referralLedger)
          .set({ commissionStatus: "paid", paidAt: new Date() })
          .where(and(
            eq(schema.referralLedger.id, id),
            eq(schema.referralLedger.commissionStatus, "approved"),
          ))
          .returning();
        if (result) updated++;
      }
      return { updated };
    }),
});
