import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import type { DelayResponsibility } from "../../shared/rollingRental";
import { addRollingDays, isHistoricalCutoffWithinBounds } from "../../shared/rollingRental";
import { getRentalFleetIds } from "./rentalLineItemSync";
import { recordAssetProgressEvent } from "./rentalAssetProgress";
import { logAudit } from "./auditLog";
import { recalculateRentalPricing } from "./priceRecalculation";

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AppTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];
type CommandDb = AppDb | AppTx;

type StartRentalSnapshot = {
  status: string;
  isCreditOrder: boolean;
  endDate: Date;
};

export function assertHistoricalClassificationCutoff(input: {
  originalEndDate: Date;
  cutoff: Date;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  if (input.cutoff.getTime() <= input.originalEndDate.getTime()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Historical catch-up cutoff must be after the original rental end",
    });
  }
  if (input.cutoff.getTime() > now.getTime()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Historical catch-up cutoff cannot be in the future",
    });
  }
  if (!isHistoricalCutoffWithinBounds(input.originalEndDate, input.cutoff, now)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Historical catch-up cutoff is invalid" });
  }
}

export function validateRollingStartRental(
  rental: StartRentalSnapshot,
  fleetIds: number[],
  confirmedAt: Date,
  options: { allowHistorical?: boolean } = {},
): void {
  if (!['active', 'overdue'].includes(rental.status)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Rental must be active to start rolling renewal" });
  }
  if (rental.isCreditOrder) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Credit orders already use their own open-ended workflow" });
  }
  if (fleetIds.length === 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Rental must have assigned equipment" });
  }
  if (!options.allowHistorical && (rental.status === "overdue" || rental.endDate.getTime() < confirmedAt.getTime())) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Past-due rentals require historical classification preview and confirmation",
    });
  }
}

export function buildReadyOperationValues(input: {
  rentalId: number;
  fleetIds: number[];
  customerReadyAt: Date;
  scheduledPickupAt?: Date | null;
  actorUserId: number;
}) {
  return input.fleetIds.map((rentalFleetId) => ({
    rentalRequestId: input.rentalId,
    rentalFleetId,
    returnRequestedAt: input.customerReadyAt,
    customerReadyAt: input.customerReadyAt,
    scheduledPickupAt: input.scheduledPickupAt ?? null,
    delayResponsibility: "company" as const,
    billingStopAt: input.customerReadyAt,
    readyRecordedBy: input.actorUserId,
    responsibilitySetBy: input.actorUserId,
    responsibilityReason: "Customer confirmed ready; company pickup pending",
    updatedAt: input.customerReadyAt,
  }));
}

export function buildResponsibilityUpdates(
  operations: Array<{ id: number; customerReadyAt: Date; billingStopAt: Date | null }>,
  responsibility: Exclude<DelayResponsibility, "none">,
  actorUserId: number,
  reason: string,
) {
  return operations.map((operation) => ({
    id: operation.id,
    delayResponsibility: responsibility,
    billingStopAt: responsibility === "company" ? operation.customerReadyAt : null,
    responsibilitySetBy: actorUserId,
    responsibilityReason: reason,
  }));
}

export function calculateTermPickupCutoff(
  operations: Array<{ pickedUpAt: Date | null; delayResponsibility: string }>,
): Date | null {
  if (operations.length === 0 || operations.some((operation) => !operation.pickedUpAt)) return null;
  return operations.reduce<Date | null>((latest, operation) => {
    if (!operation.pickedUpAt) return latest;
    return !latest || operation.pickedUpAt.getTime() > latest.getTime() ? operation.pickedUpAt : latest;
  }, null);
}

/**
 * `coalesce()` has no Drizzle column encoder for its second argument. Passing
 * a Date object directly reaches postgres-js under prepare:false and fails at
 * runtime, so the cutoff must be encoded before interpolation.
 */
export function rollingTermBillingStopSql(cutoff: Date) {
  return sql`coalesce(${schema.rentalRollingTerms.billingStopAt}, ${cutoff.toISOString()})`;
}

export function hashClassificationPreview(preview: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(preview)).digest("hex");
}

