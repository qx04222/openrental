import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { addRollingDays, isRollingSettlementDue } from "../../shared/rollingRental";
import { zonedTodayPlusDaysUtc } from "../_core/dateUtils";
import { calendarPartsInTimeZone } from "../_core/dateUtils";
import { insertWithInvoiceNumber } from "./invoiceNumber";
import { recalculateRentalPricing, type PricingSnapshot } from "./priceRecalculation";
import { recalculateInvoicesForRental } from "./invoiceGenerator";
import { getRentalFleetIds } from "./rentalLineItemSync";
import { recordAssetProgressEvent } from "./rentalAssetProgress";
import { logAudit } from "./auditLog";
import {
  assertHistoricalClassificationCutoff,
  hashClassificationPreview,
  previewHistoricalClassification,
  validateRollingStartRental,
} from "./rollingRentalOperations";

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AppTx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

export interface RollingPriceDelta {
  rentalFee: number;
  insuranceCost: number;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
}

const cents = (value: number) => Math.round(value * 100) / 100;

export function calculateRollingPriceDelta(start: PricingSnapshot, end: PricingSnapshot): RollingPriceDelta {
  const rentalFee = cents(end.rentalFee - start.rentalFee);
  const insuranceCost = cents(end.insuranceCost - start.insuranceCost);
  const subtotal = cents(rentalFee + insuranceCost);
  const taxAmount = cents(end.taxAmount - start.taxAmount);
  return {
    rentalFee,
    insuranceCost,
    subtotal,
    taxAmount,
    totalAmount: cents(subtotal + taxAmount),
  };
}

export function rollingPeriodSourceKey(rentalId: number, start: Date, end: Date): string {
  return `rolling:${rentalId}:${start.toISOString()}:${end.toISOString()}`;
}

export function finalRollingSourceKey(rentalId: number, cutoff: Date): string {
  return `rolling-final:${rentalId}:${cutoff.toISOString()}`;
}

export function historicalRollingSourceKey(rentalId: number, confirmedAt: Date): string {
  return `rolling-catchup:${rentalId}:${confirmedAt.toISOString()}`;
}

export function buildEndedRollingTermValues(endedAt: Date, endedBy?: number) {
  return {
    status: "ended" as const,
    endedAt,
    endedBy,
    endReason: "rental_completed",
    updatedAt: endedAt,
  };
}

async function priceRollingInterval(rentalId: number, originalStart: Date, start: Date, end: Date) {
  const [atStart, atEnd] = await Promise.all([
    recalculateRentalPricing(rentalId, originalStart, start),
    recalculateRentalPricing(rentalId, originalStart, end),
  ]);
  return {
    delta: calculateRollingPriceDelta(atStart.new, atEnd.new),
    taxBreakdown: atEnd.new.taxBreakdown,
  };
}

