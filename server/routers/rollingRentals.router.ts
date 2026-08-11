import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { isFeatureEnabled } from "../services/featureFlags";
import {
  changeDelayResponsibility,
  getRollingRentalSummary,
  markCustomerReady,
  previewHistoricalClassification,
  recordPhysicalPickup,
  startRollingRenewal,
} from "../services/rollingRentalOperations";
import { confirmHistoricalClassification } from "../services/rollingSettlement";
import { assertFleetRentalPairUnambiguous } from "../services/rentalFleetConflict";
import { i18nError } from "../_core/i18nError";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  return db;
}

async function requireRollingEnabled() {
  if (!await isFeatureEnabled("rolling_renewal_operations")) {
    throw i18nError({
      code: "PRECONDITION_FAILED",
      message: "Rolling renewal operations are disabled",
      i18nKey: "errors.rolling.disabled",
    });
  }
}

export const rollingRentalsRouter = router({
  summary: adminProcedure
    .input(z.object({ rentalId: z.number().int().positive() }))
    .query(async ({ input }) => getRollingRentalSummary(await requireDb(), input.rentalId)),

  start: adminProcedure
    .input(z.object({
      rentalId: z.number().int().positive(),
      confirmedAt: z.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await requireRollingEnabled();
      return startRollingRenewal(await requireDb(), {
        ...input,
        actor: { id: ctx.user.id, ip: ctx.req?.ip },
      });
    }),

  customerReady: adminProcedure
    .input(z.object({
      rentalId: z.number().int().positive(),
      customerReadyAt: z.date(),
      scheduledPickupAt: z.date().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await requireRollingEnabled();
      return markCustomerReady(await requireDb(), {
        ...input,
        actor: { id: ctx.user.id, ip: ctx.req?.ip },
      });
    }),

  setResponsibility: adminProcedure
    .input(z.object({
      rentalId: z.number().int().positive(),
      responsibility: z.enum(["company", "customer"]),
      reason: z.string().trim().min(5).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      await requireRollingEnabled();
      return changeDelayResponsibility(await requireDb(), {
        ...input,
        actor: { id: ctx.user.id, ip: ctx.req?.ip },
      });
    }),

  pickup: protectedProcedure
    .input(z.object({
      rentalId: z.number().int().positive(),
      rentalFleetId: z.number().int().positive(),
      pickedUpAt: z.date().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user || !["field_staff", "admin", "super_admin"].includes(ctx.user.role)) {
        throw i18nError({
          code: "FORBIDDEN",
          message: "Operator is not authorized to record pickup",
          i18nKey: "errors.rolling.pickupForbidden",
        });
      }
      await requireRollingEnabled();
      const db = await requireDb();
      await assertFleetRentalPairUnambiguous(db, input.rentalId, input.rentalFleetId);
      return recordPhysicalPickup(db, {
        ...input,
        actor: {
          id: ctx.user.id,
          ip: ctx.req?.ip,
          source: ctx.user.role === "field_staff" ? "pwa" : "admin_web",
        },
      });
    }),

  classificationPreview: adminProcedure
    .input(z.object({ rentalId: z.number().int().positive(), confirmedAt: z.date().optional() }))
    .query(async ({ input }) => {
      await requireRollingEnabled();
      return previewHistoricalClassification(await requireDb(), input.rentalId, input.confirmedAt ?? new Date());
    }),

  classificationConfirm: adminProcedure
    .input(z.object({
      rentalId: z.number().int().positive(),
      confirmedAt: z.date(),
      previewHash: z.string().length(64),
    }))
    .mutation(async ({ input, ctx }) => {
      await requireRollingEnabled();
      return confirmHistoricalClassification(await requireDb(), {
        ...input,
        actor: { id: ctx.user.id, ip: ctx.req?.ip },
      });
    }),
});
