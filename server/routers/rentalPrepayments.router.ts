import { z } from "zod";
import { i18nError } from "../_core/i18nError";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, desc, isNull, isNotNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { parseCalendarDate } from "../_core/dateUtils";
import { recalculateInvoicesForRental } from "../services/invoiceGenerator";
import { getOrderAmountOwed } from "../services/orderCharges";
import { logger } from "../_core/logger";
import { paymentMethodSchema } from "../../shared/paymentMethod";
import { EDIT_REASONS } from "../../shared/editReasons";
import { assertEditable, assertEditReason, diffFields, logEdit } from "../services/editableGuard";

// Keep this order's invoice(s) in lock-step with its prepayment ledger so the
// invoices view (已付/部分/已发送) always matches 订单管理. Best-effort.
async function syncInvoicesForRental(rentalRequestId: number) {
  try {
    await recalculateInvoicesForRental(rentalRequestId);
  } catch (err) {
    logger.warn("[rentalPrepayments] invoice resync failed (non-fatal)", {
      rentalRequestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

export const rentalPrepaymentsRouter = router({
  list: protectedProcedure.use(moduleGuard("rentals", "read"))
    .input(z.object({ rentalRequestId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(schema.rentalPrepayments)
        .where(and(
          eq(schema.rentalPrepayments.rentalRequestId, input.rentalRequestId),
          isNull(schema.rentalPrepayments.deletedAt),
        ))
        .orderBy(desc(schema.rentalPrepayments.paymentDate));
    }),

  create: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({
      rentalRequestId: z.number(),
      amount: z.string().regex(MONEY_RE, "Invalid monetary amount"),
      paymentMethod: paymentMethodSchema.optional(),
      paymentDate: z.string().optional(),
      notes: z.string().max(1000).optional(),
      // Optional: tag this collection to a specific invoice of the order (used
      // for multi-invoice monthly-credit/renewal orders). Omitted → order-level
      // deposit allocated oldest-first (FIFO) by allocatePrepayments().
      invoiceId: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Verify rental exists (and isn't soft-deleted)
      const [rental] = await db
        .select({ id: schema.rentalRequests.id })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw i18nError({ code: "NOT_FOUND", message: "Rental not found", i18nKey: "errors.rentalNotFound" });

      if (parseFloat(input.amount) <= 0) {
        throw i18nError({ code: "BAD_REQUEST", message: "Amount must be greater than zero", i18nKey: "errors.amountMustBePositive" });
      }

      // If tagging a specific invoice, it must belong to this same order — never
      // let a payment be allocated to another order's invoice.
      if (input.invoiceId != null) {
        const [inv] = await db
          .select({ id: schema.invoices.id })
          .from(schema.invoices)
          .where(and(
            eq(schema.invoices.id, input.invoiceId),
            eq(schema.invoices.rentalId, input.rentalRequestId),
            isNull(schema.invoices.deletedAt),
          ))
          .limit(1);
        if (!inv) throw i18nError({ code: "BAD_REQUEST", message: "Invoice does not belong to this order", i18nKey: "errors.prepayment.invoiceNotOnOrder" });
      }

      const [created] = await db
        .insert(schema.rentalPrepayments)
        .values({
          rentalRequestId: input.rentalRequestId,
          amount: input.amount,
          paymentMethod: input.paymentMethod,
          paymentDate: input.paymentDate ? parseCalendarDate(input.paymentDate) : new Date(),
          notes: input.notes,
          invoiceId: input.invoiceId ?? null,
          createdBy: ctx.user?.id,
        })
        .returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "rental_prepayment",
        entityId: created.id,
        changes: { amount: { old: null, new: input.amount } },
        metadata: { rentalRequestId: input.rentalRequestId, paymentMethod: input.paymentMethod },
        ipAddress: ctx.req?.ip,
      });

      await syncInvoicesForRental(input.rentalRequestId);

      return created;
    }),

  /**
   * Correct a recorded payment (amount / method / date / notes).
   *
   * A payment is a record of money actually received, so it is corrected in
   * place only while it is still safe to do so: assertEditable refuses once the
   * row is on an issued invoice or the order is closed. Every correction carries
   * a mandatory reason, and the invoice ledger is resynced afterwards — changing
   * an amount without that leaves "已付/余额" showing the old figure.
   */
  update: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({
      id: z.number(),
      amount: z.string().regex(MONEY_RE, "Invalid monetary amount").optional(),
      paymentMethod: paymentMethodSchema.optional(),
      paymentDate: z.string().optional(),
      notes: z.string().max(1000).optional(),
      reason: z.enum(EDIT_REASONS),
      reasonNote: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.rentalPrepayments)
        .where(and(eq(schema.rentalPrepayments.id, input.id), isNull(schema.rentalPrepayments.deletedAt)))
        .limit(1);
      if (!existing) throw i18nError({ code: "NOT_FOUND", message: "Prepayment not found", i18nKey: "errors.prepayment.notFound" });

      const evidence = assertEditReason(input.reason, input.reasonNote);
      await assertEditable({
        invoiceId: existing.invoiceId,
        rentalRequestId: existing.rentalRequestId,
        subject: "payment",
      });

      if (input.amount !== undefined && parseFloat(input.amount) <= 0) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "Amount must be greater than zero",
          i18nKey: "errors.amountMustBePositive",
        });
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.amount !== undefined) patch.amount = input.amount;
      if (input.paymentMethod !== undefined) patch.paymentMethod = input.paymentMethod;
      if (input.paymentDate !== undefined) patch.paymentDate = parseCalendarDate(input.paymentDate);
      if (input.notes !== undefined) patch.notes = input.notes;

      const changes = diffFields(existing as unknown as Record<string, unknown>, patch);
      // updatedAt always differs; a correction that changes nothing else should
      // not write an audit entry claiming something was corrected.
      delete changes.updatedAt;
      if (Object.keys(changes).length === 0) return { ok: true, unchanged: true };

      await db
        .update(schema.rentalPrepayments)
        .set(patch)
        .where(eq(schema.rentalPrepayments.id, input.id));

      await logEdit({
        userId: ctx.user?.id,
        entityType: "rental_prepayment",
        entityId: input.id,
        rentalRequestId: existing.rentalRequestId,
        changes,
        evidence,
        ipAddress: ctx.req?.ip,
      });

      // The amount may have moved, so the order's invoices must be re-allocated
      // or 已付/余额 keeps reporting the pre-correction figure.
      await syncInvoicesForRental(existing.rentalRequestId);

      return { ok: true };
    }),

  delete: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({
      id: z.number(),
      reason: z.enum(EDIT_REASONS),
      reasonNote: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.rentalPrepayments)
        .where(and(eq(schema.rentalPrepayments.id, input.id), isNull(schema.rentalPrepayments.deletedAt)))
        .limit(1);
      if (!existing) throw i18nError({ code: "NOT_FOUND", message: "Prepayment not found", i18nKey: "errors.prepayment.notFound" });

      const evidence = assertEditReason(input.reason, input.reasonNote);
      await assertEditable({
        invoiceId: existing.invoiceId,
        rentalRequestId: existing.rentalRequestId,
        subject: "payment",
      });

      await db
        .update(schema.rentalPrepayments)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.rentalPrepayments.id, input.id));

      await logEdit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "rental_prepayment",
        entityId: input.id,
        rentalRequestId: existing.rentalRequestId,
        changes: { amount: { old: existing.amount, new: null } },
        evidence,
        ipAddress: ctx.req?.ip,
      });

      await syncInvoicesForRental(existing.rentalRequestId);

      return { ok: true };
    }),

  // 预付款转租金 — convert all HELD prepayments on this order to rent in one step.
  // Until converted, a prepayment is money received but not applied, so it doesn't
  // settle the order's invoice(s). This is the deliberate manual step: only after
  // converting do the invoices reflect the payment (已付/部分).
  convertToRent: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({ rentalRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select({ id: schema.rentalRequests.id })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw i18nError({ code: "NOT_FOUND", message: "Rental not found", i18nKey: "errors.rentalNotFound" });

      const converted = await db
        .update(schema.rentalPrepayments)
        .set({ appliedAt: new Date(), appliedBy: ctx.user?.id, updatedAt: new Date() })
        .where(and(
          eq(schema.rentalPrepayments.rentalRequestId, input.rentalRequestId),
          isNull(schema.rentalPrepayments.deletedAt),
          isNull(schema.rentalPrepayments.appliedAt),
        ))
        .returning({ id: schema.rentalPrepayments.id, amount: schema.rentalPrepayments.amount });

      if (converted.length > 0) {
        await logAudit({
          userId: ctx.user?.id,
          action: "update",
          entityType: "rental_prepayment",
          entityId: input.rentalRequestId,
          metadata: {
            rentalRequestId: input.rentalRequestId,
            action: "convert_to_rent",
            count: converted.length,
            total: converted.reduce((s, c) => s + parseFloat(c.amount || "0"), 0).toFixed(2),
          },
          ipAddress: ctx.req?.ip,
        });
        await syncInvoicesForRental(input.rentalRequestId);
      }

      return { converted: converted.length };
    }),

  // 撤销转租金 — put this order's converted payments back to 待转 (held) so staff can
  // redo the conversion by hand. Reverts only POSITIVE payment rows; refunds
  // (negative rows) stay applied. The invoice un-settles until re-converted.
  unconvert: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({ rentalRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select({ id: schema.rentalRequests.id })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw i18nError({ code: "NOT_FOUND", message: "Rental not found", i18nKey: "errors.rentalNotFound" });

      const reverted = await db
        .update(schema.rentalPrepayments)
        .set({ appliedAt: null, appliedBy: null, updatedAt: new Date() })
        .where(and(
          eq(schema.rentalPrepayments.rentalRequestId, input.rentalRequestId),
          isNull(schema.rentalPrepayments.deletedAt),
          isNotNull(schema.rentalPrepayments.appliedAt),
          sql`${schema.rentalPrepayments.amount}::numeric > 0`,
        ))
        .returning({ id: schema.rentalPrepayments.id });

      if (reverted.length > 0) {
        await logAudit({
          userId: ctx.user?.id,
          action: "update",
          entityType: "rental_prepayment",
          entityId: input.rentalRequestId,
          metadata: { rentalRequestId: input.rentalRequestId, action: "unconvert_to_held", count: reverted.length },
          ipAddress: ctx.req?.ip,
        });
        await syncInvoicesForRental(input.rentalRequestId);
      }

      return { reverted: reverted.length };
    }),

  // 记录退款 — money returned to the customer when applied prepayments exceed the
  // rent (overpayment / 应退). Stored as a NEGATIVE applied ledger row so the
  // order's net balance reflects reality (no phantom "owe customer") while keeping
  // the audit trail ("收 $1000 / 退 $636.14"). Invoice allocation ignores
  // non-positive amounts, so refunds don't un-settle invoices.
  recordRefund: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({
      rentalRequestId: z.number(),
      amount: z.string().regex(MONEY_RE, "Invalid monetary amount"),
      paymentMethod: paymentMethodSchema.optional(),
      paymentDate: z.string().optional(),
      notes: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select({ id: schema.rentalRequests.id, totalAmount: schema.rentalRequests.totalAmount })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw i18nError({ code: "NOT_FOUND", message: "Rental not found", i18nKey: "errors.rentalNotFound" });

      const refund = parseFloat(input.amount);
      if (refund <= 0) throw i18nError({ code: "BAD_REQUEST", message: "Amount must be greater than zero", i18nKey: "errors.amountMustBePositive" });

      // Net of what's already applied (positive payments minus prior refunds).
      const applied = await db
        .select({ amount: schema.rentalPrepayments.amount })
        .from(schema.rentalPrepayments)
        .where(and(
          eq(schema.rentalPrepayments.rentalRequestId, input.rentalRequestId),
          isNull(schema.rentalPrepayments.deletedAt),
          isNotNull(schema.rentalPrepayments.appliedAt),
        ));
      const appliedNet = applied.reduce((s, a) => s + parseFloat(a.amount || "0"), 0);
      // Owed = base total + accepted/invoiced extra charges (+tax). Using the bare
      // totalAmount here over-refunds by any extra charge (e.g. a gas fee), since
      // those are billed but never folded into totalAmount.
      const owed = await getOrderAmountOwed(input.rentalRequestId, parseFloat(rental.totalAmount || "0"));
      const overpaid = appliedNet - owed;
      if (overpaid <= 0.005) {
        throw i18nError({ code: "BAD_REQUEST", message: "No overpayment to refund on this order", i18nKey: "errors.prepayment.noOverpayment" });
      }
      if (refund > overpaid + 0.005) {
        throw i18nError({ code: "BAD_REQUEST", message: `Refund exceeds the amount owed to the customer (${overpaid.toFixed(2)})`, i18nKey: "errors.prepayment.refundExceedsOwed", i18nParams: { amount: overpaid.toFixed(2) } });
      }

      const [created] = await db
        .insert(schema.rentalPrepayments)
        .values({
          rentalRequestId: input.rentalRequestId,
          amount: (-refund).toFixed(2),
          paymentMethod: input.paymentMethod,
          paymentDate: input.paymentDate ? parseCalendarDate(input.paymentDate) : new Date(),
          notes: input.notes,
          appliedAt: new Date(),
          appliedBy: ctx.user?.id,
          createdBy: ctx.user?.id,
        })
        .returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "rental_prepayment",
        entityId: created.id,
        changes: { amount: { old: null, new: (-refund).toFixed(2) } },
        metadata: { rentalRequestId: input.rentalRequestId, action: "refund", refund: refund.toFixed(2) },
        ipAddress: ctx.req?.ip,
      });

      await syncInvoicesForRental(input.rentalRequestId);

      return created;
    }),
});
