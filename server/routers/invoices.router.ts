import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, desc, and, isNull, sql, inArray, gte, lt } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { logAudit } from "../services/auditLog";
import { generateInvoiceFromRental, recalculateInvoicePayments, recalculateInvoicesForRental } from "../services/invoiceGenerator";
import { parseCalendarDate, zonedTodayPlusDaysUtc, calendarPartsInTimeZone } from "../_core/dateUtils";
import { isInvoiceOverdue } from "../../shared/invoiceOverdue";
import { paymentMethodSchema } from "../../shared/paymentMethod";
import { overdueInvoiceWhereSql } from "../services/invoiceOverdueSql";
import { paymentReminderInvoiceIds } from "../services/invoicePaymentReminder";
import { deriveInvoiceAllocation } from "../services/dashboardFinancials";
import { waiveInvoicedCharge } from "../services/chargeWaiver";
import { EDIT_REASONS } from "../../shared/editReasons";

type InvoiceStatus = (typeof schema.invoices.$inferSelect)["status"];

/** The status to show the user, overriding the stored value with derived "overdue". */
function effectiveInvoiceStatus(
  inv: { status: InvoiceStatus; dueDate: Date | string | null; balanceDue: string | number | null },
  todayUtc: Date,
): InvoiceStatus {
  return isInvoiceOverdue(inv.status, inv.dueDate, inv.balanceDue, todayUtc) ? "overdue" : inv.status;
}

