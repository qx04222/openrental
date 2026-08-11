import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, desc, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { computeCreditWarning } from "../services/creditWarning";
import { generateInvoiceFromCharges } from "../services/invoiceGenerator";
import { i18nError } from "../_core/i18nError";
import { logger } from "../_core/logger";
import { assertEditable, assertEditReason, diffFields, logEdit } from "../services/editableGuard";
import { EDIT_REASONS } from "../../shared/editReasons";

const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;

/** A charge amount must be a well-formed, strictly positive money string. */
const zodPositiveMoney = z
  .string()
  .regex(MONEY_RE, "Invalid monetary amount")
  .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero");

/** The evidence half of every correction: why, plus a note when "other". */
const editReasonInput = {
  reason: z.enum(EDIT_REASONS),
  reasonNote: z.string().max(500).optional(),
};

/**
 * Load a rental and assert it's an open (unsettled) credit order. Shared guard
 * for the mutating endpoints below.
 *
 * This is NOT a replacement for `assertEditable` — it answers a different
 * question ("is this a credit order at all?") that the shared guard deliberately
 * does not know about. The two stack: assertEditable enforces the two company
 * rules (not invoiced, order not closed), this one enforces the credit-ledger
 * precondition.
 */
async function loadOpenCreditOrder(rentalRequestId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  const [rental] = await db
    .select()
    .from(schema.rentalRequests)
    .where(and(eq(schema.rentalRequests.id, rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);
  if (!rental) {
    throw i18nError({ code: "NOT_FOUND", message: "Rental not found", i18nKey: "errors.rentalNotFound" });
  }
  if (!rental.isCreditOrder) {
    throw i18nError({
      code: "BAD_REQUEST",
      message: "Not a credit order",
      i18nKey: "errors.charge.notCreditOrder",
    });
  }
  if (rental.creditFinalizedAt) {
    throw i18nError({
      code: "BAD_REQUEST",
      message: "Credit order is already settled",
      i18nKey: "errors.edit.orderSettled",
      i18nParams: { subject: "charge" },
    });
  }
  return { db, rental };
}

export const rentalChargesRouter = router({
  list: protectedProcedure.use(moduleGuard("rentals", "read"))
    .input(z.object({ rentalRequestId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(schema.rentalCharges)
        .where(and(
          eq(schema.rentalCharges.rentalRequestId, input.rentalRequestId),
          isNull(schema.rentalCharges.deletedAt),
        ))
        .orderBy(desc(schema.rentalCharges.chargeDate));
    }),

  create: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({
      rentalRequestId: z.number(),
      chargeType: z.enum(["adjustment", "final"]),
      amount: z.string().regex(MONEY_RE, "Invalid monetary amount"),
      description: z.string().max(1000).optional(),
      chargeDate: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { db, rental } = await loadOpenCreditOrder(input.rentalRequestId);

      const [created] = await db
        .insert(schema.rentalCharges)
        .values({
          rentalRequestId: input.rentalRequestId,
          chargeType: input.chargeType,
          amount: input.amount,
          description: input.description,
          chargeDate: input.chargeDate ? new Date(input.chargeDate) : new Date(),
          createdBy: ctx.user?.id,
        })
        .returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "rental_charge",
        entityId: created.id,
        changes: { amount: { old: null, new: input.amount } },
        metadata: { rentalRequestId: input.rentalRequestId, chargeType: input.chargeType },
        ipAddress: ctx.req?.ip,
      });

      const creditWarning = await computeCreditWarning(rental.customerId);
      return { charge: created, creditWarning };
    }),

  /**
   * Correct an already-recorded charge in place, with an evidence chain.
   *
   * Guarded twice on purpose (see loadOpenCreditOrder): the shared editable
   * guard owns the company-wide rules (never touch an invoiced row, never touch
   * a closed order), the local one owns the credit-ledger precondition.
   */
  update: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({
      id: z.number(),
      amount: zodPositiveMoney.optional(),
      description: z.string().max(1000).optional(),
      chargeDate: z.string().optional(),
      ...editReasonInput,
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.rentalCharges)
        .where(and(eq(schema.rentalCharges.id, input.id), isNull(schema.rentalCharges.deletedAt)))
        .limit(1);
      if (!existing) {
        throw i18nError({ code: "NOT_FOUND", message: "Charge not found", i18nKey: "errors.charge.notFound" });
      }

      const evidence = assertEditReason(input.reason, input.reasonNote);
      await assertEditable({
        invoiceId: existing.invoiceId,
        rentalRequestId: existing.rentalRequestId,
        subject: "charge",
      });
      const { rental } = await loadOpenCreditOrder(existing.rentalRequestId);

      // Only the fields the caller actually sent take part in the diff.
      // `updatedAt` is deliberately kept OUT of it — it changes on every write,
      // so folding it in would make the "nothing changed" check never fire and
      // would litter the change history with a meaningless row.
      const fields: Record<string, unknown> = {};
      if (input.amount !== undefined) fields.amount = input.amount;
      if (input.description !== undefined) fields.description = input.description;
      if (input.chargeDate !== undefined) fields.chargeDate = new Date(input.chargeDate);

      const changes = diffFields(existing as unknown as Record<string, unknown>, fields);
      if (Object.keys(changes).length === 0) return { ok: true, unchanged: true };

      await db
        .update(schema.rentalCharges)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(schema.rentalCharges.id, input.id));

      await logEdit({
        userId: ctx.user?.id,
        entityType: "rental_charge",
        entityId: input.id,
        rentalRequestId: existing.rentalRequestId,
        changes,
        evidence,
        extraMetadata: { chargeType: existing.chargeType },
        ipAddress: ctx.req?.ip,
      });

      // Amount moves change the customer's open exposure, same as create.
      const creditWarning = await computeCreditWarning(rental.customerId);
      return { ok: true, creditWarning };
    }),

  delete: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({ id: z.number(), ...editReasonInput }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.rentalCharges)
        .where(and(eq(schema.rentalCharges.id, input.id), isNull(schema.rentalCharges.deletedAt)))
        .limit(1);
      if (!existing) {
        throw i18nError({ code: "NOT_FOUND", message: "Charge not found", i18nKey: "errors.charge.notFound" });
      }

      const evidence = assertEditReason(input.reason, input.reasonNote);
      // Invoiced / closed-order rejection now comes from the shared guard, so
      // deleting obeys exactly the same two rules as editing.
      await assertEditable({
        invoiceId: existing.invoiceId,
        rentalRequestId: existing.rentalRequestId,
        subject: "charge",
      });
      // Block deleting once the order is settled / is not a credit order.
      await loadOpenCreditOrder(existing.rentalRequestId);

      await db
        .update(schema.rentalCharges)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.rentalCharges.id, input.id));

      await logEdit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "rental_charge",
        entityId: input.id,
        rentalRequestId: existing.rentalRequestId,
        changes: { amount: { old: existing.amount, new: null } },
        evidence,
        extraMetadata: { chargeType: existing.chargeType },
        ipAddress: ctx.req?.ip,
      });

      return { ok: true };
    }),

  generateInvoice: protectedProcedure.use(moduleGuard("rentals", "update"))
    .input(z.object({ rentalRequestId: z.number(), dueInDays: z.number().min(1).max(365).optional() }))
    .mutation(async ({ input, ctx }) => {
      // Allow billing even after settlement (e.g. a leftover unbilled balance),
      // but the rental must exist and be a credit order.
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const [rental] = await db
        .select({ id: schema.rentalRequests.id, isCreditOrder: schema.rentalRequests.isCreditOrder })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      if (!rental.isCreditOrder) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a credit order" });

      const result = await generateInvoiceFromCharges({
        rentalId: input.rentalRequestId,
        createdBy: ctx.user?.id,
        dueInDays: input.dueInDays,
      });

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "invoice",
        entityId: result.invoiceId,
        metadata: { rentalRequestId: input.rentalRequestId, source: "credit_charges", invoiceNumber: result.invoiceNumber },
        ipAddress: ctx.req?.ip,
      });

      // Best-effort PDF generation (mirror updateStatus invoice flow).
      try {
        const { generateInvoicePDF } = await import("../services/invoicePDF");
        await generateInvoicePDF(result.invoiceId);
      } catch (err) {
        logger.error("[RentalCharges] Auto PDF failed after generateInvoiceFromCharges", {
          invoiceId: result.invoiceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return result;
    }),
});
