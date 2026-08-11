import { z } from "zod";
import { router, publicProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, isNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { CUSTOMER_COOKIE_NAME } from "../../shared/const";
import { normalizePhone, createOTP, verifyOTP as verifyOTPService, sendSMS } from "../services/otp";
import { createCustomerSession, getCustomerSession, destroyCustomerSession } from "../services/customerSession";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const customerAuthRouter = router({
  requestOTP: publicProcedure
    .input(z.object({
      phone: z.string().min(10).max(20),
    }))
    .mutation(async ({ input }) => {
      const phone = normalizePhone(input.phone);

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Look up customer by phone — don't leak whether phone exists.
      // Match on the last 10 digits rather than an exact string, because stored
      // customer phones are NOT normalized on write (the public rental form and
      // admin create both persist the raw input), while this lookup normalizes.
      // An exact `eq(phone, normalizePhone(input))` therefore misses every
      // customer whose number was saved without a leading "+1" — i.e. almost all
      // of them — locking them out of the OTP-only portal. Digit-matching mirrors
      // the existing customer-lookup pattern in customers.router.
      const last10 = phone.replace(/\D/g, "").slice(-10);
      const [customer] = await db
        .select()
        .from(schema.customers)
        .where(and(
          sql`right(regexp_replace(coalesce(${schema.customers.phone}, ''), '[^0-9]', '', 'g'), 10) = ${last10}`,
          isNull(schema.customers.deletedAt),
        ))
        .limit(1);

      // Always return success to prevent phone enumeration
      if (!customer) {
        logger.warn(`[CustomerAuth] OTP requested for unknown phone: ${phone}`);
        return { success: true, message: "If this phone is registered, you will receive a code." };
      }

      try {
        const code = await createOTP(phone);
        await sendSMS(phone, `Your OpenRental customer portal code is: ${code}. It expires in 5 minutes.`);
      } catch (err) {
        if (err instanceof Error && err.message === "TOO_MANY_OTP_REQUESTS") {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many code requests. Please wait and try again." });
        }
        logger.error("[CustomerAuth] OTP send error", { error: err instanceof Error ? err.message : String(err) });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to send verification code" });
      }

      return { success: true, message: "If this phone is registered, you will receive a code." };
    }),

  verifyOTP: publicProcedure
    .input(z.object({
      phone: z.string().min(10).max(20),
      code: z.string().length(6),
    }))
    .mutation(async ({ input, ctx }) => {
      const phone = normalizePhone(input.phone);

      const isValid = await verifyOTPService(phone, input.code);
      if (!isValid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired code" });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Match the customer on the last 10 digits (see requestOTP above) — stored
      // phones are not normalized, so an exact match would fail here AFTER the
      // code was already consumed, permanently locking out un-normalized
      // customers with a misleading "invalid code" error.
      const customerLast10 = phone.replace(/\D/g, "").slice(-10);
      const [customer] = await db
        .select()
        .from(schema.customers)
        .where(and(
          sql`right(regexp_replace(coalesce(${schema.customers.phone}, ''), '[^0-9]', '', 'g'), 10) = ${customerLast10}`,
          isNull(schema.customers.deletedAt),
        ))
        .limit(1);

      if (!customer) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired code" });
      }

      // Create customer session (30 days)
      const sessionToken = await createCustomerSession(customer.id);

      ctx.res.cookie(CUSTOMER_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: THIRTY_DAYS_MS,
      });

      logger.info(`[CustomerAuth] OTP Login: customer ${customer.id} (${customer.name})`);

      return {
        success: true,
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          company: customer.company,
        },
      };
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    const token = ctx.req.cookies[CUSTOMER_COOKIE_NAME];
    if (token) {
      await destroyCustomerSession(token);
    }

    ctx.res.clearCookie(CUSTOMER_COOKIE_NAME, { path: "/" });
    return { success: true };
  }),

  me: publicProcedure.query(async ({ ctx }) => {
    const token = ctx.req.cookies[CUSTOMER_COOKIE_NAME];
    if (!token) return null;

    const session = await getCustomerSession(token);
    if (!session) return null;

    const db = await getDb();
    if (!db) return null;

    const [customer] = await db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.id, session.customerId), isNull(schema.customers.deletedAt)))
      .limit(1);

    if (!customer) return null;

    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      company: customer.company,
    };
  }),
});