export const invoicesRouter = router({
  list: protectedProcedure.use(moduleGuard('invoices', 'read'))
    .input(z.object({
      // "unpaid" is a derived bucket (any issued invoice still owing money),
      // not a stored status.
      status: z.enum(["draft", "sent", "paid", "partial", "overdue", "unpaid", "cancelled", "credited"]).optional(),
      customerId: z.number().optional(),
      rentalId: z.number().optional(),
      // Date-range filter. dateField picks which column (开票日期 / 到期日);
      // dateFrom/dateTo are 'YYYY-MM-DD' (Toronto calendar, inclusive).
      dateField: z.enum(["issue", "due"]).optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      limit: z.number().min(1).max(1000).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      // NB: do NOT push a DB-level status filter — "overdue"/"unpaid" are derived,
      // and a stored 'sent'/'partial' row may be overdue (or vice-versa). We filter
      // by the EFFECTIVE status in JS after deriving it (~hundreds of rows, cheap).
      const conditions = [isNull(schema.invoices.deletedAt)];
      if (input?.customerId) conditions.push(eq(schema.invoices.customerId, input.customerId));
      if (input?.rentalId) conditions.push(eq(schema.invoices.rentalId, input.rentalId));

      // Date range (column-encoded Date comparisons — safe, not raw sql).
      if (input?.dateFrom || input?.dateTo) {
        const dateCol = input.dateField === "due" ? schema.invoices.dueDate : schema.invoices.issueDate;
        if (input.dateFrom) conditions.push(gte(dateCol, parseCalendarDate(input.dateFrom)));
        if (input.dateTo) {
          // Inclusive of the whole "to" day → use exclusive next-day midnight.
          const next = new Date(parseCalendarDate(input.dateTo).getTime() + 24 * 60 * 60 * 1000);
          conditions.push(lt(dateCol, next));
        }
      }

      const rows = await db
        .select()
        .from(schema.invoices)
        .leftJoin(schema.customers, and(eq(schema.invoices.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .where(and(...conditions))
        .orderBy(desc(schema.invoices.createdAt))
        .limit(input?.limit ?? 500);

      const reminderIds = await paymentReminderInvoiceIds();
      const todayUtc = zonedTodayPlusDaysUtc(0);
      const withEffective = rows.map((r) => ({
        ...r,
        invoices: {
          ...r.invoices,
          status: effectiveInvoiceStatus(r.invoices, todayUtc),
          needsPaymentReminder: reminderIds.has(r.invoices.id),
          ...deriveInvoiceAllocation(r.invoices.totalAmount, r.invoices.amountPaid),
        },
      }));
      if (!input?.status) return withEffective;
      // "未付/unpaid" = issued and still owing (sent + partial + overdue).
      if (input.status === "unpaid") {
        return withEffective.filter((r) =>
          ["sent", "partial", "overdue"].includes(r.invoices.status)
          && parseFloat(String(r.invoices.balanceDue ?? "0")) > 0.005,
        );
      }
      return withEffective.filter((r) => r.invoices.status === input.status);
    }),

  getById: protectedProcedure.use(moduleGuard('invoices', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [invoice] = await db
        .select({
          invoices: schema.invoices,
          customers: schema.customers,
          rental: {
            rentalNumber: schema.rentalRequests.rentalNumber,
          },
        })
        .from(schema.invoices)
        .leftJoin(schema.customers, and(eq(schema.invoices.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.rentalRequests, and(eq(schema.invoices.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .where(and(eq(schema.invoices.id, input.id), isNull(schema.invoices.deletedAt)))
        .limit(1);

      if (!invoice) return null;

      // Override stored status with the derived "overdue" reminder for display,
      // and attach the 30-day payment-reminder flag (new object — don't mutate the
      // typed row with an extra field).
      const todayUtc = zonedTodayPlusDaysUtc(0);
      const reminderIds = await paymentReminderInvoiceIds();
      const invoicesOut = {
        ...invoice.invoices,
        status: effectiveInvoiceStatus(invoice.invoices, todayUtc),
        needsPaymentReminder: reminderIds.has(invoice.invoices.id),
        ...deriveInvoiceAllocation(invoice.invoices.totalAmount, invoice.invoices.amountPaid),
      };

      // Fetch line items
      const lineItems = await db
        .select()
        .from(schema.invoiceLineItems)
        .where(eq(schema.invoiceLineItems.invoiceId, input.id))
        .orderBy(schema.invoiceLineItems.sortOrder);

      // Payment history. Rental-linked invoices are paid via the order's
      // prepayment ledger (single source of truth) — surface those mapped into
      // the same shape the detail view renders. Standalone invoices use the
      // invoice-level `payments` table.
      let paymentsList;
      if (invoice.invoices.rentalId) {
        const preps = await db
          .select()
          .from(schema.rentalPrepayments)
          .where(and(
            eq(schema.rentalPrepayments.rentalRequestId, invoice.invoices.rentalId),
            isNull(schema.rentalPrepayments.deletedAt),
          ))
          .orderBy(desc(schema.rentalPrepayments.paymentDate));
        paymentsList = preps.map((p) => ({
          payments: {
            id: p.id,
            amount: p.amount,
            paymentMethod: p.paymentMethod ?? "other",
            reference: null as string | null,
            paymentDate: p.paymentDate,
          },
          users: null,
        }));
      } else {
        paymentsList = await db
          .select()
          .from(schema.payments)
          .leftJoin(schema.users, and(eq(schema.payments.recordedBy, schema.users.id), isNull(schema.users.deletedAt)))
          .where(eq(schema.payments.invoiceId, input.id))
          .orderBy(desc(schema.payments.paymentDate));
      }

      return { ...invoice, invoices: invoicesOut, lineItems, payments: paymentsList };
    }),

  generateFromRental: protectedProcedure.use(moduleGuard('invoices', 'create'))
    .input(z.object({
      rentalId: z.number(),
      dueInDays: z.number().min(1).max(365).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const result = await generateInvoiceFromRental({
        rentalId: input.rentalId,
        createdBy: ctx.user?.id,
        dueInDays: input.dueInDays,
      });

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "invoice",
        entityId: result.invoiceId,
        metadata: { rentalId: input.rentalId, invoiceNumber: result.invoiceNumber, source: "from_rental" },
        ipAddress: ctx.req?.ip,
      });

      // Auto-generate PDF and auto-send email if settings enabled
      try {
        const { generateInvoicePDF } = await import("../services/invoicePDF");
        await generateInvoicePDF(result.invoiceId);

        const { sendInvoiceEmail } = await import("../services/notifications");
        await sendInvoiceEmail(result.invoiceId);
      } catch (err) {
        logger.error("[Invoices] Auto PDF/email failed after generateFromRental", {
          invoiceId: result.invoiceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return result;
    }),

  generatePDF: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({ invoiceId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const { generateInvoicePDF } = await import("../services/invoicePDF");
      const { url } = await generateInvoicePDF(input.invoiceId);

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "invoice",
        entityId: input.invoiceId,
        metadata: { action: "generate_pdf", pdfUrl: url },
        ipAddress: ctx.req?.ip,
      });

      return { url };
    }),

  sendEmail: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({ invoiceId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const { sendInvoiceEmail } = await import("../services/notifications");
      await sendInvoiceEmail(input.invoiceId);

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "invoice",
        entityId: input.invoiceId,
        metadata: { action: "send_email" },
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  createManual: protectedProcedure.use(moduleGuard('invoices', 'create'))
    .input(z.object({
      customerId: z.number(),
      rentalId: z.number().optional(),
      projectId: z.number().optional(),
      type: z.enum(["rental", "fuel_surcharge", "damage", "delivery", "credit_note", "manual"]).optional(),
      dueInDays: z.number().min(1).max(365).optional(),
      notes: z.string().max(2000).optional(),
      lineItems: z.array(z.object({
        description: z.string().min(1).max(500),
        quantity: z.number().min(0.01).max(99999),
        unitPrice: z.number(),
        lineType: z.string().max(50).optional(),
      })).min(1),
      taxProvince: z.string().max(2).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Calculate subtotal from line items
      const subtotal = input.lineItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

      // Calculate tax if province provided
      let taxAmount = 0;
      let taxBreakdown = "";
      if (input.taxProvince) {
        try {
          const { calculateTax } = await import("../services/taxCalculation");
          const taxResult = await calculateTax({
            rentalAmount: subtotal,
            shippingAmount: 0,
            ldwAmount: 0,
            depositAmount: 0,
            province: input.taxProvince,
          });
          taxAmount = taxResult.totalTax;
          taxBreakdown = taxResult.taxBreakdown;
        } catch (err) {
          logger.warn("[Invoices] Tax calculation failed, using 0", { error: err });
        }
      }

      const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

      // Get GST/HST number
      let gstHstNumber: string | undefined;
      try {
        const [setting] = await db
          .select()
          .from(schema.siteSettings)
          .where(eq(schema.siteSettings.key, "gstHstNumber"))
          .limit(1);
        gstHstNumber = setting?.value || undefined;
      } catch { /* ignore */ }

      // Generate invoice number
      const year = calendarPartsInTimeZone(new Date()).year;
      const prefix = `INV-${year}-`;
      const [last] = await db
        .select({ invoiceNumber: schema.invoices.invoiceNumber })
        .from(schema.invoices)
        .where(sql`${schema.invoices.invoiceNumber} LIKE ${prefix + '%'}`)
        .orderBy(desc(schema.invoices.invoiceNumber))
        .limit(1);
      let seq = 1;
      if (last?.invoiceNumber) {
        const parts = last.invoiceNumber.split("-");
        const lastSeq = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(lastSeq)) seq = lastSeq + 1;
      }
      const invoiceNumber = `${prefix}${String(seq).padStart(4, "0")}`;

      const dueDate = zonedTodayPlusDaysUtc(input.dueInDays ?? 30);

      const [invoice] = await db.insert(schema.invoices).values({
        invoiceNumber,
        customerId: input.customerId,
        rentalId: input.rentalId,
        projectId: input.projectId,
        type: input.type || "manual",
        status: "draft",
        subtotal: subtotal.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        taxBreakdown: taxBreakdown || null,
        totalAmount: totalAmount.toFixed(2),
        amountPaid: "0",
        balanceDue: totalAmount.toFixed(2),
        gstHstNumber,
        taxProvince: input.taxProvince,
        issueDate: new Date(),
        dueDate,
        notes: input.notes,
        createdBy: ctx.user?.id,
      }).returning();

      // Insert line items
      const itemsToInsert = input.lineItems.map((item, idx) => ({
        invoiceId: invoice.id,
        description: item.description,
        quantity: item.quantity.toFixed(2),
        unitPrice: item.unitPrice.toFixed(2),
        amount: (item.quantity * item.unitPrice).toFixed(2),
        lineType: item.lineType || "manual",
        sortOrder: idx + 1,
      }));
      await db.insert(schema.invoiceLineItems).values(itemsToInsert);

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "invoice",
        entityId: invoice.id,
        metadata: { invoiceNumber, type: input.type || "manual", source: "manual" },
        ipAddress: ctx.req?.ip,
      });

      return { invoiceId: invoice.id, invoiceNumber };
    }),

  updateStatus: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({
      id: z.number(),
      status: z.enum(["draft", "sent", "paid", "partial", "overdue", "cancelled", "credited"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, input.id), isNull(schema.invoices.deletedAt)))
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });

      const oldStatus = existing.status;

      // Block regressive edits away from a settled invoice. Without this a 'paid'
      // invoice could be flipped to 'draft' and then deleted (the delete guard
      // only blocks status==='paid'), orphaning payment records. paid may still
      // be refunded (credited) or written off (cancelled); cancelled/credited
      // are terminal.
      const ALLOWED_FROM_SETTLED: Record<string, string[]> = {
        paid: ["credited", "cancelled"],
        credited: [],
        cancelled: [],
      };
      if (oldStatus in ALLOWED_FROM_SETTLED && input.status !== oldStatus
          && !ALLOWED_FROM_SETTLED[oldStatus].includes(input.status)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot change a ${oldStatus} invoice to ${input.status}` });
      }

      const updateData: Record<string, unknown> = {
        status: input.status,
        updatedAt: new Date(),
      };

      if (input.status === "sent" && !existing.issueDate) {
        updateData.issueDate = new Date();
      }

      const [result] = await db
        .update(schema.invoices)
        .set(updateData)
        .where(eq(schema.invoices.id, input.id))
        .returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "status_change",
        entityType: "invoice",
        entityId: input.id,
        changes: { status: { old: oldStatus, new: input.status } },
        metadata: { invoiceNumber: existing.invoiceNumber },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  recordPayment: protectedProcedure.use(moduleGuard('invoices', 'create'))
    .input(z.object({
      invoiceId: z.number(),
      amount: z.number().positive(),
      paymentMethod: paymentMethodSchema,
      paymentDate: z.string(),
      reference: z.string().max(255).optional(),
      notes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Verify invoice exists
      const [invoice] = await db
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, input.invoiceId), isNull(schema.invoices.deletedAt)))
        .limit(1);

      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });

      // Single payment ledger: a rental-linked invoice's payment is recorded
      // against the ORDER's prepayment ledger (what 订单管理 reads and what the
      // office uses), so it shows in BOTH views and the invoice status syncs.
      // Standalone invoices (no order) keep the invoice-level `payments` table.
      //
      // This `if` is the ONLY thing that decides which of the two tables a
      // payment lands in, and in production it has always taken the first
      // branch — every invoice so far has a rentalId, which is why `payments`
      // is empty. Empty, not dead: the else-branch is the only way to take
      // money for an invoice that is not a rental. See the warning on the
      // `payments` table in drizzle/schema.ts before reporting off either one.
      let payment;
      if (invoice.rentalId) {
        [payment] = await db.insert(schema.rentalPrepayments).values({
          rentalRequestId: invoice.rentalId,
          // Tag the payment to THIS invoice so a multi-invoice order (credit
          // monthly billing / renewal supplements) allocates it correctly and
          // doesn't mark the order's other invoices paid.
          invoiceId: input.invoiceId,
          amount: input.amount.toFixed(2),
          // rental_prepayments.paymentMethod is varchar(40) and stores the
          // canonical value directly (shared/paymentMethod) — no legacy mapping.
          paymentMethod: input.paymentMethod,
          paymentDate: parseCalendarDate(input.paymentDate),
          notes: input.notes ?? input.reference,
          // A payment recorded directly against an invoice is an immediate
          // settlement — applied to rent at once (no 待转 step). The held/convert
          // gate only applies to prepayments added in the rental dialog.
          appliedAt: new Date(),
          appliedBy: ctx.user?.id,
          createdBy: ctx.user?.id,
        }).returning();
        await recalculateInvoicesForRental(invoice.rentalId);
      } else {
        [payment] = await db.insert(schema.payments).values({
          invoiceId: input.invoiceId,
          amount: input.amount.toFixed(2),
          paymentMethod: input.paymentMethod,
          // Toronto-anchored calendar date (new Date('YYYY-MM-DD') would store UTC
          // midnight and show the previous day in the Toronto-anchored UI).
          paymentDate: parseCalendarDate(input.paymentDate),
          reference: input.reference,
          notes: input.notes,
          recordedBy: ctx.user?.id,
        }).returning();
        await recalculateInvoicePayments(input.invoiceId);
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "payment",
        entityId: payment.id,
        metadata: {
          invoiceId: input.invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          amount: input.amount,
          method: input.paymentMethod,
        },
        ipAddress: ctx.req?.ip,
      });

      return payment;
    }),

  getPayments: protectedProcedure.use(moduleGuard('invoices', 'read'))
    .input(z.object({ invoiceId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select()
        .from(schema.payments)
        .leftJoin(schema.users, and(eq(schema.payments.recordedBy, schema.users.id), isNull(schema.users.deletedAt)))
        .where(eq(schema.payments.invoiceId, input.invoiceId))
        .orderBy(desc(schema.payments.paymentDate));
    }),

  update: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({
      id: z.number(),
      notes: z.string().max(2000).optional(),
      internalNotes: z.string().max(2000).optional(),
      dueDate: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (input.notes !== undefined) updateData.notes = input.notes;
      if (input.internalNotes !== undefined) updateData.internalNotes = input.internalNotes;
      if (input.dueDate) updateData.dueDate = parseCalendarDate(input.dueDate);

      const [result] = await db
        .update(schema.invoices)
        .set(updateData)
        .where(and(eq(schema.invoices.id, input.id), isNull(schema.invoices.deletedAt)))
        .returning();

      if (!result) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "invoice",
        entityId: input.id,
        metadata: { invoiceNumber: result.invoiceNumber },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  delete: protectedProcedure.use(moduleGuard('invoices', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [invoice] = await db
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, input.id), isNull(schema.invoices.deletedAt)))
        .limit(1);

      if (!invoice) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });

      // Block deletion of any invoice that carries money — not just status==='paid'.
      // (A partially-paid invoice, or one whose status was manipulated, must not be
      // deletable while payment records exist.)
      if (invoice.status === "paid" || parseFloat(invoice.amountPaid ?? "0") > 0) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Cannot delete an invoice with recorded payments" });
      }

      await db
        .update(schema.invoices)
        .set({ deletedAt: new Date() })
        .where(eq(schema.invoices.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "invoice",
        entityId: input.id,
        metadata: { invoiceNumber: invoice.invoiceNumber },
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  deleteMany: protectedProcedure.use(moduleGuard('invoices', 'delete'))
    .input(z.object({ ids: z.array(z.number()).min(1).max(100) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Block deletion of any invoice that carries money — same rule as the
      // single delete: status==='paid' OR amountPaid > 0. A partially-paid
      // invoice (status not yet 'paid') must not be silently bulk-deletable.
      const candidates = await db
        .select({ id: schema.invoices.id, status: schema.invoices.status, amountPaid: schema.invoices.amountPaid })
        .from(schema.invoices)
        .where(and(
          inArray(schema.invoices.id, input.ids),
          isNull(schema.invoices.deletedAt),
        ));

      const blocked = candidates.filter(
        (inv) => inv.status === "paid" || parseFloat(inv.amountPaid ?? "0") > 0,
      );
      if (blocked.length > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot delete ${blocked.length} invoice(s) with recorded payments`,
        });
      }

      await db
        .update(schema.invoices)
        .set({ deletedAt: new Date() })
        .where(and(
          inArray(schema.invoices.id, input.ids),
          isNull(schema.invoices.deletedAt),
        ));

      await logAudit({
        userId: ctx.user?.id,
        action: "bulk_delete",
        entityType: "invoice",
        entityId: 0,
        metadata: { ids: input.ids, count: input.ids.length },
        ipAddress: ctx.req?.ip,
      });

      return { success: true, deleted: input.ids.length };
    }),

  /**
   * Waive an extra charge that is already on an issued invoice.
   *
   * The issued invoice is never mutated (accounting rule); the waiver issues an
   * offsetting credit note. Core logic lives in services/chargeWaiver so the
   * charge module and this router share one implementation.
   */
  waiveCharge: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({
      claimId: z.number(),
      reason: z.enum(EDIT_REASONS),
      reasonNote: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return waiveInvoicedCharge({
        claimId: input.claimId,
        reason: input.reason,
        reasonNote: input.reasonNote,
        userId: ctx.user?.id,
        ipAddress: ctx.req?.ip,
      });
    }),

  batchSend: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({
      ids: z.array(z.number()).min(1).max(100),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const successIds: number[] = [];
      const failedIds: { id: number; reason: string }[] = [];

      // Fetch all requested invoices in one query (respects soft-delete)
      const invoices = await db
        .select()
        .from(schema.invoices)
        .where(and(
          inArray(schema.invoices.id, input.ids),
          isNull(schema.invoices.deletedAt),
        ));

      const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));

      for (const id of input.ids) {
        const invoice = invoiceMap.get(id);
        if (!invoice) {
          failedIds.push({ id, reason: "Invoice not found" });
          continue;
        }

        if (invoice.status !== "draft") {
          failedIds.push({ id, reason: `Invoice is not in draft status (current: ${invoice.status})` });
          continue;
        }

        try {
          // Update status to sent
          await db
            .update(schema.invoices)
            .set({ status: "sent", issueDate: invoice.issueDate ?? new Date(), updatedAt: new Date() })
            .where(eq(schema.invoices.id, id));

          // Send email (best-effort)
          try {
            const { sendInvoiceEmail } = await import("../services/notifications");
            await sendInvoiceEmail(id);
          } catch (emailErr) {
            logger.warn("[invoices.batchSend] Email send failed", {
              id,
              error: emailErr instanceof Error ? emailErr.message : String(emailErr),
            });
          }

          successIds.push(id);

          await logAudit({
            userId: ctx.user?.id,
            action: "status_change",
            entityType: "invoice",
            entityId: id,
            changes: { status: { old: "draft", new: "sent" } },
            metadata: { invoiceNumber: invoice.invoiceNumber, source: "batch" },
            ipAddress: ctx.req?.ip,
          }).catch((err) => {
            logger.warn("[invoices.batchSend] Audit log failed", { id, error: err });
          });

        } catch (err) {
          const reason = err instanceof Error ? err.message : "Unknown error";
          failedIds.push({ id, reason });
          logger.error("[invoices.batchSend] Failed for id", { id, reason });
        }
      }

      return { successIds, failedIds };
    }),

  // Summary stats for dashboard
  summary: protectedProcedure.use(moduleGuard('invoices', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return { totalOutstanding: 0, totalOverdue: 0, draftCount: 0, overdueCount: 0, reminderCount: 0 };

    // "overdue" is derived (payment-open + balance owing + past due date), not a
    // stored status — mirror invoiceIsOverdue() in SQL so the dashboard counters
    // match the list view.
    const isOverdueSql = overdueInvoiceWhereSql(zonedTodayPlusDaysUtc(0));
    const [stats] = await db
      .select({
        totalOutstanding: sql<string>`coalesce(sum(CASE WHEN status IN ('sent','partial') THEN "balanceDue"::numeric ELSE 0 END), 0)`,
        totalOverdue: sql<string>`coalesce(sum(CASE WHEN ${isOverdueSql} THEN "balanceDue"::numeric ELSE 0 END), 0)`,
        draftCount: sql<number>`count(CASE WHEN status = 'draft' THEN 1 END)::int`,
        overdueCount: sql<number>`count(CASE WHEN ${isOverdueSql} THEN 1 END)::int`,
      })
      .from(schema.invoices)
      .where(isNull(schema.invoices.deletedAt));

    const reminderCount = (await paymentReminderInvoiceIds()).size;

    return {
      totalOutstanding: parseFloat(stats?.totalOutstanding || "0"),
      totalOverdue: parseFloat(stats?.totalOverdue || "0"),
      draftCount: stats?.draftCount || 0,
      overdueCount: stats?.overdueCount || 0,
      reminderCount,
    };
  }),
});
