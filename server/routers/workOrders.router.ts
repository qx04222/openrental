import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, isNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { maybeReleaseFleet } from "../services/fleetRelease";
import { parseCalendarDate, parseZonedDateTime } from "../_core/dateUtils";
import { getNextWorkOrderNumber } from "../services/workOrderNumber";
import { generateWorkOrderPDF } from "../services/workOrderPDF";
import { i18nError } from "../_core/i18nError";
import { assertEditable, assertEditReason, diffFields, logEdit } from "../services/editableGuard";
import { EDIT_REASONS } from "../../shared/editReasons";

/** Reason + note, required on every in-place correction of a recorded line. */
const editEvidenceFields = {
  reason: z.enum(EDIT_REASONS),
  reasonNote: z.string().max(500).optional(),
};

/** Work-order states in which its lines are a finished record. */
const CLOSED_WORK_ORDER_STATUSES: readonly string[] = ["completed", "cancelled"];

const customerInfoFields = {
  customerName: z.string().max(255).optional(),
  customerPhone: z.string().max(50).optional(),
  equipmentSource: z.enum(["own_fleet", "equipment", "other"]).optional(),
  equipmentSourceNote: z.string().max(255).optional(),
  plateNumber: z.string().max(50).optional(),
  meterKms: z.number().int().min(0).nullable().optional(),
  meterHours: z.number().min(0).nullable().optional(),
};

/** Re-derive actualHours/laborCost/totalCost from the labor log. */
async function recalcLaborRollup(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workOrderId: number) {
  const entries = await db
    .select({ startAt: schema.workOrderLabor.startAt, endAt: schema.workOrderLabor.endAt })
    .from(schema.workOrderLabor)
    .where(eq(schema.workOrderLabor.workOrderId, workOrderId));
  // Entries still missing an end time contribute 0 until closed out
  const hours = entries.reduce((sum, e) => {
    if (!e.endAt) return sum;
    const ms = e.endAt.getTime() - e.startAt.getTime();
    return ms > 0 ? sum + ms / 3_600_000 : sum;
  }, 0);
  const [wo] = await db.select().from(schema.workOrders).where(eq(schema.workOrders.id, workOrderId)).limit(1);
  if (!wo) return;
  const laborRate = parseFloat(wo.laborRate || "0");
  const laborCost = hours * laborRate;
  const partsCost = parseFloat(wo.partsCost || "0");
  await db.update(schema.workOrders).set({
    actualHours: hours.toFixed(2),
    laborCost: laborCost.toFixed(2),
    totalCost: (laborCost + partsCost).toFixed(2),
    updatedAt: new Date(),
  }).where(eq(schema.workOrders.id, workOrderId));
}

/** Re-derive partsCost/totalCost from the parts list. */
async function recalcPartsRollup(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workOrderId: number) {
  const [totals] = await db
    .select({ partsCost: sql<string>`coalesce(sum(${schema.workOrderParts.totalCost}::numeric), 0)` })
    .from(schema.workOrderParts)
    .where(eq(schema.workOrderParts.workOrderId, workOrderId));

  const partsCost = parseFloat(totals?.partsCost || "0");
  const [wo] = await db.select().from(schema.workOrders)
    .where(and(eq(schema.workOrders.id, workOrderId), isNull(schema.workOrders.deletedAt)))
    .limit(1);
  const laborCost = parseFloat(wo?.laborCost || "0");

  await db.update(schema.workOrders).set({
    partsCost: partsCost.toFixed(2),
    totalCost: (laborCost + partsCost).toFixed(2),
    updatedAt: new Date(),
  }).where(eq(schema.workOrders.id, workOrderId));
}

