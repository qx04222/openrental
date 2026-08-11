import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, desc, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { approveExtensionRequest } from "../services/extensionApproval";
import { settleLifecycleEffect } from "../services/rentalLifecycleEffects";

export const extensionRequestsRouter = router({
  list: protectedProcedure.use(moduleGuard('extensions', 'read'))
    .input(z.object({
      status: z.enum(["pending", "approved", "rejected"]).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const baseQuery = db
        .select({
          extension: schema.extensionRequests,
          customer: {
            id: schema.customers.id,
            name: schema.customers.name,
            email: schema.customers.email,
            phone: schema.customers.phone,
            company: schema.customers.company,
          },
          rental: {
            id: schema.rentalRequests.id,
            rentalNumber: schema.rentalRequests.rentalNumber,
            equipmentDescription: schema.rentalRequests.equipmentDescription,
            startDate: schema.rentalRequests.startDate,
            endDate: schema.rentalRequests.endDate,
            status: schema.rentalRequests.status,
          },
        })
        .from(schema.extensionRequests)
        .leftJoin(schema.customers, and(eq(schema.extensionRequests.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.rentalRequests, and(eq(schema.extensionRequests.rentalRequestId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .orderBy(desc(schema.extensionRequests.createdAt));

      if (input?.status) {
        return baseQuery.where(eq(schema.extensionRequests.status, input.status));
      }

      return baseQuery;
    }),

  // Returns approved extensions for a rental, oldest-first, so the rental
  // dialog can show the renewal history ("renewed 3 times, +21 days total").
  listByRental: protectedProcedure.use(moduleGuard('extensions', 'read'))
    .input(z.object({ rentalRequestId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(schema.extensionRequests)
        .where(and(
          eq(schema.extensionRequests.rentalRequestId, input.rentalRequestId),
          eq(schema.extensionRequests.status, "approved"),
        ))
        .orderBy(schema.extensionRequests.createdAt);
    }),

  approve: protectedProcedure.use(moduleGuard('extensions', 'update'))
    .input(z.object({
      id: z.number(),
      adminNotes: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { updated, extension, commandKey } = await approveExtensionRequest(db, {
        id: input.id,
        adminNotes: input.adminNotes,
        reviewedBy: ctx.user!.id,
      });

      // Send extension_approved notification
      let notificationError: unknown;
      let notificationSkipped = false;
      try {
        const { notifyOnEvent } = await import("../services/notifications");
        const customer = extension.customerId ? (await db
          .select()
          .from(schema.customers)
          .where(and(eq(schema.customers.id, extension.customerId), isNull(schema.customers.deletedAt)))
          .limit(1))[0] : null;
        if (customer) {
          await notifyOnEvent("extension_approved", {
            customerName: customer.name,
            email: customer.email || "",
            phone: customer.phone || "",
            rentalId: String(extension.rentalRequestId),
            requestedEndDate: extension.requestedEndDate
              ? new Date(extension.requestedEndDate).toLocaleDateString("en-CA")
              : "",
            companyName: "OpenRental",
          });
        } else {
          notificationSkipped = true;
        }
      } catch (err: unknown) {
        notificationError = err;
        logger.error("[Extensions] Notification failed", { error: err instanceof Error ? err.message : String(err) });
      }
      try {
        await settleLifecycleEffect(db, {
          commandKey,
          effectType: "notification",
          error: notificationError,
          skipped: notificationSkipped,
        });
      } catch (err) {
        logger.error("[Extensions] Notification audit settlement failed", {
          error: err instanceof Error ? err.message : String(err),
          commandKey,
        });
      }

      return updated;
    }),

  reject: protectedProcedure.use(moduleGuard('extensions', 'update'))
    .input(z.object({
      id: z.number(),
      adminNotes: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [extension] = await db
        .select()
        .from(schema.extensionRequests)
        .where(eq(schema.extensionRequests.id, input.id))
        .limit(1);

      if (!extension) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Extension request not found" });
      }

      if (extension.status !== "pending") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Extension request has already been reviewed" });
      }

      const [updated] = await db
        .update(schema.extensionRequests)
        .set({
          status: "rejected",
          adminNotes: input.adminNotes,
          reviewedBy: ctx.user!.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        // Status precondition makes reject atomic vs a concurrent approve (TOCTOU).
        .where(and(eq(schema.extensionRequests.id, input.id), eq(schema.extensionRequests.status, "pending")))
        .returning();

      if (!updated) {
        throw new TRPCError({ code: "CONFLICT", message: "Extension request was already reviewed" });
      }

      // Send extension_rejected notification
      try {
        const { notifyOnEvent } = await import("../services/notifications");
        const customer = extension.customerId ? (await db
          .select()
          .from(schema.customers)
          .where(and(eq(schema.customers.id, extension.customerId), isNull(schema.customers.deletedAt)))
          .limit(1))[0] : null;
        if (customer) {
          await notifyOnEvent("extension_rejected", {
            customerName: customer.name,
            email: customer.email || "",
            phone: customer.phone || "",
            rentalId: String(extension.rentalRequestId),
            companyName: "OpenRental",
          });
        }
      } catch (err: unknown) {
        logger.error("[Extensions] Notification failed", { error: err instanceof Error ? err.message : String(err) });
      }

      return updated;
    }),
});
