import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, fieldStaffProcedure, router, superAdminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import {
  listAssetProgressEvents,
  loadFieldRentalAssetProgress,
  loadRentalAssetProgress,
  recordAssetProgressEvent,
} from "../services/rentalAssetProgress";
import { getRentalOperationPolicies } from "../services/rentalOperationPolicies";
import { logAudit } from "../services/auditLog";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  return db;
}

async function requireVisibleUnit(
  db: Awaited<ReturnType<typeof requireDb>>,
  user: { id: number; role: string },
  input: { rentalId: number; rentalFleetId: number },
) {
  const policies = await getRentalOperationPolicies();
  const units = user.role === "field_staff"
    ? await loadFieldRentalAssetProgress(db, user.id, policies)
    : await loadRentalAssetProgress(db, input.rentalId, policies);
  const unit = units.find((row) => (
    row.rentalRequestId === input.rentalId && row.rentalFleetId === input.rentalFleetId
  ));
  if (!unit) {
    throw new TRPCError({
      code: user.role === "field_staff" ? "FORBIDDEN" : "BAD_REQUEST",
      message: "Equipment is not available to this operator",
    });
  }
  return unit;
}

export const rentalAssetProgressRouter = router({
  byRental: adminProcedure
    .input(z.object({ rentalId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await requireDb();
      const policies = await getRentalOperationPolicies();
      return loadRentalAssetProgress(db, input.rentalId, policies);
    }),

  fieldList: fieldStaffProcedure.query(async ({ ctx }) => {
    const db = await requireDb();
    const policies = await getRentalOperationPolicies();
    return loadFieldRentalAssetProgress(db, ctx.user.id, policies);
  }),

  timeline: fieldStaffProcedure
    .input(z.object({
      rentalId: z.number().int().positive(),
      rentalFleetId: z.number().int().positive(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await requireDb();
      await requireVisibleUnit(db, ctx.user, input);
      return listAssetProgressEvents(db, input.rentalId, input.rentalFleetId);
    }),

  startReturn: fieldStaffProcedure
    .input(z.object({
      rentalId: z.number().int().positive(),
      rentalFleetId: z.number().int().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const unit = await requireVisibleUnit(db, ctx.user, input);
      if (unit.occupancyConflict) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Fleet occupancy conflict must be resolved before field operations continue",
        });
      }
      if (!["in_rental", "return_pending", "return_ready"].includes(unit.stage)
          || !["active", "overdue"].includes(unit.rentalStatus)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Equipment is not ready to start return",
        });
      }

      await recordAssetProgressEvent(db, {
        eventKey: `return_started:${input.rentalId}:${input.rentalFleetId}`,
        rentalRequestId: input.rentalId,
        rentalFleetId: input.rentalFleetId,
        eventType: "return_started",
        fromStage: "in_rental",
        toStage: "return_pending",
        source: ctx.user.role === "field_staff" ? "pwa" : "admin_web",
        actorUserId: ctx.user.id,
        createdAt: new Date(),
      });
      return { ok: true };
    }),

  bypassInspection: superAdminProcedure
    .input(z.object({
      rentalId: z.number().int().positive(),
      rentalFleetId: z.number().int().positive(),
      inspectionType: z.enum(["dispatch", "return"]),
      reason: z.string().trim().min(5).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await requireDb();
      const policies = await getRentalOperationPolicies();
      const units = await loadRentalAssetProgress(db, input.rentalId, policies);
      const unit = units.find((row) => row.rentalFleetId === input.rentalFleetId);
      if (!unit) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Equipment is not assigned to this rental" });
      }

      const inspectionStatus = input.inspectionType === "dispatch"
        ? unit.entryInspection
        : unit.returnInspection;
      if (inspectionStatus === "completed") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Inspection is already completed" });
      }
      if (inspectionStatus === "not_required") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Inspection is not required by current policy" });
      }
      const expectedStage = input.inspectionType === "dispatch" ? "entry_pending" : "return_pending";
      if (unit.stage !== expectedStage) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Inspection bypass is not available at this stage",
        });
      }

      const eventType = `${input.inspectionType}_inspection_bypassed`;
      await recordAssetProgressEvent(db, {
        eventKey: `${eventType}:${input.rentalId}:${input.rentalFleetId}`,
        rentalRequestId: input.rentalId,
        rentalFleetId: input.rentalFleetId,
        eventType,
        fromStage: input.inspectionType === "dispatch" ? "entry_pending" : "return_pending",
        toStage: input.inspectionType === "dispatch" ? "entry_ready" : "return_ready",
        source: "admin_web",
        reason: input.reason,
        actorUserId: ctx.user.id,
        createdAt: new Date(),
      });

      await logAudit({
        userId: ctx.user.id,
        action: "inspection_bypass",
        entityType: "rental_asset_progress",
        entityId: input.rentalId,
        metadata: {
          rentalFleetId: input.rentalFleetId,
          inspectionType: input.inspectionType,
          reason: input.reason,
        },
        ipAddress: ctx.req?.ip,
      });
      return { ok: true };
    }),
});