/**
 * Decide whether a work order's lines (parts / labour) may still be corrected,
 * and resolve which order — if any — the correction belongs to.
 *
 * A work order is not always attached to a rental order: internal PM and
 * own-truck jobs stand alone. The only link to an order is via the damage claim
 * it was raised from (work_orders.damageClaimId → damage_claims.rentalId), and
 * the only invoice link is that same claim's invoiceId — neither work_orders nor
 * work_order_parts/work_order_labor carries an invoiceId column of its own. So
 * a standalone work order yields nulls and assertEditable applies rule 1 only.
 *
 * On top of the shared guard, a work order that is itself finished
 * (completed/cancelled) is closed to line edits: its costs have already rolled
 * up into the fleet's maintenance history.
 */
async function assertWorkOrderLineEditable(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workOrderId: number,
  subject: "workOrderPart" | "workOrderLabor",
) {
  const [wo] = await db
    .select()
    .from(schema.workOrders)
    .where(and(eq(schema.workOrders.id, workOrderId), isNull(schema.workOrders.deletedAt)))
    .limit(1);
  if (!wo) {
    throw i18nError({
      code: "NOT_FOUND",
      message: "Work order not found",
      i18nKey: "errors.workOrder.notFound",
    });
  }

  if (CLOSED_WORK_ORDER_STATUSES.includes(wo.status)) {
    throw i18nError({
      code: "PRECONDITION_FAILED",
      message: "The work order is already completed or cancelled, so its lines can no longer be edited.",
      i18nKey: "errors.workOrder.closed",
    });
  }

  let rentalRequestId: number | null = null;
  let invoiceId: number | null = null;
  if (wo.damageClaimId) {
    const [claim] = await db
      .select({ rentalId: schema.damageClaims.rentalId, invoiceId: schema.damageClaims.invoiceId })
      .from(schema.damageClaims)
      .where(eq(schema.damageClaims.id, wo.damageClaimId))
      .limit(1);
    rentalRequestId = claim?.rentalId ?? null;
    invoiceId = claim?.invoiceId ?? null;
  }

  await assertEditable({ invoiceId, rentalRequestId, subject });

  return { workOrder: wo, rentalRequestId };
}