async function loadRentalForCommand(db: CommandDb, rentalId: number) {
  const [rental] = await db
    .select({
      id: schema.rentalRequests.id,
      rentalNumber: schema.rentalRequests.rentalNumber,
      status: schema.rentalRequests.status,
      isCreditOrder: schema.rentalRequests.isCreditOrder,
      startDate: schema.rentalRequests.startDate,
      endDate: schema.rentalRequests.endDate,
      lifecycleVersion: schema.rentalRequests.lifecycleVersion,
    })
    .from(schema.rentalRequests)
    .where(and(eq(schema.rentalRequests.id, rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);
  if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
  return rental;
}

export async function startRollingRenewal(
  db: AppDb,
  input: {
    rentalId: number;
    confirmedAt?: Date;
    actor: { id: number; ip?: string };
    allowHistorical?: boolean;
  },
) {
  const confirmedAt = input.confirmedAt ?? new Date();
  const outcome = await db.transaction(async (tx) => {
    const rental = await loadRentalForCommand(tx, input.rentalId);
    const fleetIds = await getRentalFleetIds(tx, input.rentalId);
    const [existing] = await tx
      .select()
      .from(schema.rentalRollingTerms)
      .where(eq(schema.rentalRollingTerms.rentalRequestId, input.rentalId))
      .limit(1);

    if (existing) {
      if (existing.status === "ended") {
        throw new TRPCError({ code: "CONFLICT", message: "Rolling renewal has already ended" });
      }
      return { created: false, term: existing, oldStatus: rental.status, fleetIds };
    }

    validateRollingStartRental(rental, fleetIds, confirmedAt, { allowHistorical: input.allowHistorical });
    const billingStartedAt = rental.endDate;
    const [term] = await tx
      .insert(schema.rentalRollingTerms)
      .values({
        rentalRequestId: input.rentalId,
        status: "active",
        cycleDays: 28,
        confirmedAt,
        confirmedBy: input.actor.id,
        billingStartedAt,
        billedThroughDate: billingStartedAt,
        nextSettlementDate: addRollingDays(billingStartedAt),
        updatedAt: confirmedAt,
      })
      .returning();

    if (!term) throw new TRPCError({ code: "CONFLICT", message: "Rolling renewal could not be created" });

    if (rental.status === "overdue") {
      await tx
        .update(schema.rentalRequests)
        .set({
          status: "active",
          lifecycleVersion: sql`coalesce(${schema.rentalRequests.lifecycleVersion}, 0) + 1`,
          updatedAt: confirmedAt,
        })
        .where(and(
          eq(schema.rentalRequests.id, input.rentalId),
          eq(schema.rentalRequests.status, "overdue"),
          isNull(schema.rentalRequests.deletedAt),
        ));
    }

    for (const fleetId of fleetIds) {
      await recordAssetProgressEvent(tx, {
        eventKey: `rolling_started:${input.rentalId}:${fleetId}:${term.id}`,
        rentalRequestId: input.rentalId,
        rentalFleetId: fleetId,
        eventType: "rolling_started",
        fromStage: "in_rental",
        toStage: "in_rental",
        source: "admin_web",
        sourceEntityType: "rental_rolling_term",
        sourceEntityId: term.id,
        actorUserId: input.actor.id,
        metadata: { confirmedAt: confirmedAt.toISOString(), cycleDays: 28 },
        createdAt: confirmedAt,
      });
    }
    return { created: true, term, oldStatus: rental.status, fleetIds };
  });

  if (outcome.created) {
    await logAudit({
      userId: input.actor.id,
      action: "rolling_renewal_started",
      entityType: "rental",
      entityId: input.rentalId,
      changes: outcome.oldStatus === "overdue"
        ? { status: { old: "overdue", new: "active" } }
        : undefined,
      metadata: { confirmedAt: confirmedAt.toISOString(), fleetIds: outcome.fleetIds },
      ipAddress: input.actor.ip,
    });
  }
  return outcome;
}

export async function markCustomerReady(
  db: AppDb,
  input: {
    rentalId: number;
    customerReadyAt: Date;
    scheduledPickupAt?: Date | null;
    actor: { id: number; ip?: string };
  },
) {
  const result = await db.transaction(async (tx) => {
    const [term] = await tx
      .select()
      .from(schema.rentalRollingTerms)
      .where(eq(schema.rentalRollingTerms.rentalRequestId, input.rentalId))
      .limit(1);
    if (!term || term.status === "ended") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Active rolling renewal not found" });
    }
    const fleetIds = await getRentalFleetIds(tx, input.rentalId);
    if (fleetIds.length === 0) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Rental must have assigned equipment" });
    }
    const operations = buildReadyOperationValues({
      rentalId: input.rentalId,
      fleetIds,
      customerReadyAt: input.customerReadyAt,
      scheduledPickupAt: input.scheduledPickupAt,
      actorUserId: input.actor.id,
    });
    for (const operation of operations) {
      await tx
        .insert(schema.rentalAssetReturnOperations)
        .values(operation)
        .onConflictDoUpdate({
          target: [
            schema.rentalAssetReturnOperations.rentalRequestId,
            schema.rentalAssetReturnOperations.rentalFleetId,
          ],
          set: {
            returnRequestedAt: operation.returnRequestedAt,
            customerReadyAt: operation.customerReadyAt,
            scheduledPickupAt: operation.scheduledPickupAt,
            delayResponsibility: "company",
            billingStopAt: operation.billingStopAt,
            readyRecordedBy: input.actor.id,
            responsibilitySetBy: input.actor.id,
            responsibilityReason: operation.responsibilityReason,
            updatedAt: input.customerReadyAt,
          },
        });
      await recordAssetProgressEvent(tx, {
        eventKey: `customer_ready:${input.rentalId}:${operation.rentalFleetId}:${input.customerReadyAt.toISOString()}`,
        rentalRequestId: input.rentalId,
        rentalFleetId: operation.rentalFleetId,
        eventType: "customer_ready",
        fromStage: "in_rental",
        toStage: "return_pending",
        source: "admin_web",
        actorUserId: input.actor.id,
        metadata: {
          responsibility: "company",
          scheduledPickupAt: input.scheduledPickupAt?.toISOString() ?? null,
        },
        createdAt: input.customerReadyAt,
      });
    }
    await tx
      .update(schema.rentalRollingTerms)
      .set({ status: "ending", billingStopAt: input.customerReadyAt, updatedAt: new Date() })
      .where(eq(schema.rentalRollingTerms.id, term.id));
    return { operations: operations.length, fleetIds };
  });

  await logAudit({
    userId: input.actor.id,
    action: "customer_ready_for_return",
    entityType: "rental",
    entityId: input.rentalId,
    metadata: {
      customerReadyAt: input.customerReadyAt.toISOString(),
      scheduledPickupAt: input.scheduledPickupAt?.toISOString() ?? null,
      fleetIds: result.fleetIds,
    },
    ipAddress: input.actor.ip,
  });
  return result;
}

