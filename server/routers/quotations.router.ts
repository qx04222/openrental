import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, isNull } from "../db";
import * as schema from "../../drizzle/schema";

export const quotationsRouter = router({
  list: protectedProcedure.use(moduleGuard('invoices', 'read'))
    .input(z.object({
      status: z.enum(["draft", "sent", "accepted", "rejected", "expired", "cancelled"]).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const conditions = [isNull(schema.quotations.deletedAt)];
      if (input?.status) {
        conditions.push(eq(schema.quotations.status, input.status));
      }

      return db
        .select({
          quotation: schema.quotations,
          customer: schema.customers,
          rental: {
            id: schema.rentalRequests.id,
            rentalNumber: schema.rentalRequests.rentalNumber,
            customerName: schema.rentalRequests.customerName,
          },
        })
        .from(schema.quotations)
        .leftJoin(schema.customers, and(eq(schema.quotations.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.rentalRequests, and(eq(schema.quotations.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .where(and(...conditions))
        .orderBy(desc(schema.quotations.createdAt));
    }),

  getById: protectedProcedure.use(moduleGuard('invoices', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [row] = await db
        .select({
          quotation: schema.quotations,
          customer: schema.customers,
          rental: schema.rentalRequests,
        })
        .from(schema.quotations)
        .leftJoin(schema.customers, and(eq(schema.quotations.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.rentalRequests, and(eq(schema.quotations.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .where(and(eq(schema.quotations.id, input.id), isNull(schema.quotations.deletedAt)))
        .limit(1);

      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Quotation not found" });

      const lineItems = await db
        .select()
        .from(schema.quotationLineItems)
        .where(eq(schema.quotationLineItems.quotationId, input.id))
        .orderBy(schema.quotationLineItems.sortOrder);

      return { ...row, lineItems };
    }),

  updateStatus: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({
      id: z.number(),
      status: z.enum(["draft", "sent", "accepted", "rejected", "expired", "cancelled"]),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select({ status: schema.quotations.status })
        .from(schema.quotations)
        .where(and(eq(schema.quotations.id, input.id), isNull(schema.quotations.deletedAt)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Quotation not found" });

      const [result] = await db.update(schema.quotations).set({
        status: input.status,
        updatedAt: new Date(),
      }).where(and(eq(schema.quotations.id, input.id), isNull(schema.quotations.deletedAt))).returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Quotation not found" });

      return result;
    }),

  /**
   * Accept a quotation and convert it into a live order. Quotations are derived
   * from a rental, so "convert" = mark the quote accepted and approve the
   * underlying rental order, which runs the same transitionRentalStatus pipeline
   * as a normal approval (contract, dispatch, order confirmation) — pricing,
   * inventory, credit and deposit were already computed when the rental was
   * created. Idempotent when the order is already past pending.
   */
  acceptQuotation: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [quote] = await db
        .select()
        .from(schema.quotations)
        .where(and(eq(schema.quotations.id, input.id), isNull(schema.quotations.deletedAt)))
        .limit(1);
      if (!quote) throw new TRPCError({ code: "NOT_FOUND", message: "Quotation not found" });

      if (quote.status === "rejected" || quote.status === "cancelled") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot accept a ${quote.status} quotation` });
      }
      if (quote.validUntil && quote.validUntil.getTime() < Date.now()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Quotation has expired" });
      }
      if (!quote.rentalId) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Quotation is not linked to an order" });
      }

      // Mark accepted.
      await db.update(schema.quotations).set({ status: "accepted", updatedAt: new Date() })
        .where(eq(schema.quotations.id, input.id));

      // Approve / lock the underlying rental order (no-op if already past pending).
      const { transitionRentalStatus } = await import("./rentalRequests.router");
      const [rental] = await db
        .select({ status: schema.rentalRequests.status })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, quote.rentalId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      let transition = null;
      if (rental && rental.status === "pending") {
        transition = await transitionRentalStatus(db, {
          rentalId: quote.rentalId,
          targetStatus: "approved",
          actor: { id: ctx.user?.id, ip: ctx.req?.ip },
        });
      }

      return { ok: true, quotationId: input.id, rentalId: quote.rentalId, transition };
    }),

  generatePDF: protectedProcedure.use(moduleGuard('invoices', 'read'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const { generateQuotationPDF } = await import("../services/quotationPDF");
      return generateQuotationPDF(input.id);
    }),

  delete: protectedProcedure.use(moduleGuard('invoices', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [result] = await db.update(schema.quotations).set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(schema.quotations.id, input.id), isNull(schema.quotations.deletedAt))).returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Quotation not found" });
      return { success: true };
    }),
});