export const workOrdersRouter = router({
  list: protectedProcedure.use(moduleGuard('work_orders', 'read'))
    .input(z.object({
      rentalFleetId: z.number().optional(),
      status: z.enum(["open", "assigned", "in_progress", "on_hold", "completed", "cancelled"]).optional(),
      assignedTo: z.number().optional(),
      limit: z.number().min(1).max(1000).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [isNull(schema.workOrders.deletedAt)];
      if (input?.rentalFleetId) conditions.push(eq(schema.workOrders.rentalFleetId, input.rentalFleetId));
      if (input?.status) conditions.push(eq(schema.workOrders.status, input.status));
      if (input?.assignedTo) conditions.push(eq(schema.workOrders.assignedTo, input.assignedTo));

      return db
        .select()
        .from(schema.workOrders)
        .leftJoin(schema.rentalFleet, and(eq(schema.workOrders.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.users, and(eq(schema.workOrders.assignedTo, schema.users.id), isNull(schema.users.deletedAt)))
        .where(and(...conditions))
        .orderBy(desc(schema.workOrders.createdAt))
        .limit(input?.limit ?? 500);
    }),

  getById: protectedProcedure.use(moduleGuard('work_orders', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [wo] = await db
        .select()
        .from(schema.workOrders)
        .leftJoin(schema.rentalFleet, and(eq(schema.workOrders.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.users, and(eq(schema.workOrders.assignedTo, schema.users.id), isNull(schema.users.deletedAt)))
        .where(and(eq(schema.workOrders.id, input.id), isNull(schema.workOrders.deletedAt)))
        .limit(1);

      if (!wo) return null;

      const parts = await db
        .select()
        .from(schema.workOrderParts)
        .where(eq(schema.workOrderParts.workOrderId, input.id))
        .orderBy(schema.workOrderParts.id);

      const labor = await db
        .select()
        .from(schema.workOrderLabor)
        .where(eq(schema.workOrderLabor.workOrderId, input.id))
        .orderBy(schema.workOrderLabor.startAt);

      return { ...wo, parts, labor };
    }),

  create: protectedProcedure.use(moduleGuard('work_orders', 'create'))
    .input(z.object({
      rentalFleetId: z.number().optional(),
      damageClaimId: z.number().optional(),
      type: z.enum(["pm1_250h", "pm2_500h", "pm3_1000h", "pm4_2000h", "repair", "inspection", "other"]).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      assignedTo: z.number().optional(),
      estimatedHours: z.number().optional(),
      laborRate: z.number().optional(),
      triggerEngineHours: z.number().optional(),
      scheduledDate: z.string().optional(),
      description: z.string().max(5000).optional(),
      notes: z.string().max(2000).optional(),
      ...customerInfoFields,
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Resolve the damaged unit when creating from a damage claim (claim →
      // inspection's fleet, else the claim's rental's fleet).
      let rentalFleetId = input.rentalFleetId;
      if (!rentalFleetId && input.damageClaimId) {
        const [claim] = await db.select({ inspectionId: schema.damageClaims.inspectionId, rentalId: schema.damageClaims.rentalId })
          .from(schema.damageClaims).where(and(eq(schema.damageClaims.id, input.damageClaimId), isNull(schema.damageClaims.deletedAt))).limit(1);
        if (claim?.inspectionId) {
          const [insp] = await db.select({ fleetId: schema.inspections.rentalFleetId }).from(schema.inspections).where(eq(schema.inspections.id, claim.inspectionId)).limit(1);
          rentalFleetId = insp?.fleetId ?? undefined;
        }
        if (!rentalFleetId && claim?.rentalId) {
          const [r] = await db.select({ fleetId: schema.rentalRequests.rentalFleetId }).from(schema.rentalRequests).where(eq(schema.rentalRequests.id, claim.rentalId)).limit(1);
          rentalFleetId = r?.fleetId ?? undefined;
        }
      }
      // Own-truck / external-customer work orders identify the unit by
      // plate/customer info instead of a fleet asset.
      const externalUnit = input.equipmentSource === "own_fleet" || input.equipmentSource === "other";
      if (!rentalFleetId && !externalUnit) throw i18nError({
        code: "BAD_REQUEST",
        message: "A fleet asset is required for the work order.",
        i18nKey: "errors.workOrder.fleetAssetRequired",
      });
      if (input.equipmentSource === "other" && !input.customerName?.trim()) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "Customer name is required for external work orders.",
          i18nKey: "errors.workOrder.customerNameRequired",
        });
      }

      const workOrderNumber = await getNextWorkOrderNumber();

      const [result] = await db.insert(schema.workOrders).values({
        workOrderNumber,
        rentalFleetId,
        damageClaimId: input.damageClaimId,
        type: input.type || "other",
        priority: input.priority || "normal",
        status: input.assignedTo ? "assigned" : "open",
        assignedTo: input.assignedTo,
        estimatedHours: input.estimatedHours?.toFixed(2),
        laborRate: input.laborRate?.toFixed(2),
        triggerEngineHours: input.triggerEngineHours,
        scheduledDate: input.scheduledDate ? parseCalendarDate(input.scheduledDate) : undefined,
        description: input.description,
        notes: input.notes,
        customerName: input.customerName?.trim() || undefined,
        customerPhone: input.customerPhone?.trim() || undefined,
        equipmentSource: input.equipmentSource,
        equipmentSourceNote: input.equipmentSourceNote?.trim() || undefined,
        plateNumber: input.plateNumber?.trim() || undefined,
        meterKms: input.meterKms,
        meterHours: input.meterHours != null ? input.meterHours.toFixed(1) : undefined,
        createdBy: ctx.user?.id,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "work_order",
        entityId: result.id,
        metadata: { workOrderNumber, type: input.type, fleetId: rentalFleetId, damageClaimId: input.damageClaimId },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  updateStatus: protectedProcedure.use(moduleGuard('work_orders', 'update'))
    .input(z.object({
      id: z.number(),
      status: z.enum(["open", "assigned", "in_progress", "on_hold", "completed", "cancelled"]),
      actualHours: z.number().optional(),
      findings: z.string().max(5000).optional(),
      resolution: z.string().max(5000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.workOrders)
        .where(and(eq(schema.workOrders.id, input.id), isNull(schema.workOrders.deletedAt)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      const updateData: Record<string, unknown> = { status: input.status, updatedAt: new Date() };
      if (input.status === "in_progress" && !existing.startedAt) updateData.startedAt = new Date();
      if (input.status === "completed") {
        updateData.completedAt = new Date();
        if (input.actualHours !== undefined) {
          updateData.actualHours = input.actualHours.toFixed(2);
          const laborRate = parseFloat(existing.laborRate || "0");
          updateData.laborCost = (input.actualHours * laborRate).toFixed(2);
          const partsCost = parseFloat(existing.partsCost || "0");
          updateData.totalCost = (input.actualHours * laborRate + partsCost).toFixed(2);
        }
      }
      if (input.findings) updateData.findings = input.findings;
      if (input.resolution) updateData.resolution = input.resolution;

      const [result] = await db
        .update(schema.workOrders)
        .set(updateData)
        .where(eq(schema.workOrders.id, input.id))
        .returning();

      // If completed, update fleet maintenance info
      if (input.status === "completed" && existing.rentalFleetId) {
        await db.update(schema.rentalFleet).set({
          lastMaintenanceDate: new Date(),
          lastServiceHours: existing.triggerEngineHours,
          maintenanceStatus: "ok",
          updatedAt: new Date(),
        }).where(eq(schema.rentalFleet.id, existing.rentalFleetId));

        // Close the maintenance loop: a repaired unit returns to the available
        // pool automatically — but only when it is actually parked in
        // maintenance, no other open work order still covers it, and no
        // active/overdue order claims it (pointer or line item). Shared with
        // the inbound workshop webhook via maybeReleaseFleet.
        await maybeReleaseFleet(db, existing.rentalFleetId, {
          excludeWorkOrderId: input.id,
          audit: {
            userId: ctx.user?.id,
            action: "auto_release_after_maintenance",
            metadata: { workOrderId: input.id, workOrderNumber: existing.workOrderNumber },
            ipAddress: ctx.req?.ip,
          },
        });
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "status_change",
        entityType: "work_order",
        entityId: input.id,
        changes: { status: { old: existing.status, new: input.status } },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  addPart: protectedProcedure.use(moduleGuard('work_orders', 'create'))
    .input(z.object({
      workOrderId: z.number(),
      partName: z.string().min(1).max(255),
      partNumber: z.string().max(100).optional(),
      quantity: z.number().min(0.01),
      unitCost: z.number().min(0),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const totalCost = Math.round(input.quantity * input.unitCost * 100) / 100;

      const [part] = await db.insert(schema.workOrderParts).values({
        workOrderId: input.workOrderId,
        partName: input.partName,
        partNumber: input.partNumber,
        quantity: input.quantity.toFixed(2),
        unitCost: input.unitCost.toFixed(2),
        totalCost: totalCost.toFixed(2),
      }).returning();

      await recalcPartsRollup(db, input.workOrderId);

      return part;
    }),

  /**
   * Correct an already-recorded part line, with the reason on record.
   * Costs are re-derived rather than trusted from the client: totalCost always
   * equals quantity × unitCost, and the work order's rollup follows.
   */
  updatePart: protectedProcedure.use(moduleGuard('work_orders', 'update'))
    .input(z.object({
      id: z.number(),
      partName: z.string().min(1).max(255).optional(),
      partNumber: z.string().max(100).nullable().optional(),
      quantity: z.number().min(0.01).optional(),
      unitCost: z.number().min(0).optional(),
      ...editEvidenceFields,
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // work_order_parts has no deletedAt column — rows are physically deleted.
      const [existing] = await db.select().from(schema.workOrderParts)
        .where(eq(schema.workOrderParts.id, input.id))
        .limit(1);
      if (!existing) throw i18nError({
        code: "NOT_FOUND",
        message: "Part line not found",
        i18nKey: "errors.workOrder.partNotFound",
      });

      // workOrderId is nullable on this table; an orphan line has no work order
      // to guard against, so it is treated as not found rather than edited blind.
      const workOrderId = existing.workOrderId;
      if (workOrderId == null) throw i18nError({
        code: "NOT_FOUND",
        message: "Work order not found",
        i18nKey: "errors.workOrder.notFound",
      });

      const evidence = assertEditReason(input.reason, input.reasonNote);
      const { rentalRequestId } = await assertWorkOrderLineEditable(db, workOrderId, "workOrderPart");

      const quantity = input.quantity ?? parseFloat(existing.quantity);
      const unitCost = input.unitCost ?? parseFloat(existing.unitCost);
      const repriced = input.quantity != null || input.unitCost != null;

      const patch: Record<string, unknown> = {
        partName: input.partName,
        partNumber: input.partNumber === null ? null : input.partNumber,
        quantity: input.quantity != null ? input.quantity.toFixed(2) : undefined,
        unitCost: input.unitCost != null ? input.unitCost.toFixed(2) : undefined,
        totalCost: repriced ? (Math.round(quantity * unitCost * 100) / 100).toFixed(2) : undefined,
      };

      const changes = diffFields(existing as unknown as Record<string, unknown>, patch);
      if (Object.keys(changes).length === 0) return { ok: true, unchanged: true };

      await db.update(schema.workOrderParts).set(patch).where(eq(schema.workOrderParts.id, input.id));
      await recalcPartsRollup(db, workOrderId);

      await logEdit({
        userId: ctx.user?.id,
        entityType: "work_order_part",
        entityId: input.id,
        rentalRequestId,
        changes,
        evidence,
        extraMetadata: { workOrderId },
        ipAddress: ctx.req?.ip,
      });

      return { ok: true };
    }),

  /**
   * Remove a part line. The table has no deletedAt column, so this is a physical
   * delete — the audit entry therefore records every column of the removed row,
   * which is what keeps the evidence chain intact.
   */
  deletePart: protectedProcedure.use(moduleGuard('work_orders', 'update'))
    .input(z.object({ id: z.number(), ...editEvidenceFields }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db.select().from(schema.workOrderParts)
        .where(eq(schema.workOrderParts.id, input.id))
        .limit(1);
      if (!existing) throw i18nError({
        code: "NOT_FOUND",
        message: "Part line not found",
        i18nKey: "errors.workOrder.partNotFound",
      });

      // workOrderId is nullable on this table; an orphan line has no work order
      // to guard against, so it is treated as not found rather than edited blind.
      const workOrderId = existing.workOrderId;
      if (workOrderId == null) throw i18nError({
        code: "NOT_FOUND",
        message: "Work order not found",
        i18nKey: "errors.workOrder.notFound",
      });

      const evidence = assertEditReason(input.reason, input.reasonNote);
      const { rentalRequestId } = await assertWorkOrderLineEditable(db, workOrderId, "workOrderPart");

      await db.delete(schema.workOrderParts).where(eq(schema.workOrderParts.id, input.id));
      await recalcPartsRollup(db, workOrderId);

      const changes: Record<string, { old: unknown; new: unknown }> = {};
      for (const [key, value] of Object.entries(existing as unknown as Record<string, unknown>)) {
        changes[key] = { old: value ?? null, new: null };
      }

      await logEdit({
        userId: ctx.user?.id,
        entityType: "work_order_part",
        entityId: input.id,
        rentalRequestId,
        changes,
        evidence,
        action: "delete",
        extraMetadata: { workOrderId },
        ipAddress: ctx.req?.ip,
      });

      return { ok: true };
    }),

  // Edit header info on an existing WO (everything except the status workflow)
  updateInfo: protectedProcedure.use(moduleGuard('work_orders', 'update'))
    .input(z.object({
      id: z.number(),
      description: z.string().max(5000).optional(),
      notes: z.string().max(2000).optional(),
      laborRate: z.number().min(0).optional(),
      type: z.enum(["pm1_250h", "pm2_500h", "pm3_1000h", "pm4_2000h", "repair", "inspection", "other"]).optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      assignedTo: z.number().nullable().optional(),
      estimatedHours: z.number().min(0).optional(),
      scheduledDate: z.string().nullable().optional(),
      rentalFleetId: z.number().nullable().optional(),
      ...customerInfoFields,
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.workOrders)
        .where(and(eq(schema.workOrders.id, input.id), isNull(schema.workOrders.deletedAt)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      const externalUnit = input.equipmentSource === "own_fleet" || input.equipmentSource === "other";
      if (input.rentalFleetId === null && !externalUnit) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "A fleet asset is required for the work order.",
          i18nKey: "errors.workOrder.fleetAssetRequired",
        });
      }
      if (input.equipmentSource === "other" && !input.customerName?.trim()) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "Customer name is required for external work orders.",
          i18nKey: "errors.workOrder.customerNameRequired",
        });
      }

      const { id: _id, laborRate, meterHours, estimatedHours, scheduledDate, ...rest } = input;
      // Empty strings from the edit form mean "clear this field"
      const cleaned = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v === "" ? null : v]));
      const [result] = await db.update(schema.workOrders).set({
        ...cleaned,
        laborRate: laborRate != null ? laborRate.toFixed(2) : undefined,
        meterHours: meterHours === null ? null : meterHours != null ? meterHours.toFixed(1) : undefined,
        estimatedHours: estimatedHours != null ? estimatedHours.toFixed(2) : undefined,
        scheduledDate: scheduledDate === null ? null : scheduledDate ? parseCalendarDate(scheduledDate) : undefined,
        updatedAt: new Date(),
      }).where(eq(schema.workOrders.id, input.id)).returning();

      // A changed rate re-prices the logged labor
      if (laborRate != null) await recalcLaborRollup(db, input.id);

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "work_order",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  addLabor: protectedProcedure.use(moduleGuard('work_orders', 'update'))
    .input(z.object({
      workOrderId: z.number(),
      technicianName: z.string().min(1).max(120),
      userId: z.number().optional(),
      workDetail: z.string().max(2000).optional(),
      startAt: z.string(),
      endAt: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const startAt = parseZonedDateTime(input.startAt);
      const endAt = input.endAt ? parseZonedDateTime(input.endAt) : undefined;
      if (endAt && endAt.getTime() <= startAt.getTime()) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "End time must be after start time.",
          i18nKey: "errors.workOrder.endAfterStart",
        });
      }

      const [entry] = await db.insert(schema.workOrderLabor).values({
        workOrderId: input.workOrderId,
        technicianName: input.technicianName.trim(),
        userId: input.userId,
        workDetail: input.workDetail?.trim() || undefined,
        startAt,
        endAt,
      }).returning();

      await recalcLaborRollup(db, input.workOrderId);
      return entry;
    }),

  /**
   * Correct a logged labour entry, with the reason on record. A changed
   * start/end re-derives the work order's hours and labour cost.
   */
  updateLabor: protectedProcedure.use(moduleGuard('work_orders', 'update'))
    .input(z.object({
      id: z.number(),
      technicianName: z.string().min(1).max(120).optional(),
      workDetail: z.string().max(2000).nullable().optional(),
      startAt: z.string().optional(),
      // null clears the end time, putting the entry back to "still open"
      endAt: z.string().nullable().optional(),
      ...editEvidenceFields,
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // work_order_labor has no deletedAt column — rows are physically deleted.
      const [existing] = await db.select().from(schema.workOrderLabor)
        .where(eq(schema.workOrderLabor.id, input.id))
        .limit(1);
      if (!existing) throw i18nError({
        code: "NOT_FOUND",
        message: "Labour entry not found",
        i18nKey: "errors.workOrder.laborNotFound",
      });

      const evidence = assertEditReason(input.reason, input.reasonNote);
      const { rentalRequestId } = await assertWorkOrderLineEditable(db, existing.workOrderId, "workOrderLabor");

      const startAt = input.startAt ? parseZonedDateTime(input.startAt) : existing.startAt;
      const endAt = input.endAt === null
        ? null
        : input.endAt ? parseZonedDateTime(input.endAt) : existing.endAt;
      if (endAt && endAt.getTime() <= startAt.getTime()) {
        throw i18nError({
          code: "BAD_REQUEST",
          message: "End time must be after start time.",
          i18nKey: "errors.workOrder.endAfterStart",
        });
      }

      const patch: Record<string, unknown> = {
        technicianName: input.technicianName?.trim(),
        workDetail: input.workDetail === null ? null : input.workDetail?.trim(),
        startAt: input.startAt ? startAt : undefined,
        endAt: input.endAt !== undefined ? endAt : undefined,
      };

      const changes = diffFields(existing as unknown as Record<string, unknown>, patch);
      if (Object.keys(changes).length === 0) return { ok: true, unchanged: true };

      await db.update(schema.workOrderLabor).set(patch).where(eq(schema.workOrderLabor.id, input.id));
      await recalcLaborRollup(db, existing.workOrderId);

      await logEdit({
        userId: ctx.user?.id,
        entityType: "work_order_labor",
        entityId: input.id,
        rentalRequestId,
        changes,
        evidence,
        extraMetadata: { workOrderId: existing.workOrderId },
        ipAddress: ctx.req?.ip,
      });

      return { ok: true };
    }),

  /**
   * Remove a labour entry. No deletedAt column here either, so the audit entry
   * carries the whole removed row as the evidence of what was there.
   */
  deleteLabor: protectedProcedure.use(moduleGuard('work_orders', 'update'))
    .input(z.object({ id: z.number(), ...editEvidenceFields }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db.select().from(schema.workOrderLabor)
        .where(eq(schema.workOrderLabor.id, input.id))
        .limit(1);
      if (!existing) throw i18nError({
        code: "NOT_FOUND",
        message: "Labour entry not found",
        i18nKey: "errors.workOrder.laborNotFound",
      });

      const evidence = assertEditReason(input.reason, input.reasonNote);
      const { rentalRequestId } = await assertWorkOrderLineEditable(db, existing.workOrderId, "workOrderLabor");

      await db.delete(schema.workOrderLabor).where(eq(schema.workOrderLabor.id, input.id));
      await recalcLaborRollup(db, existing.workOrderId);

      const changes: Record<string, { old: unknown; new: unknown }> = {};
      for (const [key, value] of Object.entries(existing as unknown as Record<string, unknown>)) {
        changes[key] = { old: value ?? null, new: null };
      }

      await logEdit({
        userId: ctx.user?.id,
        entityType: "work_order_labor",
        entityId: input.id,
        rentalRequestId,
        changes,
        evidence,
        action: "delete",
        extraMetadata: { workOrderId: existing.workOrderId },
        ipAddress: ctx.req?.ip,
      });

      return { ok: true };
    }),

  generatePdf: protectedProcedure.use(moduleGuard('work_orders', 'read'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      return generateWorkOrderPDF(input.id);
    }),

  delete: protectedProcedure.use(moduleGuard('work_orders', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.update(schema.workOrders).set({ deletedAt: new Date() }).where(eq(schema.workOrders.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "work_order",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  // Cost summary for a specific fleet unit
  fleetCostSummary: protectedProcedure.use(moduleGuard('work_orders', 'read'))
    .input(z.object({ rentalFleetId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { totalMaintenanceCost: 0, workOrderCount: 0 };

      const [stats] = await db
        .select({
          totalMaintenanceCost: sql<string>`coalesce(sum(${schema.workOrders.totalCost}::numeric), 0)`,
          workOrderCount: sql<number>`count(*)::int`,
        })
        .from(schema.workOrders)
        .where(and(
          eq(schema.workOrders.rentalFleetId, input.rentalFleetId),
          isNull(schema.workOrders.deletedAt),
        ));

      return {
        totalMaintenanceCost: parseFloat(stats?.totalMaintenanceCost || "0"),
        workOrderCount: stats?.workOrderCount || 0,
      };
    }),
});
