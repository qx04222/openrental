/**
 * Customer + admin payment endpoints. Today they call into the stub
 * payment service (server/services/payments.ts) and return live=false
 * so the UI can render a "payment not yet enabled" state. Activating
 * Stripe later only requires setting STRIPE_SECRET_KEY — these
 * endpoints don't need to change.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import {
  createCheckoutSession,
  authorizeDeposit,
  captureDeposit,
  issueRefund,
} from "../services/payments";

export const paymentsRouter = router({
  // Customer-facing — opens a Checkout Session for a rental's outstanding
  // balance. Returns checkoutUrl=null + live=false until Stripe is wired.
  startRentalCheckout: publicProcedure
    .input(z.object({ rentalRequestId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      const total = parseFloat(rental.totalAmount || "0");
      if (total <= 0) {
        return { checkoutUrl: null, sessionId: null, live: false, reason: "no balance owing" };
      }

      const session = await createCheckoutSession({
        rentalRequestId: rental.id,
        amountCad: total,
        description: `OpenRental ${rental.rentalNumber || `#${rental.id}`}`,
        customerEmail: rental.customerEmail || undefined,
        metadata: { rentalRequestId: String(rental.id) },
      });
      return session;
    }),

  // Customer-facing — opens a Checkout Session for a specific invoice.
  startInvoiceCheckout: publicProcedure
    .input(z.object({ invoiceId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [inv] = await db
        .select()
        .from(schema.invoices)
        .where(and(eq(schema.invoices.id, input.invoiceId), isNull(schema.invoices.deletedAt)))
        .limit(1);
      if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });

      const owing = parseFloat(inv.balanceDue || inv.totalAmount || "0");
      if (owing <= 0) {
        return { checkoutUrl: null, sessionId: null, live: false, reason: "no balance owing" };
      }

      const session = await createCheckoutSession({
        rentalRequestId: inv.rentalId ?? 0,
        invoiceId: inv.id,
        amountCad: owing,
        description: `OpenRental Invoice ${inv.invoiceNumber || `#${inv.id}`}`,
        metadata: { invoiceId: String(inv.id) },
      });
      return session;
    }),

  // Admin-facing — authorize a deposit hold on the customer's saved card
  // (no charge yet). Used at rental approval; captured later if damaged.
  authorizeDeposit: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({ rentalRequestId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      const dep = parseFloat(rental.depositAmount || "0");
      if (dep <= 0) return { paymentIntentId: null, live: false, reason: "no deposit configured" };

      return authorizeDeposit({
        rentalRequestId: rental.id,
        amountCad: dep,
        customerEmail: rental.customerEmail || undefined,
        description: `Deposit hold — ${rental.rentalNumber || `#${rental.id}`}`,
      });
    }),

  // Admin-facing — capture (charge) part of a deposit hold (e.g. damages).
  captureDeposit: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({ paymentIntentId: z.string(), amountCad: z.number().optional() }))
    .mutation(async ({ input }) => captureDeposit(input.paymentIntentId, input.amountCad)),

  // Admin-facing — refund an existing payment intent (full or partial).
  refundPayment: protectedProcedure.use(moduleGuard('invoices', 'update'))
    .input(z.object({
      paymentIntentId: z.string(),
      amountCad: z.number().optional(),
      reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
    }))
    .mutation(async ({ input }) => issueRefund(input)),
});
