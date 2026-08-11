import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { calendarPartsInTimeZone, zonedTodayPlusDaysUtc } from "../_core/dateUtils";
import { logAudit } from "../services/auditLog";
import { calculateTax } from "../services/taxCalculation";
import { logger } from "../_core/logger";
import { assertEditable, assertEditReason, diffFields, logEdit } from "../services/editableGuard";
import { EDIT_REASONS } from "../../shared/editReasons";
import { i18nError } from "../_core/i18nError";
import { EXTRA_CHARGE_REASONS } from "../../shared/extraCharges";
import type { SQL } from "drizzle-orm";

export const damageClaimsRouter = router({
  list: protectedProcedure.use(moduleGuard('damage_claims', 'read'))
    .input(z.object({
      rentalId: z.number().optional(),
      status: z.string().optional(),
      limit: z.number().min(1).max(500).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      // Soft-deleted charges are gone for every reader — list, receivables and
      // invoicing all filter on deletedAt so a deleted charge stops being money.
      const conditions: SQL[] = [isNull(schema.damageClaims.deletedAt)];
      if (input?.rentalId) conditions.push(eq(schema.damageClaims.rentalId, input.rentalId));
      if (input?.status) conditions.push(eq(schema.damageClaims.status, input.status));

      return db
        .select()
        .from(schema.damageClaims)
        .leftJoin(schema.customers, and(eq(schema.damageClaims.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.rentalRequests, and(eq(schema.damageClaims.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .where(and(...conditions))
        .orderBy(desc(schema.damageClaims.createdAt))
        .limit(input?.limit ?? 200);
    }),

  create: protectedProcedure.use(moduleGuard('damage_claims', 'create'))
    .input(z.object({
      inspectionId: z.number().optional(),
      rentalId: z.number(),
      customerId: z.number().optional(),
      chargeType: z.enum(EXTRA_CHARGE_REASONS).optional(),
      description: z.string().min(1).max(5000),
      repairEstimate: z.number().optional(),
      amount: z.number().nonnegative().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Get customer from rental if not provided
      let customerId = input.customerId;
      if (!customerId) {
        const [rental] = await db.select().from(schema.rentalRequests).where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt))).limit(1);
        customerId = rental?.customerId || undefined;
      }

      // Damage keeps the claim lifecycle (pending → … → accepted); simple charges
      // (fuel/cleaning/…) with an amount are immediately billable (accepted).
      const chargeType = input.chargeType ?? "damage";
      const isSimple = chargeType !== "damage" && input.amount !== undefined;

      const [result] = await db.insert(schema.damageClaims).values({
        inspectionId: input.inspectionId,
        rentalId: input.rentalId,
        customerId,
        chargeType,
        description: input.description,
        repairEstimate: input.repairEstimate?.toFixed(2),
        amount: input.amount?.toFixed(2),
        approvedAmount: isSimple ? input.amount?.toFixed(2) : undefined,
        status: isSimple ? "accepted" : "pending",
        createdBy: ctx.user?.id,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "damage_claim",
        entityId: result.id,
        metadata: { rentalId: input.rentalId },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  updateStatus: protectedProcedure.use(moduleGuard('damage_claims', 'update'))
    .input(z.object({
      id: z.number(),
      status: z.enum(["pending", "estimated", "customer_notified", "accepted", "invoiced", "disputed"]),
      approvedAmount: z.number().optional(),
      customerResponse: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const updateData: Record<string, unknown> = { status: input.status, updatedAt: new Date() };
      if (input.approvedAmount !== undefined) updateData.approvedAmount = input.approvedAmount.toFixed(2);
      if (input.customerResponse) updateData.customerResponse = input.customerResponse;
      if (input.status === "accepted" || input.status === "disputed") updateData.resolvedAt = new Date();

      const [result] = await db
        .update(schema.damageClaims)
        .set(updateData)
        .where(and(eq(schema.damageClaims.id, input.id), isNull(schema.damageClaims.deletedAt)))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND" });

      await logAudit({
        userId: ctx.user?.id,
        action: "status_change",
        entityType: "damage_claim",
        entityId: input.id,
        changes: { status: { old: null, new: input.status } },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  /**
   * Correct an already-recorded extra charge in place.
   *
   * Gated by the shared editableGuard (not invoiced, order still open) and
   * requires a reason — the amount is money the customer will be billed, so the
   * old→new diff plus the "why" is the evidence chain a finance reviewer needs.
   */
  update: protectedProcedure.use(moduleGuard('damage_claims', 'update'))
    .input(z.object({
      id: z.number(),
      amount: z.number().optional(),
      description: z.string().min(1).max(5000).optional(),
      chargeType: z.enum(EXTRA_CHARGE_REASONS).optional(),
      reason: z.enum(EDIT_REASONS),
      reasonNote: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.damageClaims)
        .where(and(eq(schema.damageClaims.id, input.id), isNull(schema.damageClaims.deletedAt)))
        .limit(1);
      if (!existing) {
        throw i18nError({
          code: "NOT_FOUND",
          message: "Extra charge not found",
          i18nKey: "errors.damageClaim.notFound",
        });
      }

      const evidence = assertEditReason(input.reason, input.reasonNote);

      // Status "invoiced" is the second way a claim gets billed: the batch
      // reconciliation path (invoiceGenerator) flips the status, and a later
      // invoice cancellation can clear invoiceId while the status remains — so
      // invoiceId alone is not a sufficient billed-check here.
      if (existing.status === "invoiced") {
        throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "This extra charge is already on an issued invoice and cannot be edited. Waive it instead, which issues a credit note.",
          i18nKey: "errors.edit.alreadyInvoiced",
          i18nParams: { subject: "charge" },
        });
      }

      await assertEditable({
        invoiceId: existing.invoiceId,
        rentalRequestId: existing.rentalId,
        subject: "charge",
      });

      if (input.amount !== undefined && input.amount <= 0) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "Amount must be greater than zero",
          i18nKey: "errors.amountMustBePositive",
        });
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.description !== undefined) patch.description = input.description;
      if (input.chargeType !== undefined) patch.chargeType = input.chargeType;
      if (input.amount !== undefined) {
        const money = input.amount.toFixed(2);
        // Mirror create(): "damage" carries its number in repairEstimate, every
        // other reason in amount. approvedAmount is what actually gets billed
        // (orderCharges/invoiceGenerator read it first), so it must move too —
        // otherwise the edit would display but not change what is charged.
        if ((input.chargeType ?? existing.chargeType) === "damage") {
          patch.repairEstimate = money;
        } else {
          patch.amount = money;
        }
        if (existing.approvedAmount != null) patch.approvedAmount = money;
      }

      const changes = diffFields(existing as unknown as Record<string, unknown>, patch);
      delete changes.updatedAt;
      if (Object.keys(changes).length === 0) return { ok: true, unchanged: true };

      await db.update(schema.damageClaims).set(patch).where(eq(schema.damageClaims.id, input.id));

      await logEdit({
        userId: ctx.user?.id,
        entityType: "damage_claim",
        entityId: input.id,
        rentalRequestId: existing.rentalId,
        changes,
        evidence,
        ipAddress: ctx.req?.ip,
      });

      return { ok: true };
    }),

  /** Soft-delete an extra charge. Same gate + reason as update. */
  delete: protectedProcedure.use(moduleGuard('damage_claims', 'delete'))
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
        .from(schema.damageClaims)
        .where(and(eq(schema.damageClaims.id, input.id), isNull(schema.damageClaims.deletedAt)))
        .limit(1);
      if (!existing) {
        throw i18nError({
          code: "NOT_FOUND",
          message: "Extra charge not found",
          i18nKey: "errors.damageClaim.notFound",
        });
      }

      const evidence = assertEditReason(input.reason, input.reasonNote);

      if (existing.status === "invoiced") {
        throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "This extra charge is already on an issued invoice and cannot be deleted. Waive it instead, which issues a credit note.",
          i18nKey: "errors.edit.alreadyInvoiced",
          i18nParams: { subject: "charge" },
        });
      }

      await assertEditable({
        invoiceId: existing.invoiceId,
        rentalRequestId: existing.rentalId,
        subject: "charge",
      });

      await db
        .update(schema.damageClaims)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.damageClaims.id, input.id));

      const oldAmount = existing.approvedAmount ?? existing.amount ?? existing.repairEstimate ?? null;
      await logEdit({
        userId: ctx.user?.id,
        entityType: "damage_claim",
        entityId: input.id,
        rentalRequestId: existing.rentalId,
        changes: { amount: { old: oldAmount, new: null } },
        evidence,
        action: "delete",
        ipAddress: ctx.req?.ip,
      });

      return { ok: true };
    }),

  generateInvoice: protectedProcedure.use(moduleGuard('damage_claims', 'update'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [claim] = await db.select().from(schema.damageClaims).where(and(eq(schema.damageClaims.id, input.id), isNull(schema.damageClaims.deletedAt))).limit(1);
      if (!claim) throw new TRPCError({ code: "NOT_FOUND" });
      if (claim.invoiceId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Invoice already generated" });
      // A claim must be explicitly accepted before it can be invoiced — otherwise
      // a direct API call could invoice an unapproved repair estimate (the UI only
      // guards this client-side).
      if (claim.status !== "accepted") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Claim must be accepted before an invoice can be generated" });
      }

      const amount = parseFloat(claim.approvedAmount || claim.amount || claim.repairEstimate || "0");
      if (amount <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No approved amount" });

      // The same claim billed through the rental invoice (reconcileAcceptedCharges
      // ...IntoInvoice) is taxed by province. Billed through this button it used to
      // carry a hardcoded taxAmount of "0" — so which screen the office happened to
      // use decided whether the customer was charged tax at all.
      let taxAmount = 0;
      let taxBreakdown = "";
      const [claimRental] = claim.rentalId
        ? await db
            .select({
              taxProvince: schema.rentalRequests.taxProvince,
              deliveryProvince: schema.rentalRequests.deliveryProvince,
              pickupProvince: schema.rentalRequests.pickupProvince,
            })
            .from(schema.rentalRequests)
            .where(eq(schema.rentalRequests.id, claim.rentalId))
            .limit(1)
        : [undefined];
      try {
        const taxResult = await calculateTax({
          rentalAmount: amount,
          shippingAmount: 0,
          ldwAmount: 0,
          depositAmount: 0,
          province: claimRental?.taxProvince || claimRental?.deliveryProvince || claimRental?.pickupProvince || "ON",
        });
        taxAmount = taxResult.totalTax;
        taxBreakdown = taxResult.taxBreakdown;
      } catch (err) {
        // Better an untaxed invoice the office can correct than no invoice at
        // all — but say so, rather than silently reproducing the old bug.
        logger.error("[damageClaims.generateInvoice] Tax calculation failed, invoicing untaxed", {
          claimId: claim.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const totalAmount = Math.round((amount + taxAmount) * 100) / 100;

      // Generate invoice
      const year = calendarPartsInTimeZone(new Date()).year;
      const prefix = `DMG-${year}-`;
      const [last] = await db
        .select({ invoiceNumber: schema.invoices.invoiceNumber })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.type, "damage"), isNull(schema.invoices.deletedAt)))
        .orderBy(desc(schema.invoices.invoiceNumber))
        .limit(1);
      let seq = 1;
      if (last?.invoiceNumber) {
        const parts = last.invoiceNumber.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
      }
      const invoiceNumber = `${prefix}${String(seq).padStart(4, "0")}`;

      const dueDate = zonedTodayPlusDaysUtc(30);

      const [invoice] = await db.insert(schema.invoices).values({
        invoiceNumber,
        rentalId: claim.rentalId,
        customerId: claim.customerId,
        type: "damage",
        status: "draft",
        subtotal: amount.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        taxBreakdown,
        taxProvince: claimRental?.taxProvince ?? undefined,
        totalAmount: totalAmount.toFixed(2),
        amountPaid: "0",
        balanceDue: totalAmount.toFixed(2),
        issueDate: new Date(),
        dueDate,
        notes: `Damage claim #${claim.id}: ${claim.description}`,
        createdBy: ctx.user?.id,
      }).returning();

      await db.insert(schema.invoiceLineItems).values({
        invoiceId: invoice.id,
        description: `Damage repair: ${claim.description}`,
        quantity: "1",
        unitPrice: amount.toFixed(2),
        amount: amount.toFixed(2),
        lineType: "damage",
        sortOrder: 1,
      });

      // Link invoice to claim
      await db.update(schema.damageClaims).set({
        invoiceId: invoice.id,
        status: "invoiced",
        updatedAt: new Date(),
      }).where(and(eq(schema.damageClaims.id, input.id), isNull(schema.damageClaims.deletedAt)));

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "invoice",
        entityId: invoice.id,
        metadata: { type: "damage", damageClaimId: input.id },
        ipAddress: ctx.req?.ip,
      });

      return { invoiceId: invoice.id, invoiceNumber };
    }),
});
