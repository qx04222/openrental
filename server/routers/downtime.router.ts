import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { calendarPartsInTimeZone } from "../_core/dateUtils";
import { logAudit } from "../services/auditLog";
import { calculateWorkingDaysLost } from "../services/downtimeCalculation";
import { assertEditable, assertEditReason, diffFields, logEdit } from "../services/editableGuard";
import { EDIT_REASONS } from "../../shared/editReasons";
import { i18nError } from "../_core/i18nError";
import type { SQL } from "drizzle-orm";

export const downtimeRouter = router({
  list: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({
      rentalId: z.number().optional(),
      status: z.string().optional(),
      limit: z.number().min(1).max(500).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions: SQL[] = [];
      if (input?.rentalId) conditions.push(eq(schema.downtimeRecords.rentalId, input.rentalId));
      if (input?.status) conditions.push(eq(schema.downtimeRecords.status, input.status));

      return db
        .select()
        .from(schema.downtimeRecords)
        .leftJoin(schema.rentalRequests, and(eq(schema.downtimeRecords.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .leftJoin(schema.rentalFleet, and(eq(schema.downtimeRecords.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.downtimeRecords.createdAt))
        .limit(input?.limit ?? 200);
    }),

  report: protectedProcedure.use(moduleGuard('rentals', 'create'))
    .input(z.object({
      rentalId: z.number(),
      rentalFleetId: z.number().optional(),
      reason: z.string().max(2000),
      reportedAt: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Get rental for daily rate
      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      const [result] = await db.insert(schema.downtimeRecords).values({
        rentalId: input.rentalId,
        rentalFleetId: input.rentalFleetId || rental.rentalFleetId,
        reportedAt: input.reportedAt ? new Date(input.reportedAt) : new Date(),
        status: "open",
        reason: input.reason,
        dailyRateAtTime: rental.rentalFee
          ? (parseFloat(rental.rentalFee) / Math.max(1, Math.ceil((rental.endDate.getTime() - rental.startDate.getTime()) / 86400000))).toFixed(2)
          : null,
        reportedBy: ctx.user?.id,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "downtime",
        entityId: result.id,
        metadata: { rentalId: input.rentalId, reason: input.reason },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  resolve: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      id: z.number(),
      resolvedAt: z.string().optional(),
      resolution: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.downtimeRecords)
        .where(eq(schema.downtimeRecords.id, input.id))
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Downtime record not found" });
      if (existing.status !== "open") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Can only resolve open records" });

      const resolvedAt = input.resolvedAt ? new Date(input.resolvedAt) : new Date();
      const calc = calculateWorkingDaysLost({ reportedAt: existing.reportedAt, resolvedAt });

      const dailyRate = parseFloat(existing.dailyRateAtTime || "0");
      const creditAmount = Math.round(calc.workingDaysLost * dailyRate * 100) / 100;

      const [result] = await db
        .update(schema.downtimeRecords)
        .set({
          resolvedAt,
          totalCalendarDays: calc.totalCalendarDays,
          excludedDays: calc.excludedDays,
          workingDaysLost: calc.workingDaysLost,
          creditAmount: creditAmount.toFixed(2),
          status: "resolved",
          resolution: input.resolution,
          updatedAt: new Date(),
        })
        .where(eq(schema.downtimeRecords.id, input.id))
        .returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "status_change",
        entityType: "downtime",
        entityId: input.id,
        changes: { status: { old: "open", new: "resolved" } },
        metadata: { workingDaysLost: calc.workingDaysLost, creditAmount },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  /**
   * Correct an already-recorded downtime row in place, with an evidence chain.
   *
   * Gate is the shared one (server/services/editableGuard): this table has no
   * `invoiceId` column, but `creditInvoiceId` is the same thing for this module —
   * it is set by issueCreditNote once the downtime has been credited onto an
   * issued credit note. Editing after that would desync the issued document, so
   * it is passed as the guard's invoiceId.
   */
  update: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      id: z.number(),
      reportedAt: z.string().optional(),
      resolvedAt: z.string().optional(),
      reason: z.string().max(2000).optional(),
      resolution: z.string().max(2000).optional(),
      // Evidence chain — mandatory on every correction.
      editReason: z.enum(EDIT_REASONS),
      reasonNote: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // downtime_records has no deletedAt column — no soft-delete filter to add.
      const [existing] = await db
        .select()
        .from(schema.downtimeRecords)
        .where(eq(schema.downtimeRecords.id, input.id))
        .limit(1);

      if (!existing) {
        throw i18nError({
          code: "NOT_FOUND",
          message: "Downtime record not found",
          i18nKey: "errors.downtime.notFound",
        });
      }

      const evidence = assertEditReason(input.editReason, input.reasonNote);
      await assertEditable({
        invoiceId: existing.creditInvoiceId,
        rentalRequestId: existing.rentalId,
        subject: "downtime",
      });

      const reportedAt = input.reportedAt ? new Date(input.reportedAt) : existing.reportedAt;
      const resolvedAt = input.resolvedAt ? new Date(input.resolvedAt) : existing.resolvedAt;

      if (input.reportedAt && Number.isNaN(reportedAt.getTime())) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "Invalid reported-at date",
          i18nKey: "errors.downtime.invalidDate",
        });
      }
      if (input.resolvedAt && (!resolvedAt || Number.isNaN(resolvedAt.getTime()))) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "Invalid resolved-at date",
          i18nKey: "errors.downtime.invalidDate",
        });
      }
      if (resolvedAt && resolvedAt.getTime() < reportedAt.getTime()) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "Resolved time must be after the reported time",
          i18nKey: "errors.downtime.resolvedBeforeReported",
        });
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.reportedAt !== undefined) patch.reportedAt = reportedAt;
      if (input.resolvedAt !== undefined) patch.resolvedAt = resolvedAt;
      if (input.reason !== undefined) patch.reason = input.reason;
      if (input.resolution !== undefined) patch.resolution = input.resolution;

      // Derived day counts and the credit amount are a pure function of the two
      // timestamps (see resolve, above). If the window moved on an already-resolved
      // record, they are recomputed through the SAME service call resolve uses —
      // no independent arithmetic — so the row cannot be left internally
      // inconsistent. This is only ever reached when no credit note exists yet
      // (assertEditable above rejects credited rows), so no issued document moves.
      const windowMoved = input.reportedAt !== undefined || input.resolvedAt !== undefined;
      if (windowMoved && resolvedAt) {
        const calc = calculateWorkingDaysLost({ reportedAt, resolvedAt });
        const dailyRate = parseFloat(existing.dailyRateAtTime || "0");
        patch.totalCalendarDays = calc.totalCalendarDays;
        patch.excludedDays = calc.excludedDays;
        patch.workingDaysLost = calc.workingDaysLost;
        patch.creditAmount = (Math.round(calc.workingDaysLost * dailyRate * 100) / 100).toFixed(2);
      }

      const changes = diffFields(existing as unknown as Record<string, unknown>, patch);
      delete changes.updatedAt;
      if (Object.keys(changes).length === 0) return { ok: true, unchanged: true };

      await db
        .update(schema.downtimeRecords)
        .set(patch)
        .where(eq(schema.downtimeRecords.id, input.id));

      await logEdit({
        userId: ctx.user?.id,
        entityType: "downtime_record",
        entityId: input.id,
        rentalRequestId: existing.rentalId,
        changes,
        evidence,
        ipAddress: ctx.req?.ip,
      });

      return { ok: true };
    }),

  issueCreditNote: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [record] = await db
        .select()
        .from(schema.downtimeRecords)
        .where(eq(schema.downtimeRecords.id, input.id))
        .limit(1);

      if (!record) throw new TRPCError({ code: "NOT_FOUND" });
      if (record.status !== "resolved") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Must be resolved first" });
      if (record.creditInvoiceId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Credit note already issued" });

      const creditAmount = parseFloat(record.creditAmount || "0");
      if (creditAmount <= 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No credit to issue" });

      // Get rental for customer info
      if (!record.rentalId) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, record.rentalId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      // Use invoice generator to create credit note
      const { generateInvoiceFromRental: _generateInvoiceFromRental } = await import("../services/invoiceGenerator");

      // Create a manual credit note via direct insert
      const year = calendarPartsInTimeZone(new Date()).year;
      const prefix = `CN-${year}-`;
      const [last] = await db
        .select({ invoiceNumber: schema.invoices.invoiceNumber })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.type, "credit_note"), isNull(schema.invoices.deletedAt)))
        .orderBy(desc(schema.invoices.invoiceNumber))
        .limit(1);

      let seq = 1;
      if (last?.invoiceNumber) {
        const parts = last.invoiceNumber.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
      }
      const invoiceNumber = `${prefix}${String(seq).padStart(4, "0")}`;

      const [invoice] = await db.insert(schema.invoices).values({
        invoiceNumber,
        rentalId: record.rentalId,
        customerId: rental.customerId,
        type: "credit_note",
        status: "sent",
        subtotal: (-creditAmount).toFixed(2),
        taxAmount: "0",
        totalAmount: (-creditAmount).toFixed(2),
        amountPaid: "0",
        balanceDue: (-creditAmount).toFixed(2),
        taxProvince: rental.taxProvince,
        issueDate: new Date(),
        notes: `Downtime credit: ${record.workingDaysLost} working days @ $${parseFloat(record.dailyRateAtTime || "0").toFixed(2)}/day`,
        createdBy: ctx.user?.id,
      }).returning();

      // Insert credit line item
      await db.insert(schema.invoiceLineItems).values({
        invoiceId: invoice.id,
        description: `Downtime credit (${record.workingDaysLost} working days lost)`,
        quantity: String(record.workingDaysLost || 1),
        unitPrice: (-parseFloat(record.dailyRateAtTime || "0")).toFixed(2),
        amount: (-creditAmount).toFixed(2),
        lineType: "credit",
        sortOrder: 1,
      });

      // Link credit note to downtime record
      await db.update(schema.downtimeRecords).set({
        creditInvoiceId: invoice.id,
        status: "credited",
        updatedAt: new Date(),
      }).where(eq(schema.downtimeRecords.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "invoice",
        entityId: invoice.id,
        metadata: { type: "credit_note", downtimeId: input.id, creditAmount },
        ipAddress: ctx.req?.ip,
      });

      return { invoiceId: invoice.id, invoiceNumber, creditAmount };
    }),
});