export async function changeDelayResponsibility(
  db: AppDb,
  input: {
    rentalId: number;
    responsibility: Exclude<DelayResponsibility, "none">;
    reason: string;
    actor: { id: number; ip?: string };
  },
) {
  const result = await db.transaction(async (tx) => {
    const operations = await tx
      .select({
        id: schema.rentalAssetReturnOperations.id,
        rentalFleetId: schema.rentalAssetReturnOperations.rentalFleetId,
        customerReadyAt: schema.rentalAssetReturnOperations.customerReadyAt,
        billingStopAt: schema.rentalAssetReturnOperations.billingStopAt,
        delayResponsibility: schema.rentalAssetReturnOperations.delayResponsibility,
      })
      .from(schema.rentalAssetReturnOperations)
      .where(eq(schema.rentalAssetReturnOperations.rentalRequestId, input.rentalId));
    if (operations.length === 0) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Customer-ready return operation not found" });
    }
    const updates = buildResponsibilityUpdates(operations, input.responsibility, input.actor.id, input.reason);
    for (const update of updates) {
      await tx
        .update(schema.rentalAssetReturnOperations)
        .set({
          delayResponsibility: update.delayResponsibility,
          billingStopAt: update.billingStopAt,
          responsibilitySetBy: update.responsibilitySetBy,
          responsibilityReason: update.responsibilityReason,
          updatedAt: new Date(),
        })
        .where(eq(schema.rentalAssetReturnOperations.id, update.id));
    }
    const billingStopAt = input.responsibility === "company"
      ? updates.reduce<Date | null>((earliest, update) => (
          !update.billingStopAt || (earliest && earliest.getTime() <= update.billingStopAt.getTime())
            ? earliest
            : update.billingStopAt
        ), null)
      : null;
    await tx
      .update(schema.rentalRollingTerms)
      .set({ billingStopAt, updatedAt: new Date() })
      .where(eq(schema.rentalRollingTerms.rentalRequestId, input.rentalId));

    for (const operation of operations) {
      await recordAssetProgressEvent(tx, {
        eventKey: `delay_responsibility:${input.rentalId}:${operation.rentalFleetId}:${input.responsibility}:${hashClassificationPreview({ reason: input.reason })}`,
        rentalRequestId: input.rentalId,
        rentalFleetId: operation.rentalFleetId,
        eventType: "delay_responsibility_changed",
        source: "admin_web",
        reason: input.reason,
        actorUserId: input.actor.id,
        metadata: { old: operation.delayResponsibility, new: input.responsibility },
        createdAt: new Date(),
      });
    }
    return { operations: operations.length, previous: [...new Set(operations.map((row) => row.delayResponsibility))] };
  });

  await logAudit({
    userId: input.actor.id,
    action: "return_delay_responsibility_changed",
    entityType: "rental",
    entityId: input.rentalId,
    changes: { responsibility: { old: result.previous, new: input.responsibility } },
    metadata: { reason: input.reason },
    ipAddress: input.actor.ip,
  });
  return result;
}