async function loadInvoiceIdentity(tx: AppTx, rentalId: number) {
  const [rental] = await tx
    .select({
      id: schema.rentalRequests.id,
      customerId: schema.rentalRequests.customerId,
      projectId: schema.rentalRequests.projectId,
      taxProvince: schema.rentalRequests.taxProvince,
      insuranceType: schema.rentalRequests.insuranceType,
      customerName: schema.rentalRequests.customerName,
    })
    .from(schema.rentalRequests)
    .where(and(eq(schema.rentalRequests.id, rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);
  if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
  const [setting] = await tx
    .select({ value: schema.siteSettings.value })
    .from(schema.siteSettings)
    .where(eq(schema.siteSettings.key, "gstHstNumber"))
    .limit(1);
  return { rental, gstHstNumber: setting?.value ?? undefined };
}

async function insertRollingInvoice(
  tx: AppTx,
  input: {
    invoiceNumber: string;
    rentalId: number;
    sourceKey: string;
    periodStart: Date;
    periodEnd: Date;
    delta: RollingPriceDelta;
    taxBreakdown: string;
    createdBy?: number;
    label: "Rolling renewal" | "Rolling renewal final" | "Rolling renewal catch-up";
  },
) {
  const [existing] = await tx
    .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
    .from(schema.invoices)
    .where(eq(schema.invoices.sourceKey, input.sourceKey))
    .limit(1);
  if (existing) return { ...existing, created: false };

  const { rental, gstHstNumber } = await loadInvoiceIdentity(tx, input.rentalId);
  const [invoice] = await tx
    .insert(schema.invoices)
    .values({
      invoiceNumber: input.invoiceNumber,
      sourceKey: input.sourceKey,
      rentalId: input.rentalId,
      customerId: rental.customerId,
      projectId: rental.projectId,
      type: "rental",
      status: "sent",
      subtotal: input.delta.subtotal.toFixed(2),
      taxAmount: input.delta.taxAmount.toFixed(2),
      taxBreakdown: input.taxBreakdown,
      totalAmount: input.delta.totalAmount.toFixed(2),
      amountPaid: "0.00",
      balanceDue: input.delta.totalAmount.toFixed(2),
      gstHstNumber,
      taxProvince: rental.taxProvince,
      issueDate: new Date(),
      dueDate: zonedTodayPlusDaysUtc(30),
      notes: `${input.label}: ${input.periodStart.toISOString().slice(0, 10)} → ${input.periodEnd.toISOString().slice(0, 10)}`,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({ target: schema.invoices.sourceKey })
    .returning({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber });

  if (!invoice) {
    const [winner] = await tx
      .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
      .from(schema.invoices)
      .where(eq(schema.invoices.sourceKey, input.sourceKey))
      .limit(1);
    if (!winner) throw new Error(`Invoice source ${input.sourceKey} conflicted but no winner was readable`);
    return { ...winner, created: false };
  }

  const lineItems = [];
  if (input.delta.rentalFee > 0) {
    lineItems.push({
      invoiceId: invoice.id,
      description: `${input.label} rental (${input.periodStart.toISOString().slice(0, 10)} → ${input.periodEnd.toISOString().slice(0, 10)})`,
      quantity: "1",
      unitPrice: input.delta.rentalFee.toFixed(2),
      amount: input.delta.rentalFee.toFixed(2),
      lineType: "rental",
      sortOrder: 1,
    });
  }
  if (input.delta.insuranceCost > 0) {
    lineItems.push({
      invoiceId: invoice.id,
      description: `${input.label} insurance`,
      quantity: "1",
      unitPrice: input.delta.insuranceCost.toFixed(2),
      amount: input.delta.insuranceCost.toFixed(2),
      lineType: "insurance",
      sortOrder: 2,
    });
  }
  if (lineItems.length > 0) await tx.insert(schema.invoiceLineItems).values(lineItems);
  return { ...invoice, created: true };
}

function invoicePrefix(now: Date): string {
  return `INV-${calendarPartsInTimeZone(now).year}-`;
}

export async function settleRollingBoundary(
  db: AppDb,
  input: { termId: number; now?: Date; createdBy?: number },
) {
  const now = input.now ?? new Date();
  const [snapshot] = await db
    .select({
      id: schema.rentalRollingTerms.id,
      rentalId: schema.rentalRollingTerms.rentalRequestId,
      status: schema.rentalRollingTerms.status,
      billingStopAt: schema.rentalRollingTerms.billingStopAt,
      billedThroughDate: schema.rentalRollingTerms.billedThroughDate,
      nextSettlementDate: schema.rentalRollingTerms.nextSettlementDate,
      originalStart: schema.rentalRequests.startDate,
    })
    .from(schema.rentalRollingTerms)
    .innerJoin(schema.rentalRequests, eq(schema.rentalRollingTerms.rentalRequestId, schema.rentalRequests.id))
    .where(eq(schema.rentalRollingTerms.id, input.termId))
    .limit(1);
  if (!snapshot) throw new TRPCError({ code: "NOT_FOUND", message: "Rolling term not found" });
  if (!isRollingSettlementDue({
    status: snapshot.status as "active" | "ending" | "ended",
    billingStopAt: snapshot.billingStopAt,
    nextSettlementDate: snapshot.nextSettlementDate,
  }, now)) return { settled: false, invoiceId: null, invoiceNumber: null };

  const periodStart = snapshot.billedThroughDate;
  const periodEnd = snapshot.nextSettlementDate;
  const sourceKey = rollingPeriodSourceKey(snapshot.rentalId, periodStart, periodEnd);
  const price = await priceRollingInterval(snapshot.rentalId, snapshot.originalStart, periodStart, periodEnd);

  const transact = async (invoiceNumber: string | null) => db.transaction(async (tx) => {
    const [term] = await tx
      .select()
      .from(schema.rentalRollingTerms)
      .where(eq(schema.rentalRollingTerms.id, input.termId))
      .limit(1)
      .for("update");
    if (!term || term.billedThroughDate.getTime() !== periodStart.getTime()
        || term.nextSettlementDate.getTime() !== periodEnd.getTime()
        || !isRollingSettlementDue({
          status: term.status as "active" | "ending" | "ended",
          billingStopAt: term.billingStopAt,
          nextSettlementDate: term.nextSettlementDate,
        }, now)) {
      const [existing] = await tx
        .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
        .from(schema.invoices)
        .where(eq(schema.invoices.sourceKey, sourceKey))
        .limit(1);
      return { settled: false, invoiceId: existing?.id ?? null, invoiceNumber: existing?.invoiceNumber ?? null };
    }

    let invoice: { id: number; invoiceNumber: string; created: boolean } | null = null;
    if (price.delta.totalAmount > 0 && invoiceNumber) {
      invoice = await insertRollingInvoice(tx, {
        invoiceNumber,
        rentalId: snapshot.rentalId,
        sourceKey,
        periodStart,
        periodEnd,
        delta: price.delta,
        taxBreakdown: price.taxBreakdown,
        createdBy: input.createdBy,
        label: "Rolling renewal",
      });
    }
    await tx
      .update(schema.rentalRollingTerms)
      .set({
        billedThroughDate: periodEnd,
        nextSettlementDate: addRollingDays(periodEnd),
        updatedAt: now,
      })
      .where(eq(schema.rentalRollingTerms.id, term.id));
    return { settled: true, invoiceId: invoice?.id ?? null, invoiceNumber: invoice?.invoiceNumber ?? null };
  });

  const result = price.delta.totalAmount > 0
    ? await insertWithInvoiceNumber(db, invoicePrefix(now), (number) => transact(number))
    : await transact(null);
  if (result.invoiceId) await recalculateInvoicesForRental(snapshot.rentalId);
  return result;
}

export async function settleFinalPartialPeriod(
  db: AppDb,
  input: { termId: number; createdBy?: number; now?: Date },
) {
  const now = input.now ?? new Date();
  const [snapshot] = await db
    .select({
      id: schema.rentalRollingTerms.id,
      rentalId: schema.rentalRollingTerms.rentalRequestId,
      billedThroughDate: schema.rentalRollingTerms.billedThroughDate,
      billingStopAt: schema.rentalRollingTerms.billingStopAt,
      originalStart: schema.rentalRequests.startDate,
    })
    .from(schema.rentalRollingTerms)
    .innerJoin(schema.rentalRequests, eq(schema.rentalRollingTerms.rentalRequestId, schema.rentalRequests.id))
    .where(eq(schema.rentalRollingTerms.id, input.termId))
    .limit(1);
  if (!snapshot) throw new TRPCError({ code: "NOT_FOUND", message: "Rolling term not found" });
  const cutoff = snapshot.billingStopAt;
  if (!cutoff || cutoff.getTime() <= snapshot.billedThroughDate.getTime()) {
    return { settled: false, invoiceId: null, invoiceNumber: null };
  }

  const price = await priceRollingInterval(
    snapshot.rentalId,
    snapshot.originalStart,
    snapshot.billedThroughDate,
    cutoff,
  );
  const sourceKey = finalRollingSourceKey(snapshot.rentalId, cutoff);
  const transact = async (invoiceNumber: string | null) => db.transaction(async (tx) => {
    const [term] = await tx
      .select()
      .from(schema.rentalRollingTerms)
      .where(eq(schema.rentalRollingTerms.id, input.termId))
      .limit(1)
      .for("update");
    if (!term || !term.billingStopAt || term.billingStopAt.getTime() !== cutoff.getTime()
        || term.billedThroughDate.getTime() >= cutoff.getTime()) {
      const [existing] = await tx.select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
        .from(schema.invoices).where(eq(schema.invoices.sourceKey, sourceKey)).limit(1);
      return { settled: false, invoiceId: existing?.id ?? null, invoiceNumber: existing?.invoiceNumber ?? null };
    }
    let invoice: { id: number; invoiceNumber: string; created: boolean } | null = null;
    if (price.delta.totalAmount > 0 && invoiceNumber) {
      invoice = await insertRollingInvoice(tx, {
        invoiceNumber,
        rentalId: snapshot.rentalId,
        sourceKey,
        periodStart: snapshot.billedThroughDate,
        periodEnd: cutoff,
        delta: price.delta,
        taxBreakdown: price.taxBreakdown,
        createdBy: input.createdBy,
        label: "Rolling renewal final",
      });
    }
    await tx.update(schema.rentalRollingTerms)
      .set({ billedThroughDate: cutoff, updatedAt: now })
      .where(eq(schema.rentalRollingTerms.id, term.id));
    return { settled: true, invoiceId: invoice?.id ?? null, invoiceNumber: invoice?.invoiceNumber ?? null };
  });
  const result = price.delta.totalAmount > 0
    ? await insertWithInvoiceNumber(db, invoicePrefix(now), (number) => transact(number))
    : await transact(null);
  if (result.invoiceId) await recalculateInvoicesForRental(snapshot.rentalId);
  return result;
}

/**
 * Completion bridge for the normal rental lifecycle. The rolling balance is
 * settled before the term is marked ended; a retry can safely resume either
 * step because invoice source keys and the terminal update are idempotent.
 */
export async function finalizeRollingRentalOnCompletion(
  db: AppDb,
  input: { rentalId: number; endedAt: Date; endedBy?: number },
) {
  const [term] = await db
    .select({ id: schema.rentalRollingTerms.id })
    .from(schema.rentalRollingTerms)
    .where(and(
      eq(schema.rentalRollingTerms.rentalRequestId, input.rentalId),
      inArray(schema.rentalRollingTerms.status, ["active", "ending"]),
    ))
    .limit(1);
  if (!term) return { finalized: false, settlement: null };

  const settlement = await settleFinalPartialPeriod(db, {
    termId: term.id,
    createdBy: input.endedBy,
    now: input.endedAt,
  });
  const ended = await db
    .update(schema.rentalRollingTerms)
    .set(buildEndedRollingTermValues(input.endedAt, input.endedBy))
    .where(and(
      eq(schema.rentalRollingTerms.id, term.id),
      inArray(schema.rentalRollingTerms.status, ["active", "ending"]),
    ))
    .returning({ id: schema.rentalRollingTerms.id });
  return { finalized: ended.length > 0, settlement };
}

export async function confirmHistoricalClassification(
  db: AppDb,
  input: {
    rentalId: number;
    confirmedAt: Date;
    previewHash: string;
    actor: { id: number; ip?: string };
  },
) {
  const preview = await previewHistoricalClassification(db, input.rentalId, input.confirmedAt);
  if (preview.previewHash !== input.previewHash) {
    throw new TRPCError({ code: "CONFLICT", message: "Historical preview changed; review the amount again" });
  }
  const delta: RollingPriceDelta = {
    rentalFee: preview.rentalFee,
    insuranceCost: preview.insuranceCost,
    subtotal: cents(preview.rentalFee + preview.insuranceCost),
    taxAmount: preview.taxAmount,
    totalAmount: preview.totalAmount,
  };
  const sourceKey = historicalRollingSourceKey(input.rentalId, input.confirmedAt);
  const transact = async (invoiceNumber: string | null) => db.transaction(async (tx) => {
    const [rental] = await tx
      .select()
      .from(schema.rentalRequests)
      .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
      .limit(1)
      .for("update");
    if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
    const fleetIds = await getRentalFleetIds(tx, input.rentalId);
    assertHistoricalClassificationCutoff({
      originalEndDate: rental.endDate,
      cutoff: input.confirmedAt,
    });
    validateRollingStartRental(rental, fleetIds, input.confirmedAt, { allowHistorical: true });
    const currentSnapshot = {
      rentalId: input.rentalId,
      endDate: rental.endDate.toISOString(),
      confirmedAt: input.confirmedAt.toISOString(),
      rentalFee: preview.rentalFee,
      insuranceCost: preview.insuranceCost,
      taxAmount: preview.taxAmount,
      totalAmount: preview.totalAmount,
      taxBreakdown: preview.taxBreakdown,
    };
    if (hashClassificationPreview(currentSnapshot) !== input.previewHash) {
      throw new TRPCError({ code: "CONFLICT", message: "Historical rental changed; review the amount again" });
    }
    const [existingTerm] = await tx.select().from(schema.rentalRollingTerms)
      .where(eq(schema.rentalRollingTerms.rentalRequestId, input.rentalId)).limit(1);
    if (existingTerm) {
      const [existingInvoice] = await tx.select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
        .from(schema.invoices).where(eq(schema.invoices.sourceKey, sourceKey)).limit(1);
      return { termId: existingTerm.id, invoiceId: existingInvoice?.id ?? null, invoiceNumber: existingInvoice?.invoiceNumber ?? null, idempotent: true };
    }
    let invoice: { id: number; invoiceNumber: string; created: boolean } | null = null;
    if (delta.totalAmount > 0 && invoiceNumber) {
      invoice = await insertRollingInvoice(tx, {
        invoiceNumber,
        rentalId: input.rentalId,
        sourceKey,
        periodStart: rental.endDate,
        periodEnd: input.confirmedAt,
        delta,
        taxBreakdown: preview.taxBreakdown,
        createdBy: input.actor.id,
        label: "Rolling renewal catch-up",
      });
    }
    const [term] = await tx.insert(schema.rentalRollingTerms).values({
      rentalRequestId: input.rentalId,
      status: "active",
      cycleDays: 28,
      confirmedAt: input.confirmedAt,
      confirmedBy: input.actor.id,
      billingStartedAt: rental.endDate,
      billedThroughDate: input.confirmedAt,
      nextSettlementDate: addRollingDays(input.confirmedAt),
      updatedAt: input.confirmedAt,
    }).returning({ id: schema.rentalRollingTerms.id });
    if (!term) throw new Error("Rolling term insert did not return a row");
    if (rental.status === "overdue") {
      await tx.update(schema.rentalRequests).set({
        status: "active",
        lifecycleVersion: sql`coalesce(${schema.rentalRequests.lifecycleVersion}, 0) + 1`,
        updatedAt: input.confirmedAt,
      })
        .where(and(eq(schema.rentalRequests.id, input.rentalId), eq(schema.rentalRequests.status, "overdue")));
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
        metadata: { historical: true, previewHash: input.previewHash },
        createdAt: input.confirmedAt,
      });
    }
    return { termId: term.id, invoiceId: invoice?.id ?? null, invoiceNumber: invoice?.invoiceNumber ?? null, idempotent: false };
  });
  const result = delta.totalAmount > 0
    ? await insertWithInvoiceNumber(db, invoicePrefix(input.confirmedAt), (number) => transact(number))
    : await transact(null);
  if (result.invoiceId) await recalculateInvoicesForRental(input.rentalId);
  if (!result.idempotent) {
    await logAudit({
      userId: input.actor.id,
      action: "historical_rolling_classified",
      entityType: "rental",
      entityId: input.rentalId,
      changes: { status: { old: "overdue", new: "active" } },
      metadata: { previewHash: input.previewHash, amount: preview.amount, invoiceId: result.invoiceId },
      ipAddress: input.actor.ip,
    });
  }
  return result;
}

export const rollingSettlementDueWhere = (now: Date) => and(
  inArray(schema.rentalRollingTerms.status, ["active", "ending"]),
  isNull(schema.rentalRollingTerms.billingStopAt),
  lte(schema.rentalRollingTerms.nextSettlementDate, now),
);
