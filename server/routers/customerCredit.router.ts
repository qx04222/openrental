import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, isNull, sql, inArray } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { addCreditEntry, getCustomerCreditBalance, ACCOUNT_CREDIT_METHOD } from "../services/customerCredit";
import { recalculateInvoicesForRental } from "../services/invoiceGenerator";
import { i18nError } from "../_core/i18nError";

/**
 * Customer credit ledger — money we hold that belongs to the customer.
 *
 * Guarded on `invoices` rather than `customers`: this is financial data, and it
 * is a LIABILITY (the customer's money, not revenue), so it belongs with whoever
 * is trusted with billing rather than with whoever can edit a phone number.
 */
export const customerCreditRouter = router({
  /** Balance plus the entries behind it, newest first. */
  byCustomer: protectedProcedure.use(moduleGuard("invoices", "read"))
    .input(z.object({ customerId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { balance: 0, entries: [] };

      const entries = await db
        .select({
          id: schema.customerCreditEntries.id,
          amount: schema.customerCreditEntries.amount,
          entryType: schema.customerCreditEntries.entryType,
          notes: schema.customerCreditEntries.notes,
          createdAt: schema.customerCreditEntries.createdAt,
          updatedAt: schema.customerCreditEntries.updatedAt,
          rentalRequestId: schema.customerCreditEntries.rentalRequestId,
          rentalNumber: schema.rentalRequests.rentalNumber,
          createdByName: schema.users.name,
        })
        .from(schema.customerCreditEntries)
        .leftJoin(schema.rentalRequests, eq(schema.customerCreditEntries.rentalRequestId, schema.rentalRequests.id))
        .leftJoin(schema.users, eq(schema.customerCreditEntries.createdBy, schema.users.id))
        .where(and(
          eq(schema.customerCreditEntries.customerId, input.customerId),
          isNull(schema.customerCreditEntries.deletedAt),
        ))
        .orderBy(desc(schema.customerCreditEntries.createdAt), desc(schema.customerCreditEntries.id));

      return {
        balance: await getCustomerCreditBalance(db, input.customerId),
        entries: entries.map((e) => ({
          ...e,
          amount: parseFloat(e.amount),
        })),
      };
    }),

  /**
   * Every customer carrying a balance. This is the company's liability to its
   * customers in one number — nothing else in the system reports it.
   */
  overview: protectedProcedure.use(moduleGuard("invoices", "read"))
    .query(async () => {
      const db = await getDb();
      if (!db) return { customers: [], total: 0 };

      const rows = await db
        .select({
          customerId: schema.customerCreditEntries.customerId,
          name: schema.customers.name,
          company: schema.customers.company,
          balance: sql<string>`sum(${schema.customerCreditEntries.amount}::numeric)`,
          entryCount: sql<number>`count(*)::int`,
          lastActivity: sql<Date>`max(${schema.customerCreditEntries.updatedAt})`,
        })
        .from(schema.customerCreditEntries)
        .innerJoin(schema.customers, eq(schema.customerCreditEntries.customerId, schema.customers.id))
        .where(isNull(schema.customerCreditEntries.deletedAt))
        .groupBy(schema.customerCreditEntries.customerId, schema.customers.name, schema.customers.company)
        // A customer whose entries net to zero has no balance to show.
        .having(sql`abs(sum(${schema.customerCreditEntries.amount}::numeric)) > 0.005`)
        .orderBy(desc(sql`sum(${schema.customerCreditEntries.amount}::numeric)`));

      const customers = rows.map((r) => ({
        customerId: r.customerId,
        name: r.company || r.name || `#${r.customerId}`,
        balance: parseFloat(r.balance),
        entryCount: r.entryCount,
        lastActivity: r.lastActivity,
      }));

      return {
        customers,
        total: Math.round(customers.reduce((sum, c) => sum + c.balance, 0) * 100) / 100,
      };
    }),

  /**
   * Spend a customer's credit on one of their invoices.
   *
   * The applied amount is written to the ORDER's prepayment ledger, not to the
   * invoice: an invoice's amountPaid is recomputed from that ledger every time
   * anything changes, so a value written straight onto the invoice would be
   * erased by the next recalculation. The row carries the account_credit method
   * so collections reporting does not count the money a second time — it was
   * already counted when it came in.
   */
  applyToInvoice: protectedProcedure.use(moduleGuard("invoices", "update"))
    .input(z.object({
      invoiceId: z.number(),
      amount: z.number().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw i18nError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
        i18nKey: "errors.databaseUnavailable",
      });

      const applied = await db.transaction(async (tx) => {
        const [invoice] = await tx
          .select({
            id: schema.invoices.id,
            invoiceNumber: schema.invoices.invoiceNumber,
            rentalId: schema.invoices.rentalId,
            customerId: schema.invoices.customerId,
            balanceDue: schema.invoices.balanceDue,
            status: schema.invoices.status,
          })
          .from(schema.invoices)
          .where(and(eq(schema.invoices.id, input.invoiceId), isNull(schema.invoices.deletedAt)))
          .limit(1);

        if (!invoice) throw i18nError({
          code: "NOT_FOUND",
          message: "Invoice not found",
          i18nKey: "errors.invoiceNotFound",
        });
        if (!invoice.rentalId) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "Credit can only be applied to an invoice attached to a rental order",
          i18nKey: "errors.creditNeedsOrderInvoice",
        });
        if (!invoice.customerId) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "Invoice has no customer to draw credit from",
          i18nKey: "errors.creditNoCustomer",
        });

        // Serialize concurrent applications for this customer. The balance is a
        // SUM over the ledger, so there is no row to lock; locking the customer
        // makes two simultaneous applications queue instead of both reading the
        // same balance and together overdrawing it.
        await tx
          .select({ id: schema.customers.id })
          .from(schema.customers)
          .where(eq(schema.customers.id, invoice.customerId))
          .limit(1)
          .for("update");

        const balance = await getCustomerCreditBalance(tx, invoice.customerId);
        if (input.amount > balance + 0.005) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: `Cannot apply ${input.amount.toFixed(2)}; the customer's credit balance is ${balance.toFixed(2)}`,
          i18nKey: "errors.creditInsufficient",
          i18nParams: { balance: balance.toFixed(2) },
        });

        const balanceDue = parseFloat(invoice.balanceDue || "0");
        if (balanceDue <= 0.005) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "Invoice is already settled",
          i18nKey: "errors.invoiceAlreadySettled",
        });
        if (input.amount > balanceDue + 0.005) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: `Cannot apply ${input.amount.toFixed(2)} to an invoice with ${balanceDue.toFixed(2)} outstanding`,
          i18nKey: "errors.creditExceedsInvoice",
          i18nParams: { balanceDue: balanceDue.toFixed(2) },
        });

        await tx.insert(schema.rentalPrepayments).values({
          rentalRequestId: invoice.rentalId,
          invoiceId: invoice.id,
          amount: input.amount.toFixed(2),
          paymentMethod: ACCOUNT_CREDIT_METHOD,
          paymentDate: new Date(),
          notes: `Applied from account credit`,
          // Credit being spent settles immediately — there is no 待转 step, the
          // money was converted when it first arrived.
          appliedAt: new Date(),
          appliedBy: ctx.user?.id,
          createdBy: ctx.user?.id,
        });

        await addCreditEntry(tx, {
          customerId: invoice.customerId,
          amount: -input.amount,
          entryType: "applied_to_order",
          rentalRequestId: invoice.rentalId,
          invoiceId: invoice.id,
          notes: `Applied to ${invoice.invoiceNumber}`,
          createdBy: ctx.user?.id,
        });

        return { rentalId: invoice.rentalId, customerId: invoice.customerId, invoiceNumber: invoice.invoiceNumber };
      });

      // Outside the transaction: this rewrites every invoice on the order and is
      // the same call the app makes after any payment.
      await recalculateInvoicesForRental(applied.rentalId);

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "customer_credit",
        entityId: applied.customerId,
        metadata: {
          action: "apply_to_invoice",
          invoiceNumber: applied.invoiceNumber,
          amount: input.amount.toFixed(2),
        },
        ipAddress: ctx.req?.ip,
      });

      const db2 = await getDb();
      return { balance: db2 ? await getCustomerCreditBalance(db2, applied.customerId) : 0 };
    }),

  /**
   * Move a finished rental's held deposit onto the customer's account.
   *
   * A deposit sits held (appliedAt NULL) until someone decides what it is for.
   * Once the rental is over the choices are: convert it to rent, refund it, or
   * park it on the customer's account for next time. This is the third.
   *
   * The prepayment row is NOT marked applied — that would make it settle
   * invoices, which is the "convert to rent" decision, and on a fully-paid order
   * the money would immediately reappear as an overpayment and be counted twice.
   * It is marked transferred instead: still collected, still not allocating.
   */
  transferDeposit: protectedProcedure.use(moduleGuard("invoices", "update"))
    .input(z.object({ rentalRequestId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw i18nError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
        i18nKey: "errors.databaseUnavailable",
      });

      return db.transaction(async (tx) => {
        const [rental] = await tx
          .select({
            id: schema.rentalRequests.id,
            rentalNumber: schema.rentalRequests.rentalNumber,
            customerId: schema.rentalRequests.customerId,
            status: schema.rentalRequests.status,
          })
          .from(schema.rentalRequests)
          .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
          .limit(1);

        if (!rental) throw i18nError({
          code: "NOT_FOUND",
          message: "Rental not found",
          i18nKey: "errors.rentalNotFound",
        });
        if (!rental.customerId) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "Rental has no customer to credit",
          i18nKey: "errors.creditNoCustomer",
        });

        // Lock the rows so a second call cannot transfer the same deposit twice.
        const held = await tx
          .select({ id: schema.rentalPrepayments.id, amount: schema.rentalPrepayments.amount })
          .from(schema.rentalPrepayments)
          .where(and(
            eq(schema.rentalPrepayments.rentalRequestId, input.rentalRequestId),
            isNull(schema.rentalPrepayments.deletedAt),
            isNull(schema.rentalPrepayments.appliedAt),
            isNull(schema.rentalPrepayments.transferredToCreditAt),
          ))
          .for("update");

        const total = held.reduce((sum, h) => sum + parseFloat(h.amount), 0);
        if (total <= 0.005) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "No held deposit on this order",
          i18nKey: "errors.noHeldDeposit",
        });

        await tx
          .update(schema.rentalPrepayments)
          .set({
            transferredToCreditAt: new Date(),
            transferredToCreditBy: ctx.user?.id,
            updatedAt: new Date(),
          })
          .where(inArray(schema.rentalPrepayments.id, held.map((h) => h.id)));

        await addCreditEntry(tx, {
          customerId: rental.customerId,
          amount: total,
          entryType: "deposit_transfer",
          rentalRequestId: rental.id,
          notes: `Deposit from ${rental.rentalNumber}`,
          createdBy: ctx.user?.id,
        });

        await logAudit({
          userId: ctx.user?.id,
          action: "update",
          entityType: "customer_credit",
          entityId: rental.customerId,
          metadata: { action: "transfer_deposit", rentalNumber: rental.rentalNumber, amount: total.toFixed(2) },
          ipAddress: ctx.req?.ip,
        });

        return { transferred: total, balance: await getCustomerCreditBalance(tx, rental.customerId) };
      });
    }),

  /**
   * Absorb a credit note into the balance.
   *
   * A credit note is a negative invoice — money we owe the customer, sitting
   * outside the credit ledger. That splits their claim across two places: order
   * 20260715TM shows $795.46 of credit while CN-2026-0001 separately owes them
   * $40.68. Absorbing it settles the note and puts the whole amount in one
   * number the customer (and the office) can actually read.
   */
  absorbCreditNote: protectedProcedure.use(moduleGuard("invoices", "update"))
    .input(z.object({ invoiceId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw i18nError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
        i18nKey: "errors.databaseUnavailable",
      });

      return db.transaction(async (tx) => {
        const [note] = await tx
          .select({
            id: schema.invoices.id,
            invoiceNumber: schema.invoices.invoiceNumber,
            type: schema.invoices.type,
            status: schema.invoices.status,
            totalAmount: schema.invoices.totalAmount,
            customerId: schema.invoices.customerId,
            rentalId: schema.invoices.rentalId,
          })
          .from(schema.invoices)
          .where(and(eq(schema.invoices.id, input.invoiceId), isNull(schema.invoices.deletedAt)))
          .limit(1)
          .for("update");

        if (!note) throw i18nError({
          code: "NOT_FOUND",
          message: "Invoice not found",
          i18nKey: "errors.invoiceNotFound",
        });
        if (note.type !== "credit_note") throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "Only a credit note can be absorbed into a balance",
          i18nKey: "errors.notACreditNote",
        });
        if (note.status === "credited") throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "This credit note has already been absorbed",
          i18nKey: "errors.creditNoteAlreadyAbsorbed",
        });
        if (!note.customerId) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "Credit note has no customer",
          i18nKey: "errors.creditNoCustomer",
        });

        const owed = Math.abs(parseFloat(note.totalAmount || "0"));
        if (owed <= 0.005) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: "Credit note has no outstanding amount",
          i18nKey: "errors.creditNoteEmpty",
        });

        await tx
          .update(schema.invoices)
          .set({ status: "credited", balanceDue: "0.00", updatedAt: new Date() })
          .where(eq(schema.invoices.id, note.id));

        await addCreditEntry(tx, {
          customerId: note.customerId,
          amount: owed,
          entryType: "deposit_transfer",
          rentalRequestId: note.rentalId,
          invoiceId: note.id,
          notes: `Credit note ${note.invoiceNumber}`,
          createdBy: ctx.user?.id,
        });

        await logAudit({
          userId: ctx.user?.id,
          action: "update",
          entityType: "customer_credit",
          entityId: note.customerId,
          metadata: { action: "absorb_credit_note", invoiceNumber: note.invoiceNumber, amount: owed.toFixed(2) },
          ipAddress: ctx.req?.ip,
        });

        return { absorbed: owed, balance: await getCustomerCreditBalance(tx, note.customerId) };
      });
    }),

  /**
   * Pay credit back out to the customer.
   *
   * Restricted to admins rather than to the invoices permission: money leaving
   * the company is irreversible, and the rest of this router only ever moves it
   * between our own columns.
   */
  refund: protectedProcedure.use(moduleGuard("invoices", "update"))
    .input(z.object({
      customerId: z.number(),
      amount: z.number().positive(),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user?.role !== "admin" && ctx.user?.role !== "super_admin") {
        throw i18nError({
          code: "FORBIDDEN",
          message: "Only an administrator can refund customer credit",
          i18nKey: "errors.refundRequiresAdmin",
        });
      }

      const db = await getDb();
      if (!db) throw i18nError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
        i18nKey: "errors.databaseUnavailable",
      });

      return db.transaction(async (tx) => {
        await tx
          .select({ id: schema.customers.id })
          .from(schema.customers)
          .where(eq(schema.customers.id, input.customerId))
          .limit(1)
          .for("update");

        const balance = await getCustomerCreditBalance(tx, input.customerId);
        if (input.amount > balance + 0.005) throw i18nError({
          code: "PRECONDITION_FAILED",
          message: `Cannot refund ${input.amount.toFixed(2)}; the balance is ${balance.toFixed(2)}`,
          i18nKey: "errors.creditInsufficient",
          i18nParams: { balance: balance.toFixed(2) },
        });

        await addCreditEntry(tx, {
          customerId: input.customerId,
          amount: -input.amount,
          entryType: "refund_to_customer",
          notes: input.reason,
          createdBy: ctx.user?.id,
        });

        await logAudit({
          userId: ctx.user?.id,
          action: "create",
          entityType: "customer_credit",
          entityId: input.customerId,
          metadata: { action: "refund", amount: input.amount.toFixed(2), reason: input.reason },
          ipAddress: ctx.req?.ip,
        });

        return { balance: await getCustomerCreditBalance(tx, input.customerId) };
      });
    }),

  /**
   * Manual correction. Deliberately requires a reason: an unexplained movement
   * on a liability account is indistinguishable from an error, and this is the
   * one entry type a human types by hand.
   */
  adjust: protectedProcedure.use(moduleGuard("invoices", "update"))
    .input(z.object({
      customerId: z.number(),
      amount: z.number().refine((v) => Math.abs(v) > 0.005, "Amount cannot be zero"),
      reason: z.string().trim().min(3).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw i18nError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database not available",
        i18nKey: "errors.databaseUnavailable",
      });

      const balance = await getCustomerCreditBalance(db, input.customerId);
      if (input.amount < 0 && balance + input.amount < -0.005) {
        // Letting a balance go negative would turn a liability into a receivable
        // by accident, which is a different thing entirely and belongs on an
        // invoice.
        throw i18nError({
          code: "PRECONDITION_FAILED",
          message: `Adjustment of ${input.amount.toFixed(2)} would overdraw the balance of ${balance.toFixed(2)}`,
          i18nKey: "errors.creditWouldOverdraw",
          i18nParams: { balance: balance.toFixed(2) },
        });
      }

      await addCreditEntry(db, {
        customerId: input.customerId,
        amount: input.amount,
        entryType: "manual_adjustment",
        notes: input.reason,
        createdBy: ctx.user?.id,
      });

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "customer_credit",
        entityId: input.customerId,
        metadata: { amount: input.amount.toFixed(2), reason: input.reason },
        ipAddress: ctx.req?.ip,
      });

      return { balance: await getCustomerCreditBalance(db, input.customerId) };
    }),
});