export async function recordPhysicalPickup(
  db: AppDb,
  input: {
    rentalId: number;
    rentalFleetId: number;
    pickedUpAt?: Date;
    actor: { id: number; ip?: string; source: "pwa" | "admin_web" };
  },
) {
  const pickedUpAt = input.pickedUpAt ?? new Date();
  const outcome = await db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(schema.rentalAssetReturnOperations)
      .where(and(
        eq(schema.rentalAssetReturnOperations.rentalRequestId, input.rentalId),
        eq(schema.rentalAssetReturnOperations.rentalFleetId, input.rentalFleetId),
      ))
      .limit(1);
    if (!operation) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Customer-ready return operation not found for this equipment" });
    }
    if (operation.pickedUpAt) return { pickedUpAt: operation.pickedUpAt, idempotent: true };

    const unitBillingStopAt = operation.billingStopAt ?? pickedUpAt;
    await tx
      .update(schema.rentalAssetReturnOperations)
      .set({ pickedUpAt, pickedUpBy: input.actor.id, billingStopAt: unitBillingStopAt, updatedAt: pickedUpAt })
      .where(and(
        eq(schema.rentalAssetReturnOperations.id, operation.id),
        isNull(schema.rentalAssetReturnOperations.pickedUpAt),
      ));

    await recordAssetProgressEvent(tx, {
      eventKey: `physical_pickup:${input.rentalId}:${input.rentalFleetId}`,
      rentalRequestId: input.rentalId,
      rentalFleetId: input.rentalFleetId,
      eventType: "physical_pickup",
      fromStage: "return_pending",
      toStage: "return_pending",
      source: input.actor.source,
      actorUserId: input.actor.id,
      metadata: { billingStopAt: unitBillingStopAt.toISOString() },
      createdAt: pickedUpAt,
    });

    const allOperations = await tx
      .select({
        rentalFleetId: schema.rentalAssetReturnOperations.rentalFleetId,
        pickedUpAt: schema.rentalAssetReturnOperations.pickedUpAt,
        delayResponsibility: schema.rentalAssetReturnOperations.delayResponsibility,
      })
      .from(schema.rentalAssetReturnOperations)
      .where(eq(schema.rentalAssetReturnOperations.rentalRequestId, input.rentalId));
    const afterPickup = allOperations.map((row) => (
      row.rentalFleetId === input.rentalFleetId ? { ...row, pickedUpAt } : row
    ));
    const termCutoff = calculateTermPickupCutoff(afterPickup);
    if (termCutoff) {
      await tx
        .update(schema.rentalRollingTerms)
        .set({ billingStopAt: rollingTermBillingStopSql(termCutoff), updatedAt: pickedUpAt })
        .where(eq(schema.rentalRollingTerms.rentalRequestId, input.rentalId));
    }
    return { pickedUpAt, idempotent: false };
  });

  if (!outcome.idempotent) {
    await logAudit({
      userId: input.actor.id,
      action: "rental_equipment_picked_up",
      entityType: "rental_asset_progress",
      entityId: input.rentalId,
      metadata: { rentalFleetId: input.rentalFleetId, pickedUpAt: pickedUpAt.toISOString() },
      ipAddress: input.actor.ip,
    });
  }
  return outcome;
}

export async function getRollingRentalSummary(db: AppDb, rentalId: number) {
  const [term] = await db
    .select()
    .from(schema.rentalRollingTerms)
    .where(eq(schema.rentalRollingTerms.rentalRequestId, rentalId))
    .limit(1);
  const operations = await db
    .select()
    .from(schema.rentalAssetReturnOperations)
    .where(eq(schema.rentalAssetReturnOperations.rentalRequestId, rentalId));
  return { term: term ?? null, operations };
}

export async function previewHistoricalClassification(db: AppDb, rentalId: number, confirmedAt: Date) {
  const rental = await loadRentalForCommand(db, rentalId);
  const fleetIds = await getRentalFleetIds(db, rentalId);
  assertHistoricalClassificationCutoff({ originalEndDate: rental.endDate, cutoff: confirmedAt });
  validateRollingStartRental(rental, fleetIds, confirmedAt, { allowHistorical: true });
  if (rental.status !== "overdue" && rental.endDate.getTime() >= confirmedAt.getTime()) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Rental is not historical overdue" });
  }
  const pricing = await recalculateRentalPricing(rentalId, rental.startDate, confirmedAt);
  const snapshot = {
    rentalId,
    endDate: rental.endDate.toISOString(),
    confirmedAt: confirmedAt.toISOString(),
    rentalFee: pricing.diff.rentalFee,
    insuranceCost: pricing.diff.insuranceCost,
    taxAmount: pricing.diff.taxAmount,
    totalAmount: pricing.diff.totalAmount,
    taxBreakdown: pricing.new.taxBreakdown,
  };
  return {
    ...snapshot,
    amount: pricing.diff.totalAmount,
    previewHash: hashClassificationPreview(snapshot),
  };
}
