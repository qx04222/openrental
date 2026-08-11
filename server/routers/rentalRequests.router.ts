import { z } from "zod";
import { nanoid } from "nanoid";
import { TRPCError } from "@trpc/server";
import { i18nError } from "../_core/i18nError";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { zMoneyOptional } from "../../shared/zodMoney";
import { getDb, eq, ne, desc, and, or, gte, lte, lt, gt, isNull, ilike, sql, inArray } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { checkDateRangeAvailability } from "../services/rentalStatusSync";
import { autoAssignAsset } from "../services/assetAssignment";
import { logAudit } from "../services/auditLog";
import { recalculateRentalPricing, scaleTaxByBase } from "../services/priceRecalculation";
import { isFeatureEnabled } from "../services/featureFlags";
import { checkCredit } from "../services/creditEnforcement";
import { hashDocument, extractClientMetadata } from "../services/signatureEvidence";
import { applyReferralDiscount } from "../services/referralDiscount";
import { parseCalendarDate, calendarDateStringInTimeZone } from "../_core/dateUtils";
import { calculateDaysBetween } from "../services/pricingCalculation";
import { checkRateLimit, type RateLimitEntry } from "../../shared/rateLimiter";
import { OPEN_ENDED_END_DATE } from "../../shared/creditOrders";
import { computeOverrideFields, PRICE_OVERRIDE_FIELDS } from "../../shared/priceOverride";
import { computeCreditWarning, computeCreditExposure } from "../services/creditWarning";
import { getOrderExtraCharges } from "../services/orderCharges";
import { evaluateLifecyclePlan, getFulfillmentSnapshot, makeLifecycleCommandKey, nextLifecycleVersion } from "../services/rentalLifecycle";
import { assertLifecycleCasSucceeded, settleLifecycleEffect } from "../services/rentalLifecycleEffects";
import { getRentalOperationPolicies, shouldAutoCreateDispatch } from "../services/rentalOperationPolicies";
import { buildLifecycleProgressEvents, recordAssetProgressEvent } from "../services/rentalAssetProgress";

// Rate limiters for the unauthenticated customer self-service endpoints
// (lookup / update / cancel), keyed on client IP. The order id is sequential
// so without this an attacker could enumerate ids 1..N to brute-force the
// (id, email) credential — read PII, mutate dates, or cancel orders.
const customerLookupLimiter = new Map<string, RateLimitEntry>();
const customerMutationLimiter = new Map<string, RateLimitEntry>();
const RL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RL_LOOKUP_MAX = 20;           // generous for fat-fingered legit customers
const RL_MUTATION_MAX = 10;

/**
 * Generate rental number: YYYYMMDD + 2 random uppercase letters, e.g. "20260316AB"
 * Retries on collision (unique constraint).
 */
async function generateRentalNumber(): Promise<string> {
  // Date part is the Toronto calendar day, not the UTC container's — so a
  // rental created late evening Toronto keeps that day's number.
  const datePart = calendarDateStringInTimeZone(new Date()).replace(/-/g, "");
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const rand = () => letters[Math.floor(Math.random() * 26)];
  // The suffix keyspace is only 26^2 = 676/day, so on busy days (or in the E2E
  // suite, which creates many orders per day) two rentals can collide on the
  // unique rentalNumber and the insert 500s. Retry against the DB instead of
  // assuming uniqueness; widen to a 3-letter suffix if the 2-letter space is
  // crowded. The constraint ignores deletedAt, so check all rows.
  const db = await getDb();
  for (let attempt = 0; attempt < 25; attempt++) {
    const suffix = attempt < 18 ? `${rand()}${rand()}` : `${rand()}${rand()}${rand()}`;
    const candidate = `${datePart}${suffix}`;
    if (!db) return candidate;
    const [existing] = await db
      .select({ id: schema.rentalRequests.id })
      .from(schema.rentalRequests)
      .where(eq(schema.rentalRequests.rentalNumber, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  // Vanishingly unlikely: 25 collisions in a row. Fall back to a 4-letter tail.
  return `${datePart}${rand()}${rand()}${rand()}${rand()}`;
}

/**
 * Recalculate and update customer denormalized counters (totalRentals, totalRevenue, lastRentalDate).
 * Called after rental create / status change. Best-effort — failures are logged, not thrown.
 */
async function getContractLineItems(rentalRequestId: number) {
  const db = await getDb();
  if (!db) return [];
  const { loadContractLineItems } = await import("../services/contractLineItems");
  return loadContractLineItems(db, rentalRequestId);
}

/**
 * Regenerate the contract PDF from the rental's CURRENT data (fleet join +
 * line items) and bump contractVersion. Signatures are re-embedded as-is —
 * regeneration does not clear the signed state. Shared by the manual
 * generateContract mutation and the mid-rental swap flow.
 */
export async function regenerateContractPdf(rentalId: number): Promise<{ url: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [rental] = await db
    .select()
    .from(schema.rentalRequests)
    .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
    .where(and(eq(schema.rentalRequests.id, rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);

  if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

  const { generateContractPDF } = await import("../services/contractPDF");
  // Contract PDF "Duration" text only — DST-safe so it matches the billed term.
  const days = calculateDaysBetween(rental.rental_requests.startDate, rental.rental_requests.endDate);

  const { url } = await generateContractPDF({
    rentalId: rental.rental_requests.id,
    rentalNumber: rental.rental_requests.rentalNumber,
    customerName: rental.rental_requests.customerName,
    customerEmail: rental.rental_requests.customerEmail || "",
    customerPhone: rental.rental_requests.customerPhone || "",
    companyName: rental.rental_requests.customerCompany || undefined,
    equipmentBrand: rental.rental_fleet?.brand || "",
    equipmentModel: rental.rental_fleet?.model || "",
    equipmentCategory: rental.rental_fleet?.category || "",
    startDate: rental.rental_requests.startDate,
    endDate: rental.rental_requests.endDate,
    rentalDays: days,
    rentalFee: rental.rental_requests.rentalFee || "0",
    freightCost: rental.rental_requests.freightCost || "0",
    insuranceCost: rental.rental_requests.insuranceCost || "0",
    taxAmount: rental.rental_requests.taxAmount || "0",
    depositAmount: rental.rental_requests.depositAmount || "0",
    totalCost: rental.rental_requests.totalAmount || "0",
    customerDiscountPercent: rental.rental_requests.customerDiscountPercent,
    priceMatchEnabled: rental.rental_requests.priceMatchEnabled,
    priceMatchCompetitor: rental.rental_requests.priceMatchCompetitor,
    priceMatchAmount: rental.rental_requests.priceMatchAmount,
    deliveryAddress: rental.rental_requests.deliveryAddress || "Customer pickup",
    projectDescription: rental.rental_requests.projectDescription || undefined,
    contractTemplateId: rental.rental_requests.contractTemplateId ?? undefined,
    customerSignature: rental.rental_requests.customerSignature,
    customerSignedAt: rental.rental_requests.contractSignedAt,
    repSignature: rental.rental_requests.repSignature,
    repSignedAt: rental.rental_requests.repSignedAt,
    items: await getContractLineItems(rental.rental_requests.id),
  });

  await db.update(schema.rentalRequests).set({
    contractUrl: url,
    contractGenerated: true,
    contractGeneratedAt: new Date(),
    contractVersion: (rental.rental_requests.contractVersion || 0) + 1,
  }).where(eq(schema.rentalRequests.id, rentalId));

  return { url };
}

async function refreshCustomerCounters(customerId: number) {
  try {
    const db = await getDb();
    if (!db) return;

    const [stats] = await db
      .select({
        cnt: sql<number>`count(*)::int`,
        rev: sql<string>`coalesce(sum(${schema.rentalRequests.totalAmount}::numeric), 0)`,
        lastDate: sql<Date | null>`max(${schema.rentalRequests.createdAt})`,
      })
      .from(schema.rentalRequests)
      .where(and(
        eq(schema.rentalRequests.customerId, customerId),
        isNull(schema.rentalRequests.deletedAt),
      ));

    if (stats) {
      // Drizzle raw SQL returns max(timestamp) as string, not Date — coerce before writing
      // to a timestamp column (mode: "date") which calls .toISOString() on the value.
      const lastDate = stats.lastDate ? new Date(stats.lastDate as unknown as string) : null;
      await db.update(schema.customers).set({
        totalRentals: stats.cnt,
        totalRevenue: stats.rev,
        lastRentalDate: lastDate,
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, customerId));
    }
  } catch (err) {
    logger.warn("[refreshCustomerCounters] Failed", {
      customerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// Resolve the customer for an admin-created order. Precedence:
//   1. explicit customerId — the admin picked an existing match in the order
//      form; reuse it and refresh its fields. NEVER create a duplicate.
//   2. email — find-or-create by email (legacy behavior).
//   3. neither — create a phone-only customer.
// Shared by adminCreate and adminCreateWithItems so the dedup fix lives in one
// place. Throws NOT_FOUND if a supplied customerId does not exist / is deleted.
async function resolveOrderCustomer(
  db: Db,
  input: {
    customerId?: number;
    customerName: string;
    customerEmail?: string;
    customerPhone?: string;
    customerCompany?: string;
  },
): Promise<{ customerId: number; existingCustomer?: schema.Customer }> {
  if (input.customerId) {
    const [picked] = await db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.id, input.customerId), isNull(schema.customers.deletedAt)))
      .limit(1);
    if (!picked) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Selected customer not found" });
    }
    await db.update(schema.customers).set({
      name: input.customerName,
      email: input.customerEmail ?? picked.email,
      phone: input.customerPhone ?? picked.phone,
      company: input.customerCompany ?? picked.company,
      updatedAt: new Date(),
    }).where(eq(schema.customers.id, picked.id));
    return { customerId: picked.id, existingCustomer: picked };
  }

  if (input.customerEmail) {
    const [existing] = await db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.email, input.customerEmail), isNull(schema.customers.deletedAt)))
      .limit(1);
    if (existing) {
      await db.update(schema.customers).set({
        name: input.customerName,
        phone: input.customerPhone,
        company: input.customerCompany,
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, existing.id));
      return { customerId: existing.id, existingCustomer: existing };
    }
    const [created] = await db.insert(schema.customers).values({
      name: input.customerName,
      email: input.customerEmail,
      phone: input.customerPhone,
      company: input.customerCompany,
    }).returning();
    return { customerId: created.id };
  }

  const [created] = await db.insert(schema.customers).values({
    name: input.customerName,
    phone: input.customerPhone,
    company: input.customerCompany,
  }).returning();
  return { customerId: created.id };
}

function validateDates(startDate: string, endDate: string) {
  const start = parseCalendarDate(startDate);
  const end = parseCalendarDate(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid date format" });
  }
  if (start >= end) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Start date must be before end date" });
  }
  return { start, end };
}

export type RentalStatus = "pending" | "approved" | "rejected" | "active" | "completed" | "cancelled" | "overdue";

type RentalDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type RentalTx = Parameters<Parameters<RentalDb["transaction"]>[0]>[0];

export interface TransitionInput {
  rentalId: number;
  targetStatus: RentalStatus;
  adminNotes?: string;
  earlyReturn?: boolean;
  systemInspectionOverrideReason?: "credit_order_finalization";
  transitionOverrideReason?: string;
  actualReturnDate?: Date | null;
  transitionedAt?: Date;
  additionalUpdates?: Partial<typeof schema.rentalRequests.$inferInsert>;
  prepareCoreUpdate?: (
    tx: RentalTx,
    rental: typeof schema.rentalRequests.$inferSelect,
  ) => Promise<Partial<typeof schema.rentalRequests.$inferInsert>>;
  auditAction?: string;
  auditMetadata?: Record<string, unknown>;
  actor?: { id?: number; ip?: string };
}

export interface TransitionResult {
  ok: boolean;
  rentalId: number;
  oldStatus: RentalStatus;
  newStatus: RentalStatus;
  idempotent: boolean;
  // The updated rental row, for callers that return it to the client.
  rental: typeof schema.rentalRequests.$inferSelect;
  sideEffects: {
    dispatchCreated: number;
    contractGenerated: boolean;
    orderConfirmationSent: boolean;
    quotationGenerated: boolean;
    invoiceGenerated: boolean;
    fleetAssigned: number[];
    fleetReleased: number[];
  };
  failures: Array<{ kind: string; message: string }>;
}

/**
 * Single source of truth for a rental status transition and ALL its side
 * effects (auto dispatch, contract/confirmation/quotation/invoice PDFs, fleet
 * assignment/release, customer counters, notifications). Both the single
 * `updateStatus` entry point and the `batchUpdateStatus` loop call this so a
 * batch approval/completion produces exactly the same business objects as a
 * single one — no more "status changed but nothing generated" drift.
 *
 * Throws TRPCError on the core transaction (not-found / invalid transition /
 * early-return guard). Post-transaction effects are best-effort: failures are
 * collected into `result.failures` instead of thrown, so callers can surface a
 * "missing object" list. Idempotent when already at the target status.
 */
export async function transitionRentalStatus(
  db: RentalDb,
  input: TransitionInput,
): Promise<TransitionResult> {
  const sideEffects: TransitionResult["sideEffects"] = {
    dispatchCreated: 0,
    contractGenerated: false,
    orderConfirmationSent: false,
    quotationGenerated: false,
    invoiceGenerated: false,
    fleetAssigned: [],
    fleetReleased: [],
  };
  const failures: TransitionResult["failures"] = [];
  const operationPolicies = await getRentalOperationPolicies();
  const settleEffect = async (settlement: Parameters<typeof settleLifecycleEffect>[1]) => {
    try {
      await settleLifecycleEffect(db, settlement);
    } catch (error) {
      logger.error("[RentalRequests] Could not settle lifecycle effect ledger", {
        commandKey: settlement.commandKey,
        effectType: settlement.effectType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // All core DB writes in a single transaction for atomicity
  const { result, rental, oldStatus, idempotent, commandKey, requiredEffects, fleetClaimed } = await db.transaction(async (tx) => {
    // Get current rental with optimistic lock (SELECT inside tx)
    const [rental] = await tx
      .select()
      .from(schema.rentalRequests)
      .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
      .limit(1);

    if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

    const oldStatus = rental.status as RentalStatus;

    const commandKey = makeLifecycleCommandKey({
      id: rental.id,
      status: oldStatus,
      startDate: rental.startDate,
      endDate: rental.endDate,
      updatedAt: rental.updatedAt,
      lifecycleVersion: rental.lifecycleVersion,
    }, input.targetStatus);
    const sameStatus = oldStatus === input.targetStatus;
    const needsFulfillment = !sameStatus && (
      input.targetStatus === "completed"
      || (input.targetStatus === "active" && operationPolicies.dispatchInspectionRequired)
    );
    const fulfillment = needsFulfillment
      ? await getFulfillmentSnapshot(tx, rental.id)
      : {
          requiredFleetIds: [],
          dispatchInspectedFleetIds: [],
          dispatchInspectionBypassedFleetIds: [],
          returnInspectedFleetIds: [],
          returnInspectionBypassedFleetIds: [],
          incompletePickupFleetIds: [],
          unpickedReturnOperationFleetIds: [],
        };
    const transitionTime = input.transitionedAt ?? new Date();
    if (input.systemInspectionOverrideReason) {
      const systemBypassFleetIds = fulfillment.requiredFleetIds.filter((fleetId) => (
        !fulfillment.returnInspectedFleetIds.includes(fleetId)
        && !fulfillment.returnInspectionBypassedFleetIds.includes(fleetId)
      ));
      const systemEvents = buildLifecycleProgressEvents({
        commandKey,
        rentalRequestId: rental.id,
        rentalFleetIds: [],
        targetStatus: "completed",
        actorUserId: input.actor?.id,
        systemReturnInspectionBypassFleetIds: systemBypassFleetIds,
        createdAt: transitionTime,
      });
      for (const event of systemEvents) await recordAssetProgressEvent(tx, event);
      fulfillment.returnInspectionBypassedFleetIds = [
        ...new Set([...fulfillment.returnInspectionBypassedFleetIds, ...systemBypassFleetIds]),
      ];
    }
    const plan = evaluateLifecyclePlan({
      rental: {
        id: rental.id,
        status: oldStatus,
        startDate: rental.startDate,
        endDate: rental.endDate,
        updatedAt: rental.updatedAt,
      },
      targetStatus: input.targetStatus,
      fulfillment,
      now: transitionTime,
      earlyReturn: input.earlyReturn,
      dispatchWorkflow: operationPolicies.dispatchWorkflow,
      dispatchInspectionRequired: operationPolicies.dispatchInspectionRequired,
      returnInspectionRequired: operationPolicies.returnInspectionRequired,
      transitionOverrideReason: input.transitionOverrideReason,
    });
    const requiredEffects = plan.requiredEffects;

    // A same-status command is a reconciliation request. Insert any missing
    // effect records, but never repeat the core status write.
    if (sameStatus) {
      if (requiredEffects.length > 0) {
        await tx.insert(schema.rentalLifecycleEffects).values(requiredEffects.map((effectType) => ({
          commandKey,
          rentalRequestId: rental.id,
          effectType,
          payload: { targetStatus: input.targetStatus, actorId: input.actor?.id ?? null },
          nextAttemptAt: new Date(transitionTime.getTime() + 5 * 60 * 1000),
        }))).onConflictDoNothing();
      }
      return { result: rental, rental, oldStatus, idempotent: true, commandKey, requiredEffects, fleetClaimed: [] as number[] };
    }

    if (plan.blockers.length > 0) {
      // Return inspection is REQUIRED in production, so this is the error an
      // operator hits most often — and it used to surface as raw English with a
      // database id ("Return inspection is missing for fleet #123") in a Chinese
      // UI. The English message is left byte-identical (logs + fallback + the
      // tests that assert on blocker codes all keep working); only a translation
      // hint is added alongside it.
      const codes = Array.from(new Set(plan.blockers.map((blocker) => blocker.code)));
      throw i18nError({
        code: "PRECONDITION_FAILED",
        message: plan.blockers.map((blocker) => blocker.message).join("; "),
        i18nKey: codes.length === 1
          ? `errors.lifecycleBlocker.${codes[0]}`
          : "errors.lifecycleBlockedMultiple",
        i18nParams: { count: plan.blockers.length, kinds: codes.length },
      });
    }

    const preparedUpdates = input.prepareCoreUpdate
      ? await input.prepareCoreUpdate(tx, rental)
      : {};
    const fleetClaimed = input.targetStatus === "active" && oldStatus !== "overdue"
      ? await (await import("../services/rentalLineItemSync")).claimAllFleetForRental(tx, rental.id)
      : [];
    const updatedRows = await tx
      .update(schema.rentalRequests)
      .set({
        ...input.additionalUpdates,
        ...preparedUpdates,
        status: input.targetStatus,
        lifecycleVersion: nextLifecycleVersion(rental.lifecycleVersion),
        ...(input.adminNotes !== undefined ? { adminNotes: input.adminNotes } : {}),
        updatedAt: transitionTime,
      })
      .where(and(
        eq(schema.rentalRequests.id, input.rentalId),
        eq(schema.rentalRequests.status, oldStatus),
        sql`coalesce(${schema.rentalRequests.lifecycleVersion}, 0) = ${rental.lifecycleVersion ?? 0}`,
        isNull(schema.rentalRequests.deletedAt),
      ))
      .returning();
    const result = assertLifecycleCasSucceeded(updatedRows);

    if (requiredEffects.length > 0) {
      await tx.insert(schema.rentalLifecycleEffects).values(requiredEffects.map((effectType) => ({
        commandKey,
        rentalRequestId: rental.id,
        effectType,
        payload: { targetStatus: input.targetStatus, actorId: input.actor?.id ?? null },
        nextAttemptAt: new Date(transitionTime.getTime() + 5 * 60 * 1000),
      }))).onConflictDoNothing();
    }

    // Approval progress exists independently from dispatch. This keeps pickup
    // orders and dispatch-disabled deployments visible in the shared workflow.
    if (input.targetStatus === "approved") {
      const { getRentalFulfillmentUnits } = await import("../services/rentalLineItemSync");
      const units = (await getRentalFulfillmentUnits(tx, rental.id)).filter(u => u.rentalFleetId);
      const fleetIds = units.flatMap((unit) => unit.rentalFleetId ? [unit.rentalFleetId] : []);
      for (const event of buildLifecycleProgressEvents({
        commandKey,
        rentalRequestId: rental.id,
        rentalFleetIds: fleetIds,
        targetStatus: "approved",
        actorUserId: input.actor?.id,
        createdAt: transitionTime,
      })) await recordAssetProgressEvent(tx, event);

      // Unsettled credit orders are open-ended (sentinel endDate), so dispatch
      // is still created manually at exchange/close-out time.
      const isUnsettledCreditTx = rental.isCreditOrder && !rental.creditFinalizedAt;
      if (!isUnsettledCreditTx
          && shouldAutoCreateDispatch(operationPolicies.dispatchWorkflow, rental.deliveryMethod)) {
        const ref = rental.rentalNumber || `#${rental.id}`;
        let isFirstDelivery = true;
        for (const unit of units) {
          const label = [unit.brand, unit.model].filter(Boolean).join(" ") || `fleet #${unit.rentalFleetId}`;
          await tx.insert(schema.dispatchOrders).values({
            orderType: "delivery",
            confirmationToken: nanoid(32),
            rentalRequestId: rental.id,
            rentalFleetId: unit.rentalFleetId,
            customerId: rental.customerId,
            scheduledDate: unit.startDate ?? rental.startDate,
            deliveryAddress: rental.deliveryAddress,
            shippingCost: isFirstDelivery ? rental.freightCost : null,
            notes: `Auto-created from rental ${ref} approval — ${label}`,
          });
          isFirstDelivery = false;
          sideEffects.dispatchCreated++;

          if (rental.deliveryMethod === "delivery_and_return") {
            await tx.insert(schema.dispatchOrders).values({
              orderType: "pickup",
              confirmationToken: nanoid(32),
              rentalRequestId: rental.id,
              rentalFleetId: unit.rentalFleetId,
              customerId: rental.customerId,
              scheduledDate: unit.endDate ?? rental.endDate,
              pickupAddress: rental.deliveryAddress,
              notes: `Auto-created return pickup from rental ${ref} — ${label}`,
            });
            sideEffects.dispatchCreated++;
          }
        }
      }
    }

    if (input.targetStatus === "completed") {
      for (const event of buildLifecycleProgressEvents({
        commandKey,
        rentalRequestId: rental.id,
        rentalFleetIds: fulfillment.requiredFleetIds,
        targetStatus: "completed",
        actorUserId: input.actor?.id,
        createdAt: transitionTime,
      })) await recordAssetProgressEvent(tx, event);
    }

    return { result, rental, oldStatus, idempotent: false, commandKey, requiredEffects, fleetClaimed };
  });

  sideEffects.fleetAssigned = fleetClaimed;

  // Rolling rentals remain financially and operationally open until the same
  // guarded completion command closes them. Settle any final partial period
  // before fleet release; if this fails, the unit remains unavailable and a
  // same-status retry resumes idempotently.
  if (input.targetStatus === "completed") {
    const { finalizeRollingRentalOnCompletion } = await import("../services/rollingSettlement");
    await finalizeRollingRentalOnCompletion(db, {
      rentalId: input.rentalId,
      endedAt: input.transitionedAt ?? new Date(),
      endedBy: input.actor?.id,
    });
  }

  if (idempotent) {
    for (const effectType of requiredEffects) {
      try {
        if (effectType === "contract_generate") {
          if (rental.isCreditOrder && !rental.creditFinalizedAt) {
            await settleEffect({ commandKey, effectType, skipped: true });
            continue;
          }
          if (rental.contractGenerated && rental.contractUrl) {
            await settleEffect({ commandKey, effectType, skipped: true });
            continue;
          }
          await regenerateContractPdf(rental.id);
          sideEffects.contractGenerated = true;
        } else if (effectType === "quotation_generate") {
          // A quote generated *after* the order is approved is backwards — the
          // quote precedes the booking. In production this produced 139 quotes
          // in 90 days: 97 expired, 42 draft, 0 ever sent. Off by default; the
          // flag restores the old behaviour with no code change.
          if (!(await isFeatureEnabled("auto_quotation_on_approve"))) {
            await settleEffect({ commandKey, effectType, skipped: true });
            continue;
          }
          if (rental.isCreditOrder && !rental.creditFinalizedAt) {
            await settleEffect({ commandKey, effectType, skipped: true });
            continue;
          }
          const { generateQuotationFromRental } = await import("../services/quotationGenerator");
          await generateQuotationFromRental({ rentalId: rental.id, createdBy: input.actor?.id });
          sideEffects.quotationGenerated = true;
        } else if (effectType === "invoice_reconcile") {
          if (rental.isCreditOrder) {
            await settleEffect({ commandKey, effectType, skipped: true });
            continue;
          }
          const { generateInvoiceFromRental } = await import("../services/invoiceGenerator");
          await generateInvoiceFromRental({
            rentalId: rental.id,
            createdBy: input.actor?.id,
            actualReturnDate: input.actualReturnDate,
          });
          sideEffects.invoiceGenerated = true;
        } else if (effectType === "invoice_document") {
          if (rental.isCreditOrder) {
            await settleEffect({ commandKey, effectType, skipped: true });
            continue;
          }
          const { generateInvoiceFromRental } = await import("../services/invoiceGenerator");
          const invoice = await generateInvoiceFromRental({
            rentalId: rental.id,
            createdBy: input.actor?.id,
            actualReturnDate: input.actualReturnDate,
          });
          const { generateInvoicePDF } = await import("../services/invoicePDF");
          await generateInvoicePDF(invoice.invoiceId);
        }
        await settleEffect({ commandKey, effectType });
      } catch (error) {
        await settleEffect({ commandKey, effectType, error });
        failures.push({
          kind: effectType,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: true, rentalId: input.rentalId, oldStatus, newStatus: oldStatus,
      idempotent: true, rental: result, sideEffects, failures,
    };
  }

  // --- Post-transaction side effects (non-critical, logged on failure) ---

  // Unsettled credit (挂账) orders are open-ended: their endDate is the
  // far-future sentinel and their amount is TBD until close-out. Skip every
  // side effect that reads endDate/amount (contract PDF, order-confirmation
  // PDF/email, auto quotation, auto invoice) — billing flows exclusively
  // through the rental_charges ledger instead.
  const isUnsettledCredit = rental.isCreditOrder && !rental.creditFinalizedAt;

  // Audit log
  await logAudit({
    userId: input.actor?.id,
    action: input.auditAction ?? "status_change",
    entityType: "rental",
    entityId: input.rentalId,
    changes: { status: { old: oldStatus, new: input.targetStatus } },
    metadata: { customerName: rental.customerName, ...input.auditMetadata },
    ipAddress: input.actor?.ip,
  });

  // Contract PDF generation (external service, non-transactional).
  // Multi-line aware: gate on "has any fleet" (line items OR parent
  // pointer), and derive the equipment fields from fulfillment units so
  // multi-item orders render the per-line table while single/legacy orders
  // keep the single-equipment block. Both fall back to the parent pointer.
  const { getRentalFleetIds, getRentalFulfillmentUnits } = await import("../services/rentalLineItemSync");
  const contractFleetIds = await getRentalFleetIds(db, rental.id);
  if (input.targetStatus === "approved" && contractFleetIds.length > 0 && !isUnsettledCredit) {
    try {
      const items = await getContractLineItems(rental.id);
      const [primary] = await getRentalFulfillmentUnits(db, rental.id);
      const { generateContractPDF } = await import("../services/contractPDF");
      // Contract PDF "Duration" text only — DST-safe so it matches the billed term.
      const days = calculateDaysBetween(rental.startDate, rental.endDate);
      const { url } = await generateContractPDF({
        rentalId: rental.id,
        rentalNumber: rental.rentalNumber,
        customerName: rental.customerName,
        customerEmail: rental.customerEmail || "",
        customerPhone: rental.customerPhone || "",
        companyName: rental.customerCompany || undefined,
        equipmentBrand: primary?.brand || "",
        equipmentModel: primary?.model || "",
        equipmentCategory: primary?.category || "",
        startDate: rental.startDate,
        endDate: rental.endDate,
        rentalDays: days,
        rentalFee: rental.rentalFee || "0",
        freightCost: rental.freightCost || "0",
        insuranceCost: rental.insuranceCost || "0",
        taxAmount: rental.taxAmount || "0",
        depositAmount: rental.depositAmount || "0",
        totalCost: rental.totalAmount || "0",
        customerDiscountPercent: rental.customerDiscountPercent,
        priceMatchEnabled: rental.priceMatchEnabled,
        priceMatchCompetitor: rental.priceMatchCompetitor,
        priceMatchAmount: rental.priceMatchAmount,
        deliveryAddress: rental.deliveryAddress || "Customer pickup",
        projectDescription: rental.projectDescription || undefined,
        contractTemplateId: rental.contractTemplateId ?? undefined,
        customerSignature: rental.customerSignature,
        customerSignedAt: rental.contractSignedAt,
        repSignature: rental.repSignature,
        repSignedAt: rental.repSignedAt,
        items,
      });

      await db.update(schema.rentalRequests).set({
        contractUrl: url,
        contractGenerated: true,
        contractGeneratedAt: new Date(),
      }).where(eq(schema.rentalRequests.id, input.rentalId));
      sideEffects.contractGenerated = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[RentalRequests] Contract generation failed", { error: message });
      failures.push({ kind: "contract", message });
    }
  }

  // Order confirmation PDF + email (non-transactional, best-effort)
  if (input.targetStatus === "approved" && !isUnsettledCredit) {
    try {
      const { generateOrderConfirmationPDF } = await import("../services/orderConfirmationPDF");
      await generateOrderConfirmationPDF(rental.id);

      const { sendOrderConfirmationEmail } = await import("../services/notifications");
      await sendOrderConfirmationEmail(rental.id);
      sideEffects.orderConfirmationSent = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[RentalRequests] Order confirmation PDF/email failed", { rentalId: rental.id, error: message });
      failures.push({ kind: "orderConfirmation", message });
    }

    // SMS the customer with a self-sign link (best-effort)
    try {
      const { notifyRentalApproved } = await import("../services/smsNotify");
      await notifyRentalApproved(rental.customerPhone, rental.id, rental.rentalNumber);
    } catch { /* notification is best-effort */ }
  }

  // Auto-generate quotation when approved (non-transactional, best-effort)
  if (input.targetStatus === "approved" && !isUnsettledCredit) {
    try {
      const { generateQuotationFromRental } = await import("../services/quotationGenerator");
      const qtResult = await generateQuotationFromRental({
        rentalId: rental.id,
        createdBy: input.actor?.id,
      });
      logger.info("[RentalRequests] Quotation auto-generated", {
        rentalId: rental.id,
        quotationNumber: qtResult.quotationNumber,
      });
      sideEffects.quotationGenerated = true;

      // Auto-generate quotation PDF
      try {
        const { generateQuotationPDF } = await import("../services/quotationPDF");
        await generateQuotationPDF(qtResult.quotationId);
      } catch (pdfErr) {
        logger.error("[RentalRequests] Quotation PDF generation failed", {
          error: pdfErr instanceof Error ? pdfErr.message : String(pdfErr),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[RentalRequests] Quotation auto-generation failed", { rentalId: rental.id, error: message });
      failures.push({ kind: "quotation", message });
    }
  }

  // Auto-generate invoice when completed (non-transactional, best-effort).
  // Credit orders bill through the charges ledger + finalizeCreditOrder, so
  // skip the rental-derived invoice to avoid colliding with that flow.
  if (input.targetStatus === "completed" && !rental.isCreditOrder) {
    try {
      const { generateInvoiceFromRental } = await import("../services/invoiceGenerator");
      const invResult = await generateInvoiceFromRental({
        rentalId: rental.id,
        createdBy: input.actor?.id,
        actualReturnDate: input.actualReturnDate,
      });
      logger.info("[RentalRequests] Invoice auto-generated on completion", {
        rentalId: rental.id,
        invoiceNumber: invResult.invoiceNumber,
      });
      sideEffects.invoiceGenerated = true;

      // Auto-generate invoice PDF, then email it to the customer — mirrors the
      // manual invoices.generateFromRental path so an auto-completed order doesn't
      // silently skip the customer's invoice email. sendInvoiceEmail self-gates on
      // the invoice_auto_send setting + the global email toggle, so this respects
      // the same admin controls and won't double-send.
      try {
        const { generateInvoicePDF } = await import("../services/invoicePDF");
        await generateInvoicePDF(invResult.invoiceId);

        const { sendInvoiceEmail } = await import("../services/notifications");
        await sendInvoiceEmail(invResult.invoiceId);
      } catch (pdfErr) {
        const message = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
        logger.error("[RentalRequests] Invoice PDF/email after completion failed", {
          error: message,
        });
        failures.push({ kind: "invoiceDocument", message });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[RentalRequests] Invoice auto-generation failed", { rentalId: rental.id, error: message });
      failures.push({ kind: "invoice", message });
    }
  }

  if (input.targetStatus === "completed" || input.targetStatus === "cancelled") {
    const { releaseAllFleetForRental, getRentalFleetIds: getIds } = await import("../services/rentalLineItemSync");
    sideEffects.fleetReleased = await getIds(db, input.rentalId);
    await releaseAllFleetForRental(db, input.rentalId);
  }

  // Cancel/reject must retire the delivery/pickup dispatch orders that were
  // auto-created at approval — otherwise they linger as "pending" on the
  // dispatch board (dispatch.list filters deletedAt, not cancelled-rental
  // status) and a dispatcher could send a truck for a dead order. Only
  // non-terminal dispatches (pending/assigned) are voided; anything already
  // in_transit/delivered/completed reflects a real physical movement and is
  // left as-is.
  if (input.targetStatus === "cancelled" || input.targetStatus === "rejected") {
    await db
      .update(schema.dispatchOrders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(
        eq(schema.dispatchOrders.rentalRequestId, input.rentalId),
        isNull(schema.dispatchOrders.deletedAt),
        inArray(schema.dispatchOrders.status, ["pending", "assigned"]),
      ));
  }

  // Refresh customer counters on any status change
  if (rental.customerId) {
    await refreshCustomerCounters(rental.customerId);
  }

  // Notification (best-effort)
  try {
    const { notifyOnEvent } = await import("../services/notifications");
    await notifyOnEvent(`rental_${input.targetStatus}`, {
      customerName: rental.customerName,
      email: rental.customerEmail || "",
      phone: rental.customerPhone || "",
      rentalId: String(rental.id),
      status: input.targetStatus,
    });
  } catch (err) {
    logger.error("[RentalRequests] Notification failed", { error: err });
    failures.push({ kind: "notification", message: err instanceof Error ? err.message : String(err) });
  }

  // MailPulse outbox (best-effort, fail-closed — never throws into the transition)

  const effectFailureKinds: Record<string, string> = {
    contract_generate: "contract",
    order_confirmation: "orderConfirmation",
    quotation_generate: "quotation",
    invoice_reconcile: "invoice",
    invoice_document: "invoiceDocument",
    notification: "notification",
  };
  for (const effectType of requiredEffects) {
    const failure = failures.find((item) => item.kind === effectFailureKinds[effectType]);
    const skipped = (isUnsettledCredit && ["contract_generate", "order_confirmation", "quotation_generate"].includes(effectType))
      || (rental.isCreditOrder && ["invoice_reconcile", "invoice_document"].includes(effectType))
      || (effectType === "contract_generate" && contractFleetIds.length === 0);
    await settleEffect({
      commandKey,
      effectType,
      ...(failure ? { error: new Error(failure.message) } : {}),
      skipped,
    });
  }

  return {
    ok: true, rentalId: input.rentalId, oldStatus, newStatus: input.targetStatus,
    idempotent: false, rental: result, sideEffects, failures,
  };
}

export const rentalRequestsRouter = router({
  list: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({
      status: z.enum(["pending", "approved", "rejected", "active", "completed", "cancelled", "overdue"]).optional(),
      limit: z.number().min(1).max(1000).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [isNull(schema.rentalRequests.deletedAt)];
      if (input?.status) conditions.push(eq(schema.rentalRequests.status, input.status));

      const baseQuery = db
        .select()
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.customers, and(eq(schema.rentalRequests.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.rentalRollingTerms, eq(schema.rentalRollingTerms.rentalRequestId, schema.rentalRequests.id))
        .where(and(...conditions))
        // Sort by rental start date (newest first). Falls back to createdAt
        // as a stable tie-breaker when two rentals share the same start day.
        .orderBy(desc(schema.rentalRequests.startDate), desc(schema.rentalRequests.createdAt))
        .limit(input?.limit ?? 500);

      return baseQuery;
    }),

  /**
   * Lightweight order picker (for the extra-charge / damage form): match by
   * rental number, financial order number, customer name/company, or numeric id.
   */
  searchForCharge: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({ query: z.string().min(1).max(100) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const q = `%${input.query.trim()}%`;
      const asId = /^\d+$/.test(input.query.trim()) ? Number(input.query.trim()) : null;
      return db
        .select({
          id: schema.rentalRequests.id,
          rentalNumber: schema.rentalRequests.rentalNumber,
          financialOrderNumber: schema.rentalRequests.financialOrderNumber,
          customerName: schema.rentalRequests.customerName,
          customerId: schema.rentalRequests.customerId,
          status: schema.rentalRequests.status,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
        })
        .from(schema.rentalRequests)
        .where(and(
          isNull(schema.rentalRequests.deletedAt),
          or(
            ilike(schema.rentalRequests.customerName, q),
            ilike(schema.rentalRequests.customerCompany, q),
            ilike(schema.rentalRequests.rentalNumber, q),
            ilike(schema.rentalRequests.financialOrderNumber, q),
            ...(asId ? [eq(schema.rentalRequests.id, asId)] : []),
          ),
        ))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(8);
    }),

  /**
   * Derived payment state per order (id → total + prepaid), so the list can
   * show a Paid / Partial / Unpaid badge without bloating the main list select.
   * Driven by the prepayment ledger — consistent with the AR / cash reports.
   */
  paymentStatusMap: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .query(async () => {
      const db = await getDb();
      if (!db) return [];
      const rows: Record<string, unknown>[] = await db.execute(sql`
        SELECT r.id,
          COALESCE(r."totalAmount"::numeric, 0) AS total,
          COALESCE(pp.paid, 0) AS prepaid
        FROM rental_requests r
        LEFT JOIN (
          -- Only APPLIED (转租金) prepayments settle the order; held money doesn't
          -- count yet, and refunds (negative rows) net out. Matches the dialog.
          SELECT "rentalRequestId" AS rid, SUM(amount::numeric) AS paid
          FROM rental_prepayments WHERE "deletedAt" IS NULL AND "appliedAt" IS NOT NULL
          GROUP BY "rentalRequestId"
        ) pp ON pp.rid = r.id
        WHERE r."deletedAt" IS NULL
      `);
      return rows.map((r) => ({
        id: Number(r.id),
        total: Number(r.total) || 0,
        prepaid: Number(r.prepaid) || 0,
      }));
    }),

  // Lightweight list for dropdowns (dispatch page, etc.)
  listForDropdown: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({
      activeOnly: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [isNull(schema.rentalRequests.deletedAt)];
      if (input?.activeOnly) {
        conditions.push(
          or(
            eq(schema.rentalRequests.status, "pending"),
            eq(schema.rentalRequests.status, "approved"),
            eq(schema.rentalRequests.status, "active"),
          )!,
        );
      }

      return db
        .select({
          id: schema.rentalRequests.id,
          rentalNumber: schema.rentalRequests.rentalNumber,
          customerName: schema.rentalRequests.customerName,
          status: schema.rentalRequests.status,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
          deliveryAddress: schema.rentalRequests.deliveryAddress,
          deliveryMethod: schema.rentalRequests.deliveryMethod,
          rentalFleetId: schema.rentalRequests.rentalFleetId,
          fleetBrand: schema.rentalFleet.brand,
          fleetModel: schema.rentalFleet.model,
          fleetLocationId: schema.rentalFleet.locationId,
          warehouseName: schema.warehouses.name,
          warehouseAddress: schema.warehouses.address,
        })
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.warehouses, and(eq(schema.rentalFleet.locationId, schema.warehouses.id), isNull(schema.warehouses.deletedAt)))
        .where(and(...conditions))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(200);
    }),

  // Per-unit equipment for an order — used by manual dispatch to let staff pick
  // which fleet asset a delivery/pickup is for. Multi-item orders return one
  // unit per line item; single/legacy orders return the sole unit (parent
  // pointer fallback).
  fulfillmentUnits: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({ rentalId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const { getRentalFulfillmentUnits } = await import("../services/rentalLineItemSync");
      return getRentalFulfillmentUnits(db, input.rentalId);
    }),

  getById: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [result] = await db
        .select()
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.customers, and(eq(schema.rentalRequests.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .where(and(eq(schema.rentalRequests.id, input.id), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      if (!result) return null;

      // ─── Export hydration (transportation row + WeChat dispatch) ─────
      // Assemble inspection / prepayment summaries + computed cells so the
      // "复制财务运输行 / Copy transportation row" and "复制到微信群 / Copy for
      // WeChat" features can emit their output from one query. Kept here (vs a
      // separate procedure) so the detail dialog and the per-row list button
      // share it.
      const rr = result.rental_requests;
      const fleet = result.rental_fleet;

      const inspectionRows = await db
        .select({
          id: schema.inspections.id,
          type: schema.inspections.type,
          engineHours: schema.inspections.engineHours,
          hourMeter: schema.inspections.hourMeter,
          fuelLevel: schema.inspections.fuelLevel,
          fuelChargeAmount: schema.inspections.fuelChargeAmount,
          createdAt: schema.inspections.createdAt,
        })
        .from(schema.inspections)
        .where(and(eq(schema.inspections.rentalId, input.id), isNull(schema.inspections.deletedAt)))
        .orderBy(desc(schema.inspections.createdAt));
      const pickInspection = (linkedId: number | null, type: "dispatch" | "return") =>
        inspectionRows.find((i) => i.id === linkedId) ?? inspectionRows.find((i) => i.type === type) ?? null;
      const dispatchInsp = pickInspection(rr.deliveryInspectionId, "dispatch");
      const returnInsp = pickInspection(rr.returnInspectionId, "return");

      const prepaymentRows = await db
        .select({ amount: schema.rentalPrepayments.amount, paymentMethod: schema.rentalPrepayments.paymentMethod })
        .from(schema.rentalPrepayments)
        .where(and(eq(schema.rentalPrepayments.rentalRequestId, input.id), isNull(schema.rentalPrepayments.deletedAt)));

      // "送出" — has the unit actually been dispatched/sent out? Any dispatch
      // order past the pending/cancelled stage counts as sent.
      const dispatchRows = await db
        .select({ status: schema.dispatchOrders.status })
        .from(schema.dispatchOrders)
        .where(and(eq(schema.dispatchOrders.rentalRequestId, input.id), isNull(schema.dispatchOrders.deletedAt)));
      const dispatched = dispatchRows.some((d) => d.status !== "pending" && d.status !== "cancelled");

      const num = (v: unknown) => (v == null || v === "" ? 0 : parseFloat(String(v)));
      // Feeds only the WeChat dispatch text ("Machine: X (Nday)") — no finance
      // column consumes it. DST-safe so it matches the billed term.
      const days = calculateDaysBetween(rr.startDate, rr.endDate);
      const receivedTotal = prepaymentRows.reduce((s, p) => s + num(p.amount), 0);
      const paymentMethods = [...new Set(prepaymentRows.map((p) => p.paymentMethod).filter(Boolean))].join(", ");
      const deliveryMethodLabel = rr.deliveryMethod === "pickup" ? "Self pickup" : rr.deliveryMethod ? "Delivery" : "";
      // 保险 label must match the VEHICLES insurance table keys so the sheet's
      // R formula (XLOOKUP by 保险) resolves: BASIC / FULL COVER / N/P.
      const insuranceLabel = rr.insuranceType === "basic" ? "BASIC" : rr.insuranceType === "full" ? "FULL COVER" : "N/P";
      // Their convention: 型號 holds the model code only (no brand prefix).
      const machineModel = fleet?.model ?? rr.equipmentDescription ?? "";

      // Only the MANUAL-entry columns the sheet's formulas consume. Computed
      // columns (租赁费用/保险费/应收费用/押金/应收款/应付尾款/退款金额/可用小时/
      // 应收油费/还车时间/当月天数) are LIVE FORMULAS — left blank by the export.
      const _export = {
        // 单号 prefers the external accounting number (SOT/SOR); falls back to ours.
        orderNumber: rr.financialOrderNumber || rr.rentalNumber || "",
        days,
        receivedTotal,
        paymentMethods,
        machineModel,
        deliveryMethodLabel,
        insuranceLabel,
        completed: rr.status === "completed" ? "TRUE" : "FALSE",
        dispatched: dispatched ? "TRUE" : "FALSE",
        preCheck: dispatchInsp ? "TRUE" : "FALSE",
        postCheck: returnInsp ? "TRUE" : "FALSE",
        preHours: dispatchInsp?.engineHours ?? dispatchInsp?.hourMeter ?? null,
        postHours: returnInsp?.engineHours ?? returnInsp?.hourMeter ?? null,
        fuelReturned: returnInsp?.fuelLevel ?? null,
      };

      // Extra charges (fuel/damage/…) owed on this order, with tax. The dialog
      // adds this to totalAmount for the true balance/refund — totalAmount alone
      // never includes extras.
      const extraChargesOwed = await getOrderExtraCharges(input.id);

      return { ...result, _export, extraChargesOwed };
    }),

  create: publicProcedure
    .input(z.object({
      rentalFleetId: z.number().optional(),
      customerName: z.string().min(1).max(255),
      customerEmail: z.string().email().max(255).optional(),
      customerPhone: z.string().max(50).optional(),
      customerCompany: z.string().max(255).optional(),
      equipmentDescription: z.string().max(2000).optional(),
      startDate: z.string().max(30),
      endDate: z.string().max(30),
      deliveryMethod: z.enum(["pickup", "delivery", "delivery_and_return"]).optional(),
      deliveryAddress: z.string().max(1000).optional(),
      deliveryProvince: z.string().max(2).optional(),
      pickupProvince: z.string().max(2).optional(),
      taxProvince: z.string().max(2).optional(),
      insuranceType: z.enum(["none", "basic", "full"]).optional(),
      insuranceCost: zMoneyOptional(),
      freightCost: zMoneyOptional(),
      taxAmount: zMoneyOptional(),
      taxBreakdown: z.string().max(100).optional(),
      rentalFee: zMoneyOptional(),
      depositAmount: zMoneyOptional(),
      totalAmount: zMoneyOptional(),
      projectDescription: z.string().max(5000).optional(),
      deliveryNotes: z.string().max(2000).optional(),
      customerNotes: z.string().max(2000).optional(),
      referralCode: z.string().max(50).optional(),
      scheduledDeliveryTime: z.string().max(5).optional(),
      scheduledPickupTime: z.string().max(5).optional(),
      creditOverride: z.boolean().optional(),
      customerEquipmentNote: z.string().max(500).optional(),
      compatibilityAcknowledgedAt: z.string().max(40).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Validate dates
      const { start, end } = validateDates(input.startDate, input.endDate);

      // Check availability if fleet asset specified
      if (input.rentalFleetId) {
        const availability = await checkDateRangeAvailability(input.rentalFleetId, start, end);
        if (!availability.isAvailable) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Equipment not available for selected dates",
          });
        }
      }

      // Find or create customer
      let customerId: number | undefined;
      let existingCustomer: schema.Customer | undefined;
      if (input.customerEmail) {
        const [existing] = await db
          .select()
          .from(schema.customers)
          .where(and(eq(schema.customers.email, input.customerEmail), isNull(schema.customers.deletedAt)))
          .limit(1);

        if (existing) {
          customerId = existing.id;
          existingCustomer = existing;
          // Update customer info
          await db.update(schema.customers).set({
            name: input.customerName,
            phone: input.customerPhone,
            company: input.customerCompany,
            updatedAt: new Date(),
          }).where(eq(schema.customers.id, existing.id));
        } else {
          const [created] = await db.insert(schema.customers).values({
            name: input.customerName,
            email: input.customerEmail,
            phone: input.customerPhone,
            company: input.customerCompany,
          }).returning();
          customerId = created.id;
        }
      }

      // ─── Authoritative server-side pricing ───────────────────────────
      // NEVER trust client-supplied money on this public endpoint. When a
      // fleet asset is identified we recompute rentalFee/insurance/freight/
      // tax/deposit/total from the same engine the quote preview uses and
      // overwrite the client values before they touch credit enforcement or
      // the DB. (A tampered client could otherwise submit totalAmount=0.01 to
      // bypass the credit check and pollute the invoice/contract.)
      let capturedDeliveryDistanceKm: number | null = null;
      let capturedFreightEstimated = false;
      if (input.rentalFleetId) {
        const { quoteMultiItem } = await import("../services/multiItemPricing");
        const quote = await quoteMultiItem(db, {
          startDate: input.startDate,
          endDate: input.endDate,
          deliveryMethod: input.deliveryMethod ?? "pickup",
          deliveryAddress: input.deliveryAddress,
          taxProvince: input.taxProvince ?? input.deliveryProvince ?? input.pickupProvince ?? "ON",
          insuranceType: input.insuranceType ?? "none",
          customerId,
          items: [{
            equipmentModelId: null,
            fleetIds: [input.rentalFleetId],
            itemType: "machine",
            quantity: 1,
          }],
        });
        // ERP guard: a machine with no configured rate must not be booked for $0.
        if (quote.hasUnpricedMachine) {
          // Customer-facing (public create path) + staff hint. Bilingual because
          // the public booking flow has no server-side i18n and the customer may
          // not read Chinese; the cause (no rate configured) is a staff action.
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This equipment isn't available for booking yet — please contact our office. / 该型号尚未设置费率，请联系办公室，或在『分类定价/型号』中配置后再下单。",
          });
        }
        input.rentalFee = quote.rentalFee.toFixed(2);
        input.insuranceCost = quote.insuranceCost.toFixed(2);
        input.freightCost = quote.freightCost.toFixed(2);
        input.taxAmount = quote.taxAmount.toFixed(2);
        input.taxBreakdown = quote.taxBreakdown || input.taxBreakdown;
        input.depositAmount = quote.depositAmount.toFixed(2);
        input.totalAmount = quote.totalAmount.toFixed(2);
        capturedDeliveryDistanceKm = quote.deliveryDistanceKm ?? null;
        capturedFreightEstimated = quote.freightEstimated ?? false;
      } else {
        // No fleet asset → we cannot price authoritatively, so we must still
        // NOT trust client-supplied money (this branch is unreachable from the
        // legitimate UI, which always sends a fleetId — it is pure attack
        // surface). Discard any client amounts: this becomes an unpriced lead
        // an admin prices later. Leaving them would allow under-billing and a
        // credit-limit bypass (the credit check below reads input.totalAmount).
        input.rentalFee = undefined;
        input.insuranceCost = undefined;
        input.freightCost = undefined;
        input.taxAmount = undefined;
        input.taxBreakdown = undefined;
        input.depositAmount = undefined;
        input.totalAmount = undefined;
      }

      // ─── Credit enforcement (gated by credit_limit feature flag) ──────
      if ((await isFeatureEnabled("credit_limit")) && customerId) {
        // Allow super_admin to override via input.creditOverride
        const isSuperAdmin = ctx.user?.role === "super_admin";
        const override = isSuperAdmin && input.creditOverride === true;

        // Load full customer record (existingCustomer may be undefined for new customers)
        let creditCustomer: schema.Customer | undefined = existingCustomer;
        if (!creditCustomer) {
          const [loaded] = await db
            .select()
            .from(schema.customers)
            .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
            .limit(1);
          creditCustomer = loaded;
        }

        // Total credit exposure: open invoice balances + committed-but-uninvoiced
        // orders + unbilled credit charges (not just open invoices).
        const currentOutstanding = await computeCreditExposure(db, customerId);
        const newOrderAmount = parseFloat(input.totalAmount ?? "0");

        const creditResult = checkCredit(
          {
            customer: creditCustomer
              ? {
                  id: creditCustomer.id,
                  isBlacklisted: creditCustomer.isBlacklisted,
                  blacklistReason: creditCustomer.blacklistReason ?? null,
                  creditLimit: creditCustomer.creditLimit ?? null,
                }
              : null,
            newOrderAmount,
            currentOutstanding,
          },
          override,
        );

        if (!creditResult.allowed) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: creditResult.message,
            cause: { code: creditResult.code },
          });
        }
      }

      // ─── Referral code resolution ────────────────────────
      let referralCodeId: number | undefined;
      let referralDiscount: string | undefined;
      // Rent BEFORE the discount — referral commission is earned on list price.
      let referralBaseFee: number | undefined;
      let resolvedReferralCode: (typeof schema.referralCodes.$inferSelect) | undefined;
      let resolvedPromotion: (typeof schema.promotions.$inferSelect) | undefined;

      // 1. Check if customer already has a bound referral code
      if (customerId && existingCustomer?.referralCodeId) {
        const [boundCode] = await db
          .select({ code: schema.referralCodes, promotion: schema.promotions })
          .from(schema.referralCodes)
          .innerJoin(schema.promotions, eq(schema.referralCodes.promotionId, schema.promotions.id))
          .where(and(
            eq(schema.referralCodes.id, existingCustomer.referralCodeId),
            eq(schema.referralCodes.isActive, true),
            isNull(schema.promotions.deletedAt),
          ))
          .limit(1);

        if (boundCode) {
          const now = new Date();
          const promo = boundCode.promotion;
          if (promo.isActive && now >= promo.startDate && now <= promo.endDate) {
            resolvedReferralCode = boundCode.code;
            resolvedPromotion = promo;
            referralCodeId = boundCode.code.id;
          }
        }
      }

      // 2. If no bound code, check the input referral code
      if (!referralCodeId && input.referralCode) {
        const [rc] = await db
          .select({ code: schema.referralCodes, promotion: schema.promotions })
          .from(schema.referralCodes)
          .innerJoin(schema.promotions, eq(schema.referralCodes.promotionId, schema.promotions.id))
          .where(and(
            eq(schema.referralCodes.code, input.referralCode.toUpperCase()),
            eq(schema.referralCodes.isActive, true),
            isNull(schema.promotions.deletedAt),
          ))
          .limit(1);

        if (rc) {
          const now = new Date();
          const promo = rc.promotion;
          if (promo.isActive && now >= promo.startDate && now <= promo.endDate) {
            // Check max uses
            if (!promo.maxUsesPerCode || rc.code.totalUses < promo.maxUsesPerCode) {
              resolvedReferralCode = rc.code;
              resolvedPromotion = rc.promotion;
              referralCodeId = rc.code.id;

              // Bind customer to this referral code (first-time use)
              if (customerId && !existingCustomer?.referralCodeId) {
                await db.update(schema.customers).set({
                  referralCodeId: rc.code.id,
                  referralBoundAt: new Date(),
                  updatedAt: new Date(),
                }).where(eq(schema.customers.id, customerId));
              }
            }
          }
        }
      }

      // 3. Calculate referral discount — off the base rent, with tax following.
      if (referralCodeId && resolvedPromotion && input.rentalFee) {
        const applied = await applyReferralDiscount({
          rentalFee: input.rentalFee,
          freightCost: input.freightCost,
          insuranceCost: input.insuranceCost,
          taxAmount: input.taxAmount,
          taxBreakdown: input.taxBreakdown,
          province: input.taxProvince ?? input.deliveryProvince ?? input.pickupProvince ?? "ON",
          discountPercent: resolvedPromotion.discountPercent,
        });
        if (applied) {
          referralDiscount = applied.discount.toFixed(2);
          // The ledger below still needs the pre-discount rent for commission.
          referralBaseFee = applied.baseFee;
          input.rentalFee = applied.rentalFee;
          input.taxAmount = applied.taxAmount;
          input.taxBreakdown = applied.taxBreakdown;
          input.totalAmount = applied.totalAmount;
        }
      }

      const rentalNumber = await generateRentalNumber();

      const [result] = await db.insert(schema.rentalRequests).values({
        rentalNumber,
        rentalFleetId: input.rentalFleetId,
        customerId,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        customerCompany: input.customerCompany,
        equipmentDescription: input.equipmentDescription,
        startDate: parseCalendarDate(input.startDate),
        endDate: parseCalendarDate(input.endDate),
        deliveryMethod: input.deliveryMethod as schema.RentalRequest["deliveryMethod"],
        deliveryAddress: input.deliveryAddress,
        deliveryProvince: input.deliveryProvince,
        pickupProvince: input.pickupProvince,
        // Never persist a null taxProvince — extra-charge tax (refund/invoice/reports)
        // silently drops to 0 without it. Fall back to the delivery/pickup province, else ON.
        taxProvince: input.taxProvince ?? input.deliveryProvince ?? input.pickupProvince ?? "ON",
        insuranceType: input.insuranceType as schema.RentalRequest["insuranceType"],
        insuranceCost: input.insuranceCost,
        freightCost: input.freightCost,
        taxAmount: input.taxAmount,
        taxBreakdown: input.taxBreakdown,
        rentalFee: input.rentalFee,
        depositAmount: input.depositAmount,
        totalAmount: input.totalAmount,
        deliveryDistanceKm: capturedDeliveryDistanceKm != null ? capturedDeliveryDistanceKm.toFixed(2) : undefined,
        freightEstimated: capturedFreightEstimated,
        projectDescription: input.projectDescription,
        deliveryNotes: input.deliveryNotes,
        customerNotes: input.customerNotes,
        scheduledDeliveryTime: input.scheduledDeliveryTime,
        scheduledPickupTime: input.scheduledPickupTime,
        referralCodeId,
        referralDiscount,
        customerEquipmentNote: input.customerEquipmentNote,
        compatibilityAcknowledgedAt: input.compatibilityAcknowledgedAt ? new Date(input.compatibilityAcknowledgedAt) : undefined,
      }).returning();

      // ─── Write referral ledger entry ─────────────────────
      if (referralCodeId && resolvedReferralCode && resolvedPromotion && input.rentalFee) {
        // List price, not the discounted rent now sitting in input.rentalFee —
        // the referrer earns on the booking, not on the customer's discount.
        const fee = referralBaseFee ?? parseFloat(input.rentalFee);
        if (!isNaN(fee) && fee > 0) {
          const discountPct = parseFloat(resolvedPromotion.discountPercent);
          const commissionPct = parseFloat(resolvedPromotion.commissionPercent);
          const discountAmt = Math.round(fee * discountPct) / 100;
          const commissionAmt = Math.round(fee * commissionPct) / 100;

          await db.insert(schema.referralLedger).values({
            referralCodeId,
            rentalRequestId: result.id,
            customerId: customerId || null,
            driverId: resolvedReferralCode.driverId,
            rentalFee: fee.toFixed(2),
            discountAmount: discountAmt.toFixed(2),
            commissionAmount: commissionAmt.toFixed(2),
          });

          // Update referral code counters
          await db.update(schema.referralCodes).set({
            totalUses: sql`${schema.referralCodes.totalUses} + 1`,
            totalCommission: sql`${schema.referralCodes.totalCommission}::numeric + ${commissionAmt}`,
          }).where(eq(schema.referralCodes.id, referralCodeId));
        }
      }

      // Refresh customer counters
      if (customerId) {
        await refreshCustomerCounters(customerId);
      }

      // Mirror this order into rental_line_items (Stage C dual-write).
      // One line per order during the single-item era; future cart-style
      // submissions will write N items via createWithItems.
      if (result.rentalFleetId) {
        try {
          const [fm] = await db
            .select({
              equipmentModelId: schema.rentalFleet.equipmentModelId,
              catalogCacheId: schema.rentalFleet.catalogCacheId,
              equipmentType: schema.catalogCache.equipmentType,
            })
            .from(schema.rentalFleet)
            .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
            .where(and(eq(schema.rentalFleet.id, result.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
            .limit(1);

          await db.insert(schema.rentalLineItems).values({
            rentalRequestId: result.id,
            rentalFleetId: result.rentalFleetId,
            equipmentModelId: fm?.equipmentModelId ?? null,
            itemType: fm?.equipmentType ?? "machine",
            quantity: 1,
            customerEquipmentNote: input.customerEquipmentNote,
            compatibilityAcknowledgedAt: input.compatibilityAcknowledgedAt ? new Date(input.compatibilityAcknowledgedAt) : null,
          });
        } catch (err) {
          logger.warn("[rentals.create] line_item mirror failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // SMS admins (best-effort)
      try {
        const { notifyNewRentalRequest } = await import("../services/smsNotify");
        await notifyNewRentalRequest(input.customerName, result.id, result.rentalNumber, result.totalAmount);
      } catch { /* notification is best-effort */ }

      return result;
    }),

  adminCreate: protectedProcedure.use(moduleGuard('rentals', 'create'))
    .input(z.object({
      customerId: z.number().optional(),
      customerDiscountPercent: z.number().min(0).max(100).optional(),
      customerName: z.string().min(1).max(255),
      customerEmail: z.string().email().max(255).optional(),
      customerPhone: z.string().max(50).optional(),
      customerCompany: z.string().max(255).optional(),
      rentalFleetId: z.number().optional(),
      equipmentDescription: z.string().max(2000).optional(),
      startDate: z.string().max(30),
      endDate: z.string().max(30).optional(),
      isCreditOrder: z.boolean().optional(),
      status: z.enum(["pending", "approved", "rejected", "active", "completed", "cancelled", "overdue"]).optional(),
      deliveryMethod: z.enum(["pickup", "delivery", "delivery_and_return"]).optional(),
      deliveryAddress: z.string().max(1000).optional(),
      deliveryProvince: z.string().max(2).optional(),
      taxProvince: z.string().max(2).optional(),
      insuranceType: z.enum(["none", "basic", "full"]).optional(),
      insuranceDocsReceived: z.boolean().optional(),
      rentalFee: zMoneyOptional(),
      freightCost: zMoneyOptional(),
      insuranceCost: zMoneyOptional(),
      taxAmount: zMoneyOptional(),
      depositAmount: zMoneyOptional(),
      totalAmount: zMoneyOptional(),
      projectDescription: z.string().max(5000).optional(),
      adminNotes: z.string().max(5000).optional(),
      projectId: z.number().optional(),
      equipmentModelId: z.number().optional(),
      referralCode: z.string().max(50).optional(),
      scheduledDeliveryTime: z.string().max(5).optional(),
      scheduledPickupTime: z.string().max(5).optional(),
      creditOverride: z.boolean().optional(),
      customerEquipmentNote: z.string().max(500).optional(),
      compatibilityAcknowledgedAt: z.string().max(40).optional(),
      financialOrderNumber: z.string().max(40).optional(),
      cardLast4: z.string().max(4).optional(),
      priceMatchEnabled: z.boolean().optional(),
      priceMatchCompetitor: z.string().max(255).optional(),
      priceMatchAmount: zMoneyOptional(),
      priceMatchNote: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // ─── Credit (挂账) order: open-ended period via sentinel endDate ──
      // Gated behind the credit_orders flag. endDate stays NOT NULL in DB; an
      // unsettled credit order stores the far-future sentinel so availability
      // treats the bin as occupied forever and the late-fee cron never matches.
      const isCreditOrder = input.isCreditOrder === true;
      if (isCreditOrder) {
        if (!(await isFeatureEnabled("credit_orders"))) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Credit orders are not enabled" });
        }
      } else if (!input.endDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "End date is required" });
      }
      const effectiveEndDate = isCreditOrder ? OPEN_ENDED_END_DATE : input.endDate!;

      // Validate dates
      const { start, end } = validateDates(input.startDate, effectiveEndDate);

      // Check availability if fleet asset specified
      if (input.rentalFleetId) {
        const availability = await checkDateRangeAvailability(input.rentalFleetId, start, end);
        if (!availability.isAvailable) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Equipment not available for selected dates",
          });
        }
      }

      // If model specified but no specific fleet item, auto-assign
      let assignedFleetId = input.rentalFleetId;
      if (!assignedFleetId && input.equipmentModelId) {
        const assigned = await autoAssignAsset(input.equipmentModelId, start, end);
        if (assigned) {
          assignedFleetId = assigned.fleetId;
        }
      }

      // Find or create customer (customerId-precedence dedup; see resolveOrderCustomer).
      const { customerId, existingCustomer } = await resolveOrderCustomer(db, input);

      // ─── ERP guards (G1 no-rate / G3 override-reason) ──────────────────
      // Manual override must record a reason; otherwise a real machine order
      // priced at $0 (rate-less model) is rejected — set the rate first.
      const isMachineOrder = !input.isCreditOrder && (!!input.rentalFleetId || !!input.equipmentModelId);
      if (input.priceMatchEnabled === true) {
        if (!input.priceMatchNote || !input.priceMatchNote.trim()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "覆盖价格必须填写原因。" });
        }
      } else if (isMachineOrder && (parseFloat(input.rentalFee ?? "0") || 0) <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该型号未设费率,请先在『分类定价/型号』设置后再下单。" });
      }

      // ─── Server-side total guard (deposit must NOT be billed) ──────────
      // Admin may price manually, so we don't re-quote here, but we DO recompute
      // the billed total from its components so a deposit can never leak into it
      // (a stale/buggy client once summed rent+freight+insurance+tax+deposit).
      // Deposit is a refundable liability — see shared/deposit.ts. Skip when the
      // priced components are absent (e.g. credit orders bill later).
      if (input.rentalFee !== undefined || input.taxAmount !== undefined) {
        const billed =
          (parseFloat(input.rentalFee ?? "0") || 0) +
          (parseFloat(input.freightCost ?? "0") || 0) +
          (parseFloat(input.insuranceCost ?? "0") || 0) +
          (parseFloat(input.taxAmount ?? "0") || 0);
        input.totalAmount = billed.toFixed(2);
      }

      // ─── Credit enforcement (gated by credit_limit feature flag) ──────
      if ((await isFeatureEnabled("credit_limit")) && customerId) {
        const isSuperAdmin = ctx.user?.role === "super_admin";
        const override = isSuperAdmin && input.creditOverride === true;

        let creditCustomer: schema.Customer | undefined = existingCustomer;
        if (!creditCustomer) {
          const [loaded] = await db
            .select()
            .from(schema.customers)
            .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
            .limit(1);
          creditCustomer = loaded;
        }

        // Total credit exposure: open invoice balances + committed-but-uninvoiced
        // orders + unbilled credit charges (not just open invoices).
        const currentOutstanding = await computeCreditExposure(db, customerId);
        const newOrderAmount = parseFloat(input.totalAmount ?? "0");

        const creditResult = checkCredit(
          {
            customer: creditCustomer
              ? {
                  id: creditCustomer.id,
                  isBlacklisted: creditCustomer.isBlacklisted,
                  blacklistReason: creditCustomer.blacklistReason ?? null,
                  creditLimit: creditCustomer.creditLimit ?? null,
                }
              : null,
            newOrderAmount,
            currentOutstanding,
          },
          override,
        );

        if (!creditResult.allowed) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: creditResult.message,
            cause: { code: creditResult.code },
          });
        }
      }

      // ─── Referral code resolution (same logic as public create) ──
      let referralCodeId: number | undefined;
      let referralDiscount: string | undefined;
      // Rent BEFORE the discount — referral commission is earned on list price.
      let referralBaseFee: number | undefined;
      let resolvedReferralCode: (typeof schema.referralCodes.$inferSelect) | undefined;
      let resolvedPromotion: (typeof schema.promotions.$inferSelect) | undefined;

      if (customerId && existingCustomer?.referralCodeId) {
        const [boundCode] = await db
          .select({ code: schema.referralCodes, promotion: schema.promotions })
          .from(schema.referralCodes)
          .innerJoin(schema.promotions, eq(schema.referralCodes.promotionId, schema.promotions.id))
          .where(and(eq(schema.referralCodes.id, existingCustomer.referralCodeId), eq(schema.referralCodes.isActive, true), isNull(schema.promotions.deletedAt)))
          .limit(1);
        if (boundCode) {
          const now = new Date();
          const promo = boundCode.promotion;
          if (promo.isActive && now >= promo.startDate && now <= promo.endDate) {
            resolvedReferralCode = boundCode.code;
            resolvedPromotion = promo;
            referralCodeId = boundCode.code.id;
          }
        }
      }

      if (!referralCodeId && input.referralCode) {
        const [rc] = await db
          .select({ code: schema.referralCodes, promotion: schema.promotions })
          .from(schema.referralCodes)
          .innerJoin(schema.promotions, eq(schema.referralCodes.promotionId, schema.promotions.id))
          .where(and(eq(schema.referralCodes.code, input.referralCode.toUpperCase()), eq(schema.referralCodes.isActive, true), isNull(schema.promotions.deletedAt)))
          .limit(1);
        if (rc) {
          const now = new Date();
          const promo = rc.promotion;
          if (promo.isActive && now >= promo.startDate && now <= promo.endDate) {
            if (!promo.maxUsesPerCode || rc.code.totalUses < promo.maxUsesPerCode) {
              resolvedReferralCode = rc.code;
              resolvedPromotion = rc.promotion;
              referralCodeId = rc.code.id;
              if (customerId && !existingCustomer?.referralCodeId) {
                await db.update(schema.customers).set({
                  referralCodeId: rc.code.id, referralBoundAt: new Date(), updatedAt: new Date(),
                }).where(eq(schema.customers.id, customerId));
              }
            }
          }
        }
      }

      if (referralCodeId && resolvedPromotion && input.rentalFee) {
        // This endpoint's input carries no taxBreakdown/pickupProvince field.
        const applied = await applyReferralDiscount({
          rentalFee: input.rentalFee,
          freightCost: input.freightCost,
          insuranceCost: input.insuranceCost,
          taxAmount: input.taxAmount,
          province: input.taxProvince ?? input.deliveryProvince ?? "ON",
          discountPercent: resolvedPromotion.discountPercent,
        });
        if (applied) {
          referralDiscount = applied.discount.toFixed(2);
          referralBaseFee = applied.baseFee;
          input.rentalFee = applied.rentalFee;
          input.taxAmount = applied.taxAmount;
          input.totalAmount = applied.totalAmount;
        }
      }

      // Insurance is required unless a detailed certificate is on file.
      if (input.insuranceType === "none" && !input.insuranceDocsReceived) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Insurance is required unless a customer insurance certificate is on file." });
      }

      const rentalNumber = await generateRentalNumber();

      const [result] = await db.insert(schema.rentalRequests).values({
        rentalNumber,
        rentalFleetId: assignedFleetId,
        equipmentModelId: input.equipmentModelId ?? null,
        customerId,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        customerPhone: input.customerPhone,
        customerCompany: input.customerCompany,
        equipmentDescription: input.equipmentDescription,
        startDate: parseCalendarDate(input.startDate),
        endDate: end,
        isCreditOrder,
        status: (input.status || "pending") as schema.RentalRequest["status"],
        deliveryMethod: input.deliveryMethod as schema.RentalRequest["deliveryMethod"],
        deliveryAddress: input.deliveryAddress,
        deliveryProvince: input.deliveryProvince,
        // Never persist a null taxProvince (see note above) — fall back to delivery province, else ON.
        taxProvince: input.taxProvince ?? input.deliveryProvince ?? "ON",
        insuranceType: input.insuranceType as schema.RentalRequest["insuranceType"],
        insuranceDocsReceived: input.insuranceDocsReceived ?? false,
        rentalFee: input.rentalFee,
        freightCost: input.freightCost,
        insuranceCost: input.insuranceCost,
        taxAmount: input.taxAmount,
        depositAmount: input.depositAmount,
        totalAmount: input.totalAmount,
        projectDescription: input.projectDescription,
        adminNotes: input.adminNotes,
        projectId: input.projectId ?? null,
        scheduledDeliveryTime: input.scheduledDeliveryTime,
        scheduledPickupTime: input.scheduledPickupTime,
        referralCodeId,
        referralDiscount,
        customerEquipmentNote: input.customerEquipmentNote,
        compatibilityAcknowledgedAt: input.compatibilityAcknowledgedAt ? new Date(input.compatibilityAcknowledgedAt) : undefined,
        financialOrderNumber: input.financialOrderNumber,
        cardLast4: input.cardLast4,
        priceMatchEnabled: input.priceMatchEnabled ?? false,
        priceMatchCompetitor: input.priceMatchCompetitor,
        priceMatchAmount: input.priceMatchAmount,
        priceMatchNote: input.priceMatchNote,
        customerDiscountPercent: input.customerDiscountPercent !== undefined
          ? String(input.customerDiscountPercent)
          : (existingCustomer?.discountPercent ?? undefined),
      }).returning();

      // Stage C dual-write: mirror this admin-created order into rental_line_items.
      if (result.rentalFleetId || input.equipmentModelId) {
        try {
          const modelId = input.equipmentModelId ?? null;
          let resolvedModelId: number | null = modelId;
          let itemType: "machine" | "attachment" = "machine";
          if (result.rentalFleetId) {
            // catalog_cache is the source of truth for equipment_type after 093.
            const [fm] = await db
              .select({
                equipmentModelId: schema.rentalFleet.equipmentModelId,
                equipmentType: schema.catalogCache.equipmentType,
              })
              .from(schema.rentalFleet)
              .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
              .where(and(eq(schema.rentalFleet.id, result.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
              .limit(1);
            if (fm) {
              resolvedModelId = resolvedModelId ?? fm.equipmentModelId;
              itemType = fm.equipmentType ?? "machine";
            }
          }
          // No fleet, only a model id → safe default of "machine". Attachments
          // are catalog-level; if admin didn't pick a fleet there's no catalog
          // pointer to consult.

          await db.insert(schema.rentalLineItems).values({
            rentalRequestId: result.id,
            rentalFleetId: result.rentalFleetId ?? null,
            equipmentModelId: resolvedModelId,
            itemType,
            quantity: 1,
            customerEquipmentNote: input.customerEquipmentNote,
            compatibilityAcknowledgedAt: input.compatibilityAcknowledgedAt ? new Date(input.compatibilityAcknowledgedAt) : null,
          });
        } catch (err) {
          logger.warn("[rentals.adminCreate] line_item mirror failed (non-fatal)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Write referral ledger entry
      if (referralCodeId && resolvedReferralCode && resolvedPromotion && input.rentalFee) {
        // List price, not the discounted rent now sitting in input.rentalFee —
        // the referrer earns on the booking, not on the customer's discount.
        const fee = referralBaseFee ?? parseFloat(input.rentalFee);
        if (!isNaN(fee) && fee > 0) {
          const discountPct = parseFloat(resolvedPromotion.discountPercent);
          const commissionPct = parseFloat(resolvedPromotion.commissionPercent);
          const discountAmt = Math.round(fee * discountPct) / 100;
          const commissionAmt = Math.round(fee * commissionPct) / 100;
          await db.insert(schema.referralLedger).values({
            referralCodeId,
            rentalRequestId: result.id,
            customerId: customerId || null,
            driverId: resolvedReferralCode.driverId,
            rentalFee: fee.toFixed(2),
            discountAmount: discountAmt.toFixed(2),
            commissionAmount: commissionAmt.toFixed(2),
          });
          await db.update(schema.referralCodes).set({
            totalUses: sql`${schema.referralCodes.totalUses} + 1`,
            totalCommission: sql`${schema.referralCodes.totalCommission}::numeric + ${commissionAmt}`,
          }).where(eq(schema.referralCodes.id, referralCodeId));
        }
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "rental",
        entityId: result.id,
        metadata: { customerName: input.customerName, source: "admin" },
        ipAddress: ctx.req?.ip,
      });

      // Refresh customer counters
      if (customerId) {
        await refreshCustomerCounters(customerId);
      }

      return result;
    }),

  // Admin multi-equipment order: one rental_requests row + N rental_line_items,
  // the back-office counterpart of the public createWithItems. Pricing comes from
  // the shared quoteMultiItem engine unless price-match is on, in which case the
  // admin-entered order-level money is used verbatim. Customer dedup goes through
  // resolveOrderCustomer (customerId precedence). Referral discounts are not
  // applied here (single-item adminCreate covers that promo flow).
  adminCreateWithItems: protectedProcedure.use(moduleGuard('rentals', 'create'))
    .input(z.object({
      customerId: z.number().optional(),
      customerDiscountPercent: z.number().min(0).max(100).optional(),
      customerName: z.string().min(1).max(255),
      customerEmail: z.string().email().max(255).optional(),
      customerPhone: z.string().max(50).optional(),
      customerCompany: z.string().max(255).optional(),
      startDate: z.string().max(30),
      endDate: z.string().max(30),
      status: z.enum(["pending", "approved", "rejected", "active", "completed", "cancelled", "overdue"]).optional(),
      deliveryMethod: z.enum(["pickup", "delivery", "delivery_and_return"]).optional(),
      deliveryAddress: z.string().max(1000).optional(),
      deliveryProvince: z.string().max(2).optional(),
      taxProvince: z.string().max(2).optional(),
      insuranceType: z.enum(["none", "basic", "full"]).optional(),
      insuranceDocsReceived: z.boolean().optional(),
      projectDescription: z.string().max(5000).optional(),
      adminNotes: z.string().max(5000).optional(),
      projectId: z.number().optional(),
      scheduledDeliveryTime: z.string().max(5).optional(),
      scheduledPickupTime: z.string().max(5).optional(),
      financialOrderNumber: z.string().max(40).optional(),
      cardLast4: z.string().max(4).optional(),
      creditOverride: z.boolean().optional(),
      // Price match (order-level manual override) — same fields as adminCreate.
      priceMatchEnabled: z.boolean().optional(),
      priceMatchCompetitor: z.string().max(255).optional(),
      priceMatchAmount: zMoneyOptional(),
      priceMatchNote: z.string().max(2000).optional(),
      rentalFee: zMoneyOptional(),
      freightCost: zMoneyOptional(),
      insuranceCost: zMoneyOptional(),
      taxAmount: zMoneyOptional(),
      depositAmount: zMoneyOptional(),
      totalAmount: zMoneyOptional(),
      items: z.array(z.object({
        equipmentModelId: z.number().nullable(),
        availableFleetIds: z.array(z.number()),
        itemType: z.enum(["machine", "attachment"]),
        quantity: z.number().min(1).max(20),
        // Optional per-line rental period — lets one order hold equipment on
        // different dates. Falls back to the order's start/end when omitted.
        startDate: z.string().max(30).nullable().optional(),
        endDate: z.string().max(30).nullable().optional(),
        customerEquipmentNote: z.string().max(500).optional(),
      })).min(1).max(20),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { start, end } = validateDates(input.startDate, input.endDate);

      // Pick concrete fleet ids per item, checking availability for that line's
      // own dates (mirrors createWithItems).
      type Pick = { inputIndex: number; fleetId: number | null; equipmentModelId: number | null; itemType: "machine" | "attachment"; quantity: number; startDate: Date | null; endDate: Date | null; customerEquipmentNote?: string };
      const picks: Pick[] = [];
      const usedFleetIds = new Set<number>();
      for (let idx = 0; idx < input.items.length; idx++) {
        const item = input.items[idx];
        // Per-line dates: validate when given so a bad line date can't slip in.
        const hasLineDates = !!(item.startDate && item.endDate);
        const ls = hasLineDates ? validateDates(item.startDate!, item.endDate!).start : start;
        const le = hasLineDates ? validateDates(item.startDate!, item.endDate!).end : end;
        const candidates = item.availableFleetIds.filter(id => !usedFleetIds.has(id));
        const chosen: number[] = [];
        for (const fid of candidates) {
          if (chosen.length >= item.quantity) break;
          const av = await checkDateRangeAvailability(fid, ls, le);
          if (av.isAvailable) { chosen.push(fid); usedFleetIds.add(fid); }
        }
        if (chosen.length < item.quantity && candidates.length > 0) {
          throw new TRPCError({ code: "CONFLICT", message: "Not enough units available for an item for the selected dates" });
        }
        const lineStart = hasLineDates ? ls : null;
        const lineEnd = hasLineDates ? le : null;
        if (chosen.length === 0) {
          if (item.itemType !== "attachment") {
            throw new TRPCError({ code: "BAD_REQUEST", message: "No fleet candidates available for a machine item" });
          }
          picks.push({ inputIndex: idx, fleetId: null, equipmentModelId: item.equipmentModelId, itemType: item.itemType, quantity: item.quantity, startDate: lineStart, endDate: lineEnd, customerEquipmentNote: item.customerEquipmentNote });
        } else {
          for (const fid of chosen) {
            picks.push({ inputIndex: idx, fleetId: fid, equipmentModelId: item.equipmentModelId, itemType: item.itemType, quantity: 1, startDate: lineStart, endDate: lineEnd, customerEquipmentNote: item.customerEquipmentNote });
          }
        }
      }

      // Find or create customer (customerId-precedence dedup).
      const { customerId, existingCustomer } = await resolveOrderCustomer(db, input);

      // Compute pricing from the shared engine.
      const { quoteMultiItem } = await import("../services/multiItemPricing");
      const quote = await quoteMultiItem(db, {
        startDate: input.startDate,
        endDate: input.endDate,
        deliveryMethod: (input.deliveryMethod || "pickup") as "pickup" | "delivery" | "delivery_and_return",
        deliveryAddress: input.deliveryAddress,
        // Same fallback chain as the taxProvince we persist below — a bare
        // input.taxProvince is usually undefined (the admin form only sends
        // deliveryProvince), which made the quote engine skip tax entirely.
        taxProvince: input.taxProvince ?? input.deliveryProvince ?? "ON",
        insuranceType: input.insuranceType,
        customerId,
        items: input.items.map(i => ({
          equipmentModelId: i.equipmentModelId,
          fleetIds: i.availableFleetIds,
          itemType: i.itemType,
          quantity: i.quantity,
          startDate: i.startDate ?? null,
          endDate: i.endDate ?? null,
        })),
      });

      // ERP guards: manual override must record a reason; otherwise a machine
      // with no configured rate must not be booked for $0.
      if (input.priceMatchEnabled === true) {
        if (!input.priceMatchNote || !input.priceMatchNote.trim()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "覆盖价格必须填写原因。" });
        }
      } else if (quote.hasUnpricedMachine) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "该型号未设费率,请先在『分类定价/型号』设置后再下单。" });
      }

      // Order-level money: price-match override wins, else the quote.
      const usePM = input.priceMatchEnabled === true;
      const money = usePM
        ? {
            rentalFee: input.rentalFee ?? quote.rentalFee.toFixed(2),
            freightCost: input.freightCost ?? quote.freightCost.toFixed(2),
            insuranceCost: input.insuranceCost ?? quote.insuranceCost.toFixed(2),
            taxAmount: input.taxAmount ?? quote.taxAmount.toFixed(2),
            depositAmount: input.depositAmount ?? quote.depositAmount.toFixed(2),
            totalAmount: input.totalAmount ?? quote.totalAmount.toFixed(2),
            taxBreakdown: null as string | null,
          }
        : {
            rentalFee: quote.rentalFee.toFixed(2),
            freightCost: quote.freightCost.toFixed(2),
            insuranceCost: quote.insuranceCost.toFixed(2),
            taxAmount: quote.taxAmount.toFixed(2),
            depositAmount: quote.depositAmount.toFixed(2),
            totalAmount: quote.totalAmount.toFixed(2),
            taxBreakdown: quote.taxBreakdown,
          };

      // Which money components did the admin override vs the system quote? Record
      // them so the badge can say "freight $335 → $285" (see shared/priceOverride).
      const priceMatchFields = usePM
        ? computeOverrideFields(
            {
              rentalFee: quote.rentalFee.toFixed(2),
              freightCost: quote.freightCost.toFixed(2),
              insuranceCost: quote.insuranceCost.toFixed(2),
              taxAmount: quote.taxAmount.toFixed(2),
              depositAmount: quote.depositAmount.toFixed(2),
              totalAmount: quote.totalAmount.toFixed(2),
            },
            money,
          )
        : null;
      // Freight is only an unverified estimate if it wasn't manually corrected.
      const freightEstimated = (quote.freightEstimated ?? false) && !priceMatchFields?.freightCost;

      // ─── Credit enforcement (gated by credit_limit feature flag) ──────
      if (await isFeatureEnabled("credit_limit")) {
        const isSuperAdmin = ctx.user?.role === "super_admin";
        const override = isSuperAdmin && input.creditOverride === true;
        let creditCustomer: schema.Customer | undefined = existingCustomer;
        if (!creditCustomer) {
          const [loaded] = await db.select().from(schema.customers)
            .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt))).limit(1);
          creditCustomer = loaded;
        }
        // Total credit exposure: open invoice balances + committed-but-uninvoiced
        // orders + unbilled credit charges (not just open invoices).
        const currentOutstanding = await computeCreditExposure(db, customerId);
        const creditResult = checkCredit(
          {
            customer: creditCustomer ? {
              id: creditCustomer.id,
              isBlacklisted: creditCustomer.isBlacklisted,
              blacklistReason: creditCustomer.blacklistReason ?? null,
              creditLimit: creditCustomer.creditLimit ?? null,
            } : null,
            newOrderAmount: parseFloat(money.totalAmount ?? "0"),
            currentOutstanding,
          },
          override,
        );
        if (!creditResult.allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: creditResult.message, cause: { code: creditResult.code } });
        }
      }

      const rentalNumber = await generateRentalNumber();
      const firstPick = picks[0];
      const isSingleLineOrder = picks.length === 1;

      // Insurance is required unless a detailed certificate is on file.
      if (input.insuranceType === "none" && !input.insuranceDocsReceived) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Insurance is required unless a customer insurance certificate is on file." });
      }

      const result = await db.transaction(async (tx) => {
        const [r] = await tx.insert(schema.rentalRequests).values({
          rentalNumber,
          rentalFleetId: isSingleLineOrder ? firstPick.fleetId : null,
          equipmentModelId: isSingleLineOrder ? firstPick.equipmentModelId : null,
          customerId,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          customerCompany: input.customerCompany,
          startDate: parseCalendarDate(input.startDate),
          endDate: end,
          status: (input.status || "pending") as schema.RentalRequest["status"],
          deliveryMethod: input.deliveryMethod as schema.RentalRequest["deliveryMethod"],
          deliveryAddress: input.deliveryAddress,
          deliveryProvince: input.deliveryProvince,
          // Never persist a null taxProvince (see note above) — fall back to delivery province, else ON.
          taxProvince: input.taxProvince ?? input.deliveryProvince ?? "ON",
          insuranceType: input.insuranceType as schema.RentalRequest["insuranceType"],
          insuranceDocsReceived: input.insuranceDocsReceived ?? false,
          rentalFee: money.rentalFee,
          freightCost: money.freightCost,
          insuranceCost: money.insuranceCost,
          taxAmount: money.taxAmount,
          taxBreakdown: money.taxBreakdown,
          depositAmount: money.depositAmount,
          totalAmount: money.totalAmount,
          deliveryDistanceKm: quote.deliveryDistanceKm != null ? quote.deliveryDistanceKm.toFixed(2) : undefined,
          projectDescription: input.projectDescription,
          adminNotes: input.adminNotes,
          projectId: input.projectId ?? null,
          scheduledDeliveryTime: input.scheduledDeliveryTime,
          scheduledPickupTime: input.scheduledPickupTime,
          financialOrderNumber: input.financialOrderNumber,
          cardLast4: input.cardLast4,
          priceMatchEnabled: usePM,
          priceMatchCompetitor: input.priceMatchCompetitor,
          priceMatchAmount: input.priceMatchAmount,
          priceMatchNote: input.priceMatchNote,
          priceMatchFields: priceMatchFields ?? undefined,
          freightEstimated,
          customerDiscountPercent: input.customerDiscountPercent !== undefined
            ? String(input.customerDiscountPercent)
            : (existingCustomer?.discountPercent ?? undefined),
        }).returning();

        await tx.insert(schema.rentalLineItems).values(picks.map(p => {
          const ql = quote.perLine[p.inputIndex];
          const parentQty = input.items[p.inputIndex].quantity || 1;
          const lineSubtotal = ql ? ql.lineSubtotal / parentQty * p.quantity : 0;
          const lineDeposit = ql ? ql.lineDeposit / parentQty * p.quantity : 0;
          return {
            rentalRequestId: r.id,
            rentalFleetId: p.fleetId,
            equipmentModelId: p.equipmentModelId,
            itemType: p.itemType,
            quantity: p.quantity,
            startDate: p.startDate,
            endDate: p.endDate,
            dailyRate: ql ? ql.dailyRate.toFixed(2) : undefined,
            weeklyRate: ql ? ql.weeklyRate.toFixed(2) : undefined,
            monthlyRate: ql ? ql.monthlyRate.toFixed(2) : undefined,
            lineSubtotal: lineSubtotal.toFixed(2),
            lineDeposit: lineDeposit.toFixed(2),
            customerEquipmentNote: p.customerEquipmentNote,
          };
        }));

        return r;
      });

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "rental",
        entityId: result.id,
        metadata: { customerName: input.customerName, source: "admin", items: picks.length },
        ipAddress: ctx.req?.ip,
      });

      if (customerId) await refreshCustomerCounters(customerId);

      return { rental: result, itemCount: picks.length };
    }),

  // Live quote preview for the cart-style checkout. Same engine the
  // createWithItems path uses to lock in pricing, so the customer sees
  // exactly what gets persisted at submit time.
  previewMultiItemQuote: publicProcedure
    .input(z.object({
      startDate: z.string(),
      endDate: z.string(),
      deliveryMethod: z.enum(["pickup", "delivery", "delivery_and_return"]),
      deliveryAddress: z.string().max(1000).optional(),
      taxProvince: z.string().max(2).optional(),
      insuranceType: z.enum(["none", "basic", "full"]).optional(),
      items: z.array(z.object({
        equipmentModelId: z.number().nullable(),
        fleetIds: z.array(z.number()),
        itemType: z.enum(["machine", "attachment"]),
        quantity: z.number().min(1).max(20),
        startDate: z.string().nullable().optional(),
        endDate: z.string().nullable().optional(),
      })).min(1).max(20),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const { quoteMultiItem } = await import("../services/multiItemPricing");
      return quoteMultiItem(db, input);
    }),

  // Cart-style multi-item submit (Stage C). One rental_request, N line items.
  // Line 0's fleet is also written to rental_requests.rentalFleetId so the
  // existing single-item readers (calendar, dispatch, contract PDF) keep
  // working unchanged. Stage C+1 will deprecate the single-fleet pointer.
  createWithItems: publicProcedure
    .input(z.object({
      customerName: z.string().min(1).max(255),
      customerEmail: z.string().email().max(255).optional(),
      customerPhone: z.string().max(50).optional(),
      customerCompany: z.string().max(255).optional(),
      startDate: z.string().max(30),
      endDate: z.string().max(30),
      deliveryMethod: z.enum(["pickup", "delivery", "delivery_and_return"]).optional(),
      deliveryAddress: z.string().max(1000).optional(),
      deliveryProvince: z.string().max(2).optional(),
      pickupProvince: z.string().max(2).optional(),
      taxProvince: z.string().max(2).optional(),
      insuranceType: z.enum(["none", "basic", "full"]).optional(),
      projectDescription: z.string().max(5000).optional(),
      customerNotes: z.string().max(2000).optional(),
      referralCode: z.string().max(50).optional(),
      scheduledDeliveryTime: z.string().max(5).optional(),
      items: z.array(z.object({
        equipmentModelId: z.number().nullable(),
        availableFleetIds: z.array(z.number()),
        itemType: z.enum(["machine", "attachment"]),
        quantity: z.number().min(1).max(20),
        startDate: z.string().nullable().optional(),
        endDate: z.string().nullable().optional(),
        dailyRate: zMoneyOptional(),
        weeklyRate: zMoneyOptional(),
        monthlyRate: zMoneyOptional(),
        customerEquipmentNote: z.string().max(500).optional(),
        compatibilityAcknowledgedAt: z.string().max(40).optional(),
      })).min(1).max(20),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { start, end } = validateDates(input.startDate, input.endDate);

      // Pick concrete fleet IDs from each item's pool, checking availability.
      // Each pick references its parent input item via inputIndex so we can
      // look up the per-unit pricing from the quote engine below.
      type Pick = { inputIndex: number; fleetId: number | null; equipmentModelId: number | null; itemType: "machine" | "attachment"; quantity: number; startDate?: Date | null; endDate?: Date | null; dailyRate?: string; weeklyRate?: string; monthlyRate?: string; customerEquipmentNote?: string; compatibilityAcknowledgedAt?: string };
      const picks: Pick[] = [];
      const usedFleetIds = new Set<number>();
      for (let idx = 0; idx < input.items.length; idx++) {
        const item = input.items[idx];
        const ls = item.startDate ? new Date(item.startDate) : start;
        const le = item.endDate ? new Date(item.endDate) : end;
        const candidates = item.availableFleetIds.filter(id => !usedFleetIds.has(id));
        const want = Math.min(item.quantity, candidates.length || item.quantity);
        const chosen: number[] = [];
        for (const fid of candidates) {
          if (chosen.length >= want) break;
          const av = await checkDateRangeAvailability(fid, ls, le);
          if (av.isAvailable) {
            chosen.push(fid);
            usedFleetIds.add(fid);
          }
        }
        if (chosen.length < item.quantity && candidates.length > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Not enough units available for an item in the cart for the selected dates`,
          });
        }
        if (chosen.length === 0) {
          if (item.itemType !== "attachment") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "No fleet candidates available for a machine item",
            });
          }
          picks.push({
            inputIndex: idx,
            fleetId: null,
            equipmentModelId: item.equipmentModelId,
            itemType: item.itemType,
            quantity: item.quantity,
            startDate: item.startDate ? ls : null,
            endDate: item.endDate ? le : null,
            dailyRate: item.dailyRate,
            weeklyRate: item.weeklyRate,
            monthlyRate: item.monthlyRate,
            customerEquipmentNote: item.customerEquipmentNote,
            compatibilityAcknowledgedAt: item.compatibilityAcknowledgedAt,
          });
        } else {
          for (const fid of chosen) {
            picks.push({
              inputIndex: idx,
              fleetId: fid,
              equipmentModelId: item.equipmentModelId,
              itemType: item.itemType,
              quantity: 1,
              startDate: item.startDate ? ls : null,
              endDate: item.endDate ? le : null,
              dailyRate: item.dailyRate,
              weeklyRate: item.weeklyRate,
              monthlyRate: item.monthlyRate,
              customerEquipmentNote: item.customerEquipmentNote,
              compatibilityAcknowledgedAt: item.compatibilityAcknowledgedAt,
            });
          }
        }
      }

      // Find or create customer FIRST so we can pass customerId to the quote
      // engine — it lets resolveCustomerPricing apply VIP/contract discounts.
      let customerId: number | undefined;
      if (input.customerEmail) {
        const [existing] = await db
          .select()
          .from(schema.customers)
          .where(and(eq(schema.customers.email, input.customerEmail), isNull(schema.customers.deletedAt)))
          .limit(1);
        if (existing) {
          customerId = existing.id;
          await db.update(schema.customers).set({
            name: input.customerName,
            phone: input.customerPhone,
            company: input.customerCompany,
            updatedAt: new Date(),
          }).where(eq(schema.customers.id, existing.id));
        } else {
          const [created] = await db.insert(schema.customers).values({
            name: input.customerName,
            email: input.customerEmail,
            phone: input.customerPhone,
            company: input.customerCompany,
            source: "website",
          }).returning();
          customerId = created.id;
        }
      }

      // Compute the quote — same engine the customer-facing preview uses.
      // Persist the totals on rental_requests + per-line subtotals on
      // rental_line_items so what the customer saw is what gets recorded.
      const { quoteMultiItem } = await import("../services/multiItemPricing");
      const quote = await quoteMultiItem(db, {
        startDate: input.startDate,
        endDate: input.endDate,
        deliveryMethod: (input.deliveryMethod || "pickup") as "pickup" | "delivery" | "delivery_and_return",
        deliveryAddress: input.deliveryAddress,
        // Same fallback chain as the persisted taxProvince — undefined here
        // silently produced a $0 tax quote.
        taxProvince: input.taxProvince ?? input.deliveryProvince ?? input.pickupProvince ?? "ON",
        insuranceType: input.insuranceType,
        customerId,
        items: input.items.map(i => ({
          equipmentModelId: i.equipmentModelId,
          fleetIds: i.availableFleetIds,
          itemType: i.itemType,
          quantity: i.quantity,
          startDate: i.startDate ?? null,
          endDate: i.endDate ?? null,
        })),
      });

      const rentalNumber = await generateRentalNumber();
      const firstPick = picks[0];
      // Single-line orders keep populating the legacy rental_requests.rentalFleetId
      // pointer so the dispatch / inspection / display joins keep working.
      // Multi-line orders set it to null — line_items is the source of truth.
      const isSingleLineOrder = picks.length === 1;

      // Wrap rental_requests + line_items in one transaction so partial
      // failure rolls back. Previously a line_items failure left an orphan
      // rental row.
      const result = await db.transaction(async (tx) => {
        const [r] = await tx.insert(schema.rentalRequests).values({
          rentalNumber,
          rentalFleetId: isSingleLineOrder ? firstPick.fleetId : null,
          equipmentModelId: isSingleLineOrder ? firstPick.equipmentModelId : null,
          customerId,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          customerCompany: input.customerCompany,
          startDate: parseCalendarDate(input.startDate),
          endDate: parseCalendarDate(input.endDate),
          deliveryMethod: input.deliveryMethod as schema.RentalRequest["deliveryMethod"],
          deliveryAddress: input.deliveryAddress,
          deliveryProvince: input.deliveryProvince,
          pickupProvince: input.pickupProvince,
          // Never persist a null taxProvince (see note above) — fall back to province, else ON.
          taxProvince: input.taxProvince ?? input.deliveryProvince ?? input.pickupProvince ?? "ON",
          insuranceType: input.insuranceType as schema.RentalRequest["insuranceType"],
          projectDescription: input.projectDescription,
          customerNotes: input.customerNotes,
          scheduledDeliveryTime: input.scheduledDeliveryTime,
          customerEquipmentNote: firstPick.customerEquipmentNote,
          compatibilityAcknowledgedAt: firstPick.compatibilityAcknowledgedAt ? new Date(firstPick.compatibilityAcknowledgedAt) : undefined,
          rentalFee: quote.rentalFee.toFixed(2),
          freightCost: quote.freightCost.toFixed(2),
          insuranceCost: quote.insuranceCost.toFixed(2),
          taxAmount: quote.taxAmount.toFixed(2),
          taxBreakdown: quote.taxBreakdown,
          depositAmount: quote.depositAmount.toFixed(2),
          totalAmount: quote.totalAmount.toFixed(2),
          deliveryDistanceKm: quote.deliveryDistanceKm != null ? quote.deliveryDistanceKm.toFixed(2) : undefined,
          freightEstimated: quote.freightEstimated ?? false,
        }).returning();

        await tx.insert(schema.rentalLineItems).values(picks.map(p => {
          const ql = quote.perLine[p.inputIndex];
          const parentQty = input.items[p.inputIndex].quantity || 1;
          const lineSubtotal = ql ? ql.lineSubtotal / parentQty * p.quantity : 0;
          const lineDeposit = ql ? ql.lineDeposit / parentQty * p.quantity : 0;
          return {
            rentalRequestId: r.id,
            rentalFleetId: p.fleetId,
            equipmentModelId: p.equipmentModelId,
            itemType: p.itemType,
            quantity: p.quantity,
            startDate: p.startDate ?? null,
            endDate: p.endDate ?? null,
            dailyRate: ql ? ql.dailyRate.toFixed(2) : p.dailyRate,
            weeklyRate: ql ? ql.weeklyRate.toFixed(2) : p.weeklyRate,
            monthlyRate: ql ? ql.monthlyRate.toFixed(2) : p.monthlyRate,
            lineSubtotal: lineSubtotal.toFixed(2),
            lineDeposit: lineDeposit.toFixed(2),
            customerEquipmentNote: p.customerEquipmentNote,
            compatibilityAcknowledgedAt: p.compatibilityAcknowledgedAt ? new Date(p.compatibilityAcknowledgedAt) : null,
          };
        }));

        return r;
      });

      if (customerId) await refreshCustomerCounters(customerId);

      try {
        const { notifyNewRentalRequest } = await import("../services/smsNotify");
        await notifyNewRentalRequest(input.customerName, result.id, result.rentalNumber, result.totalAmount);
      } catch { /* notification is best-effort */ }

      return { rental: result, itemCount: picks.length };
    }),

  // Read all line items for a rental order (Stage C). Until the cart UX
  // ships, every order has exactly one line item per migration 091 backfill.
  getLineItems: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({ rentalRequestId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select({
          line: schema.rentalLineItems,
          fleet: schema.rentalFleet,
          model: schema.equipmentModels,
        })
        .from(schema.rentalLineItems)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalLineItems.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.equipmentModels, and(eq(schema.rentalLineItems.equipmentModelId, schema.equipmentModels.id), isNull(schema.equipmentModels.deletedAt)))
        .where(and(
          eq(schema.rentalLineItems.rentalRequestId, input.rentalRequestId),
          isNull(schema.rentalLineItems.deletedAt),
        ))
        .orderBy(schema.rentalLineItems.id);
    }),

  checkAvailability: publicProcedure
    .input(z.object({
      // Single-unit check (legacy)
      rentalFleetId: z.number().optional(),
      // Whole-group check — returns isAvailable=true as long as any unit in the
      // pool is free for the date range. The customer-facing rent flow passes
      // the same fleetIdPool that drives the calendar.
      rentalFleetIds: z.array(z.number()).optional(),
      startDate: z.string(),
      endDate: z.string(),
    }).refine(v => !!v.rentalFleetId || (v.rentalFleetIds && v.rentalFleetIds.length > 0), {
      message: "Either rentalFleetId or rentalFleetIds is required",
    }))
    .query(async ({ input }) => {
      const start = parseCalendarDate(input.startDate);
      const end = parseCalendarDate(input.endDate);
      const ids = input.rentalFleetIds && input.rentalFleetIds.length > 0
        ? input.rentalFleetIds
        : (input.rentalFleetId ? [input.rentalFleetId] : []);

      // Check each unit; group is available if ANY unit is.
      const results = await Promise.all(
        ids.map(id => checkDateRangeAvailability(id, start, end)),
      );
      const anyAvailable = results.some(r => r.isAvailable);
      // Surface conflicts only when the whole group is taken — otherwise
      // the customer doesn't need to see them (system will pick the free one).
      const allConflicts = anyAvailable
        ? []
        : results.flatMap(r => r.conflictingRentals);
      return {
        isAvailable: anyAvailable,
        conflictingRentals: allConflicts,
        availableUnitCount: results.filter(r => r.isAvailable).length,
        totalUnitsChecked: ids.length,
      };
    }),

  modelAvailability: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({
      equipmentModelId: z.number(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      rentalFleetId: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const parseDate = (s: string | undefined): Date | undefined => {
        if (!s) return undefined;
        const d = new Date(s);
        return isNaN(d.getTime()) ? undefined : d;
      };
      try {
        const { getModelAvailability } = await import("../services/assetAssignment");
        return await getModelAvailability(
          input.equipmentModelId,
          parseDate(input.startDate),
          parseDate(input.endDate),
          input.rentalFleetId,
        );
      } catch (err) {
        const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
        logger.error("[modelAvailability] Failed", {
          input,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          cause: cause instanceof Error
            ? { message: cause.message, code: (cause as Error & { code?: string }).code }
            : cause,
        });
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to check availability" });
      }
    }),

  updateStatus: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      id: z.number(),
      status: z.enum(["pending", "approved", "rejected", "active", "completed", "cancelled", "overdue"]),
      adminNotes: z.string().optional(),
      // Acknowledges that the customer is returning equipment before endDate.
      // Required when marking a rental as completed while endDate is in the future.
      earlyReturn: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const r = await transitionRentalStatus(db, {
        rentalId: input.id,
        targetStatus: input.status,
        adminNotes: input.adminNotes,
        earlyReturn: input.earlyReturn,
        actor: { id: ctx.user?.id, ip: ctx.req?.ip },
      });
      return r;
    }),

  // Preview price changes when dates are modified (admin)
  previewDateChange: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({
      id: z.number(),
      startDate: z.string().max(30),
      endDate: z.string().max(30),
    }))
    .query(async ({ input }) => {
      const start = parseCalendarDate(input.startDate);
      const end = parseCalendarDate(input.endDate);
      if (start >= end) throw new TRPCError({ code: "BAD_REQUEST", message: "Start date must be before end date" });
      return recalculateRentalPricing(input.id, start, end);
    }),

  update: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      id: z.number(),
      totalAmount: zMoneyOptional(),
      depositAmount: zMoneyOptional(),
      rentalFee: zMoneyOptional(),
      freightCost: zMoneyOptional(),
      insuranceCost: zMoneyOptional(),
      taxAmount: zMoneyOptional(),
      adminNotes: z.string().max(5000).optional(),
      deliveryAddress: z.string().max(1000).optional(),
      startDate: z.string().max(30).optional(),
      endDate: z.string().max(30).optional(),
      recalculatePricing: z.boolean().optional(),
      insuranceDocsReceived: z.boolean().optional(),
      // Security-deposit collection status. This is the ONLY business entry point
      // that flips depositPaid — it drives the deposit-liability report and the
      // customer-portal deposit balance, both of which only count collected
      // deposits (depositPaid = true). Toggled from the rental detail (pricing tab).
      depositPaid: z.boolean().optional(),
      financialOrderNumber: z.string().max(40).optional(),
      cardLast4: z.string().max(4).optional(),
      // Reason for the edit. Mandatory (enforced below) when changing money on an
      // already-invoiced order — kept flexible (not blocked) but always traceable.
      editReason: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Fetch current values for audit diff
      const [existing] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.id), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      const { id, startDate, endDate, recalculatePricing, editReason, ...data } = input;

      // Unsettled credit (挂账) orders are open-ended with a TBD amount: block
      // direct endDate edits and price recalculation — both belong to the
      // close-out flow (finalizeCreditOrder), not ad-hoc edits.
      if (existing?.isCreditOrder && !existing.creditFinalizedAt) {
        if (endDate || recalculatePricing) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Credit order is open-ended — set the end date and amount via close-out (收箱结算), not direct edit.",
          });
        }
      }

      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (startDate) updateData.startDate = new Date(startDate);
      if (endDate) updateData.endDate = new Date(endDate);

      // Cross-validate dates when either is updated
      if (startDate || endDate) {
        const effectiveStart = startDate ? new Date(startDate) : existing?.startDate;
        const effectiveEnd = endDate ? new Date(endDate) : existing?.endDate;
        if (effectiveStart && effectiveEnd && effectiveStart >= effectiveEnd) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Start date must be before end date" });
        }

        // Auto-recalculate pricing when dates change and flag is set
        if (recalculatePricing && existing) {
          try {
            const recalc = await recalculateRentalPricing(
              id,
              effectiveStart!,
              effectiveEnd!,
            );
            updateData.rentalFee = recalc.new.rentalFee.toFixed(2);
            updateData.insuranceCost = recalc.new.insuranceCost.toFixed(2);
            updateData.taxAmount = recalc.new.taxAmount.toFixed(2);
            updateData.taxBreakdown = recalc.new.taxBreakdown;
            updateData.totalAmount = recalc.new.totalAmount.toFixed(2);
          } catch (err) {
            logger.error("[RentalRequests] Price recalculation failed", { rentalId: id, error: err });
            // Don't block the date update if recalculation fails
          }
        }
      }

      // Detect whether this edit actually changes any money field (manual edit
      // or recalculation), so invoiced orders stay flexible but traceable.
      const moneyFields = ["totalAmount", "depositAmount", "rentalFee", "freightCost", "insuranceCost", "taxAmount"] as const;
      const moneyWillChange = moneyFields.some((f) =>
        updateData[f] !== undefined && String(updateData[f]) !== String(existing?.[f] ?? ""),
      );

      // Is there a live (non-cancelled) rental invoice? If so, money edits are not
      // blocked, but require a reason and are recorded as a post-invoice edit.
      const [activeInvoice] = existing
        ? await db
            .select({ invoiceNumber: schema.invoices.invoiceNumber })
            .from(schema.invoices)
            .where(and(
              eq(schema.invoices.rentalId, id),
              eq(schema.invoices.type, "rental"),
              ne(schema.invoices.status, "cancelled"),
              isNull(schema.invoices.deletedAt),
            ))
            .limit(1)
        : [];
      const invoiceNumber = activeInvoice?.invoiceNumber;
      const postInvoiceEdit = !!invoiceNumber && moneyWillChange;
      // System price is authoritative. A MANUAL money change (not an auto
      // recalculation to the system value) requires a recorded reason — for every
      // order, not only invoiced ones.
      const manualMoneyChange = moneyWillChange && !recalculatePricing;
      if (manualMoneyChange && !editReason?.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: postInvoiceEdit
            ? `此订单已开票(${invoiceNumber}),修改金额必须填写原因。`
            : `修改价格需开启 Override 并填写原因。`,
        });
      }
      // Persistently mark the order as a manual override (+ reason) so it's labeled
      // everywhere; an auto-recalc back to the system value clears the flag.
      if (manualMoneyChange) {
        updateData.priceMatchEnabled = true;
        if (editReason?.trim()) updateData.priceMatchNote = editReason.trim();
        // Record WHICH money components changed (system value → entered) so the
        // override badge is explicit. Compare each edited field against `existing`.
        const computed: Record<string, string | null> = {};
        const final: Record<string, string | null | undefined> = {};
        for (const f of PRICE_OVERRIDE_FIELDS) {
          computed[f] = (existing?.[f] as string | null) ?? null;
          final[f] = updateData[f] as string | null | undefined;
        }
        const pmf = computeOverrideFields(computed, final);
        if (pmf) updateData.priceMatchFields = pmf;
        // Editing freight to a real value resolves the "estimated" state.
        if (pmf?.freightCost) updateData.freightEstimated = false;
      } else if (recalculatePricing && moneyWillChange) {
        updateData.priceMatchEnabled = false;
        updateData.priceMatchFields = null;
      }

      const [result] = await db
        .update(schema.rentalRequests)
        .set(updateData)
        .where(eq(schema.rentalRequests.id, id))
        .returning();

      // Audit log: pricing/detail edits
      if (existing) {
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        const fieldsToTrack = ["totalAmount", "depositAmount", "rentalFee", "freightCost", "insuranceCost", "taxAmount", "adminNotes", "deliveryAddress", "startDate", "endDate", "depositPaid"] as const;
        for (const field of fieldsToTrack) {
          const newVal = updateData[field] !== undefined ? updateData[field] : input[field as keyof typeof input];
          if (newVal !== undefined && String(newVal) !== String(existing[field] ?? "")) {
            changes[field] = { old: existing[field], new: newVal };
          }
        }
        // Give the deposit-collection toggle its own audit verb so the trail reads
        // clearly ("deposit_collected" / "deposit_uncollected") instead of a generic
        // "update". Only when the deposit flag is the change and no money was edited.
        const depositToggled = changes.depositPaid !== undefined && !manualMoneyChange && !postInvoiceEdit;
        if (Object.keys(changes).length > 0) {
          await logAudit({
            userId: ctx.user?.id,
            action: postInvoiceEdit ? "post_invoice_edit" : (manualMoneyChange ? "price_override" : (depositToggled ? (input.depositPaid ? "deposit_collected" : "deposit_uncollected") : "update")),
            entityType: "rental",
            entityId: id,
            changes,
            metadata: {
              customerName: existing.customerName,
              priceRecalculated: !!recalculatePricing,
              ...(invoiceNumber ? { invoiceNumber } : {}),
              ...(editReason?.trim() ? { reason: editReason.trim() } : {}),
            },
            ipAddress: ctx.req?.ip,
          });
        }
      }

      return result;
    }),

  // List eligible swap candidates for a rental: same model identity (NOT just
  // same category — category is free-text and frequently shared by distinct
  // models). Identity priority: equipmentModelId > catalogCacheId > brand+model.
  // Excludes deleted/retired units and any unit with a conflicting booking in
  // the rental's date range.
  listSwapCandidates: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({ rentalRequestId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rental: null, candidates: [] as Array<{ id: number; assetNumber: string | null; serialNumber: string | null; brand: string; model: string; category: string | null; year: number | null; currentStatus: string; }> };

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) return { rental: null, candidates: [] };

      // Resolve the OLD fleet's model identity. If the rental has no fleet
      // assigned, we can't determine identity → return empty.
      if (!rental.rentalFleetId) return { rental, candidates: [] };
      const [old] = await db
        .select({
          equipmentModelId: schema.rentalFleet.equipmentModelId,
          catalogCacheId: schema.rentalFleet.catalogCacheId,
          brand: schema.rentalFleet.brand,
          model: schema.rentalFleet.model,
        })
        .from(schema.rentalFleet)
        .where(and(eq(schema.rentalFleet.id, rental.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);
      if (!old) return { rental, candidates: [] };

      // Build the identity match — pick the strictest available signal.
      let identityCondition;
      if (old.equipmentModelId) {
        identityCondition = eq(schema.rentalFleet.equipmentModelId, old.equipmentModelId);
      } else if (old.catalogCacheId) {
        identityCondition = eq(schema.rentalFleet.catalogCacheId, old.catalogCacheId);
      } else if (old.brand && old.model) {
        identityCondition = and(
          eq(schema.rentalFleet.brand, old.brand),
          eq(schema.rentalFleet.model, old.model),
        );
      } else {
        // No reliable identity signal — refuse to surface candidates rather
        // than fall back to category and risk a wrong-model swap.
        return { rental, candidates: [] };
      }

      const conditions = [
        isNull(schema.rentalFleet.deletedAt),
        ne(schema.rentalFleet.currentStatus, "retired"),
        ne(schema.rentalFleet.id, rental.rentalFleetId),
        identityCondition,
      ];

      const fleet = await db
        .select({
          id: schema.rentalFleet.id,
          assetNumber: schema.rentalFleet.assetNumber,
          serialNumber: schema.rentalFleet.serialNumber,
          brand: schema.rentalFleet.brand,
          model: schema.rentalFleet.model,
          category: schema.rentalFleet.category,
          year: schema.rentalFleet.year,
          currentStatus: schema.rentalFleet.currentStatus,
        })
        .from(schema.rentalFleet)
        .where(and(...conditions))
        .orderBy(schema.rentalFleet.serialNumber);
      if (fleet.length === 0) return { rental, candidates: [] };

      // Find conflicts in one query (date overlap, active-ish status, excluding self).
      const fleetIds = fleet.map((f) => f.id);
      const conflicts = await db
        .select({ rentalFleetId: schema.rentalRequests.rentalFleetId })
        .from(schema.rentalRequests)
        .where(and(
          inArray(schema.rentalRequests.rentalFleetId, fleetIds),
          isNull(schema.rentalRequests.deletedAt),
          lte(schema.rentalRequests.startDate, rental.endDate),
          gte(schema.rentalRequests.endDate, rental.startDate),
          ne(schema.rentalRequests.id, rental.id),
          inArray(schema.rentalRequests.status, ["pending", "approved", "active", "overdue"]),
        ));
      const conflictedIds = new Set(conflicts.map((c) => c.rentalFleetId));

      // Only return units with no conflict — the UI never shows ineligible ones.
      const candidates = fleet.filter((f) => !conflictedIds.has(f.id));
      return { rental, candidates };
    }),

  // Reassign a rental to a different fleet asset of the same model identity.
  // Risk controls:
  //   - Allowed only when rental status is pending/approved (block in-progress / terminal states).
  //   - New asset must share identity with the old: same equipmentModelId, OR
  //     same catalogCacheId, OR same brand+model (in priority order). We do
  //     NOT match on category alone — it's free-text and groups distinct
  //     models (e.g. 19ft and 40ft scissor lifts).
  //   - Not deleted, not retired, and conflict-free for the date range.
  //   - Wrapped in a transaction; reason is required and logged.
  swapFleet: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      rentalRequestId: z.number(),
      newRentalFleetId: z.number(),
      reason: z.string().min(1).max(500),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      return await db.transaction(async (tx) => {
        const [rental] = await tx
          .select()
          .from(schema.rentalRequests)
          .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
          .limit(1);
        if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

        // Conservative: only allow swap before delivery. Active/overdue rentals
        // require physical-world workflow; terminal states are pointless.
        if (!["pending", "approved"].includes(rental.status)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Cannot swap asset on a ${rental.status} rental. Allowed only for pending/approved.`,
          });
        }

        if (rental.rentalFleetId === input.newRentalFleetId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "New asset is the same as the current one" });
        }

        const [newFleet] = await tx
          .select()
          .from(schema.rentalFleet)
          .where(and(eq(schema.rentalFleet.id, input.newRentalFleetId), isNull(schema.rentalFleet.deletedAt)))
          .limit(1);
        if (!newFleet) throw new TRPCError({ code: "NOT_FOUND", message: "New asset not found" });
        if (newFleet.currentStatus === "retired") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "New asset is retired" });
        }

        // Strict identity check. If the rental had no old fleet we refuse the
        // swap rather than allow an arbitrary assignment via this endpoint.
        if (!rental.rentalFleetId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Rental has no current asset assigned — use the standard assign flow instead of swap.",
          });
        }
        const [old] = await tx
          .select()
          .from(schema.rentalFleet)
          .where(and(eq(schema.rentalFleet.id, rental.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
          .limit(1);
        if (!old) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Current asset not found" });
        }

        // Identity match: equipmentModelId > catalogCacheId > brand+model.
        // Refuses null-on-both-sides as a match (would be a hidden bypass).
        let identityMatches = false;
        if (old.equipmentModelId && newFleet.equipmentModelId) {
          identityMatches = old.equipmentModelId === newFleet.equipmentModelId;
        } else if (old.catalogCacheId && newFleet.catalogCacheId) {
          identityMatches = old.catalogCacheId === newFleet.catalogCacheId;
        } else if (old.brand && old.model && newFleet.brand && newFleet.model) {
          identityMatches =
            old.brand.trim().toLowerCase() === newFleet.brand.trim().toLowerCase() &&
            old.model.trim().toLowerCase() === newFleet.model.trim().toLowerCase();
        }
        if (!identityMatches) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Models don't match: "${old.brand} ${old.model}" vs "${newFleet.brand} ${newFleet.model}"`,
          });
        }

        // Conflict check on new fleet for this rental's date range, excluding self.
        const conflicting = await tx
          .select({ id: schema.rentalRequests.id })
          .from(schema.rentalRequests)
          .where(and(
            eq(schema.rentalRequests.rentalFleetId, input.newRentalFleetId),
            isNull(schema.rentalRequests.deletedAt),
            lte(schema.rentalRequests.startDate, rental.endDate),
            gte(schema.rentalRequests.endDate, rental.startDate),
            ne(schema.rentalRequests.id, rental.id),
            inArray(schema.rentalRequests.status, ["pending", "approved", "active", "overdue"]),
          ));
        if (conflicting.length > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `New asset has ${conflicting.length} conflicting booking(s) for these dates`,
          });
        }

        // Swap the FK. We do NOT touch fleet currentStatus here — pending/approved
        // rentals don't lock the fleet (lock happens on dispatch).
        const [updated] = await tx
          .update(schema.rentalRequests)
          .set({ rentalFleetId: input.newRentalFleetId, updatedAt: new Date() })
          .where(eq(schema.rentalRequests.id, rental.id))
          .returning();

        await logAudit({
          userId: ctx.user?.id,
          action: "swap_fleet_asset",
          entityType: "rental",
          entityId: rental.id,
          changes: {
            rentalFleetId: { old: rental.rentalFleetId, new: input.newRentalFleetId },
          },
          metadata: {
            reason: input.reason,
            oldAsset: { id: old.id, assetNumber: old.assetNumber, brand: old.brand, model: old.model },
            newAsset: { id: newFleet.id, assetNumber: newFleet.assetNumber, brand: newFleet.brand, model: newFleet.model },
          },
          ipAddress: ctx.req?.ip,
        });

        return updated;
      });
    }),

  // Exchange the bin on an ACTIVE credit (挂账) order: swap to any asset
  // (different size/model allowed — price is expressed via the fee), record a
  // 'swap' charge, and re-point fleet occupancy. Distinct from swapFleet, which
  // is a pre-delivery same-model reassignment that never touches money.
  exchangeBin: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      rentalRequestId: z.number(),
      newRentalFleetId: z.number(),
      exchangeDate: z.string().max(30).optional(),
      fee: zMoneyOptional(),
      description: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      if (!rental.isCreditOrder) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a credit order" });
      if (rental.creditFinalizedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Credit order is already settled" });
      if (!["active", "overdue"].includes(rental.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Bin exchange is only allowed on active/overdue orders (got ${rental.status})` });
      }
      if (!rental.rentalFleetId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Rental has no current asset assigned" });
      }
      if (rental.rentalFleetId === input.newRentalFleetId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "New asset is the same as the current one" });
      }

      const [newFleet] = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(eq(schema.rentalFleet.id, input.newRentalFleetId), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);
      if (!newFleet) throw new TRPCError({ code: "NOT_FOUND", message: "New asset not found" });
      if (newFleet.currentStatus === "retired") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "New asset is retired" });
      }

      // The bin must be free for the rest of the open period (no model check —
      // any size is allowed). endDate is the open-ended sentinel.
      const exchangeDate = input.exchangeDate ? parseCalendarDate(input.exchangeDate) : new Date();
      const availability = await checkDateRangeAvailability(input.newRentalFleetId, exchangeDate, rental.endDate, rental.id);
      if (!availability.isAvailable) {
        throw new TRPCError({ code: "CONFLICT", message: "New asset is not available for the remaining period" });
      }

      const [old] = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(eq(schema.rentalFleet.id, rental.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);
      const oldFleetId = rental.rentalFleetId;
      const fee = input.fee ?? "0";

      const txResult = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(schema.rentalRequests)
          .set({ rentalFleetId: input.newRentalFleetId, updatedAt: new Date() })
          .where(eq(schema.rentalRequests.id, rental.id))
          .returning();

        // Keep the Stage-C line-item mirror's fleetId truthful (swapFleet skips
        // this; here it matters because the order is active and occupies a bin).
        await tx
          .update(schema.rentalLineItems)
          .set({ rentalFleetId: input.newRentalFleetId, updatedAt: new Date() })
          .where(and(
            eq(schema.rentalLineItems.rentalRequestId, rental.id),
            eq(schema.rentalLineItems.rentalFleetId, oldFleetId),
            isNull(schema.rentalLineItems.deletedAt),
          ));

        // Release old asset (rented → available) — but only if no OTHER active
        // order still claims it, so a swap can't strand a double-booked unit.
        // Claim new (available → rented).
        const oldStillClaimed = await tx.execute(sql`
          SELECT 1 FROM rental_requests r
          WHERE r."deletedAt" IS NULL AND r.status = 'active' AND r.id <> ${rental.id}
            AND ( r."rentalFleetId" = ${oldFleetId}
              OR EXISTS (SELECT 1 FROM rental_line_items li
                WHERE li."rentalRequestId" = r.id AND li."deletedAt" IS NULL AND li."rentalFleetId" = ${oldFleetId}) )
          LIMIT 1
        `);
        if (oldStillClaimed.length === 0) {
          await tx
            .update(schema.rentalFleet)
            .set({ currentStatus: "available", updatedAt: new Date() })
            .where(and(eq(schema.rentalFleet.id, oldFleetId), eq(schema.rentalFleet.currentStatus, "rented")));
        }
        await tx
          .update(schema.rentalFleet)
          .set({ currentStatus: "rented", updatedAt: new Date() })
          .where(and(eq(schema.rentalFleet.id, input.newRentalFleetId), eq(schema.rentalFleet.currentStatus, "available")));

        const [charge] = await tx
          .insert(schema.rentalCharges)
          .values({
            rentalRequestId: rental.id,
            chargeType: "swap",
            amount: fee,
            description: input.description,
            chargeDate: exchangeDate,
            oldRentalFleetId: oldFleetId,
            newRentalFleetId: input.newRentalFleetId,
            createdBy: ctx.user?.id,
          })
          .returning();

        return { updated, charge };
      });

      await logAudit({
        userId: ctx.user?.id,
        action: "bin_exchange",
        entityType: "rental",
        entityId: rental.id,
        changes: { rentalFleetId: { old: oldFleetId, new: input.newRentalFleetId } },
        metadata: {
          fee,
          oldAsset: old ? { id: old.id, assetNumber: old.assetNumber, brand: old.brand, model: old.model } : { id: oldFleetId },
          newAsset: { id: newFleet.id, assetNumber: newFleet.assetNumber, brand: newFleet.brand, model: newFleet.model },
        },
        ipAddress: ctx.req?.ip,
      });

      const creditWarning = await computeCreditWarning(rental.customerId);
      return { rental: txResult.updated, charge: txResult.charge, creditWarning };
    }),

  // Candidates for a MID-RENTAL swap (active/overdue, non-credit orders).
  // Unlike listSwapCandidates (pre-delivery, same-model only), the replacement
  // must be physically in the yard NOW (currentStatus=available) and free of
  // bookings for the remaining period; any model is allowed — same-model units
  // are flagged so the UI can group them first and show rate differences.
  listMidSwapCandidates: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({
      rentalRequestId: z.number(),
      oldRentalFleetId: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { current: null, candidates: [] };

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) return { current: null, candidates: [] };

      const oldFleetId = input.oldRentalFleetId ?? rental.rentalFleetId;
      if (!oldFleetId) return { current: null, candidates: [] };

      const { resolvePricing } = await import("../services/pricingResolution");

      const [old] = await db
        .select()
        .from(schema.rentalFleet)
        .leftJoin(schema.equipmentModels, and(
          eq(schema.rentalFleet.equipmentModelId, schema.equipmentModels.id),
          isNull(schema.equipmentModels.deletedAt),
        ))
        .where(and(eq(schema.rentalFleet.id, oldFleetId), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);
      if (!old) return { current: null, candidates: [] };
      const oldFleet = old.rental_fleet;

      // Only units parked in the yard right now qualify as replacements.
      const rows = await db
        .select()
        .from(schema.rentalFleet)
        .leftJoin(schema.equipmentModels, and(
          eq(schema.rentalFleet.equipmentModelId, schema.equipmentModels.id),
          isNull(schema.equipmentModels.deletedAt),
        ))
        .where(and(
          isNull(schema.rentalFleet.deletedAt),
          eq(schema.rentalFleet.currentStatus, "available"),
          ne(schema.rentalFleet.id, oldFleetId),
        ))
        .orderBy(schema.rentalFleet.serialNumber);

      // Booking conflicts for the remaining period — parent pointer AND line
      // items, statuses that hold or will hold the unit. Dates as ISO strings
      // (see lineItemOverlapWhere note: coalesce fragments lack a column encoder).
      const nowIso = new Date().toISOString();
      const endIso = rental.endDate.toISOString();
      const fleetIds = rows.map((r) => r.rental_fleet.id);
      const conflictedIds = new Set<number>();
      if (fleetIds.length > 0) {
        const pointerConflicts = await db
          .select({ fid: schema.rentalRequests.rentalFleetId })
          .from(schema.rentalRequests)
          .where(and(
            inArray(schema.rentalRequests.rentalFleetId, fleetIds),
            isNull(schema.rentalRequests.deletedAt),
            ne(schema.rentalRequests.id, rental.id),
            inArray(schema.rentalRequests.status, ["pending", "approved", "active", "overdue"]),
            sql`${schema.rentalRequests.startDate} <= ${endIso}`,
            sql`${schema.rentalRequests.endDate} >= ${nowIso}`,
          ));
        const lineConflicts = await db
          .select({ fid: schema.rentalLineItems.rentalFleetId })
          .from(schema.rentalLineItems)
          .innerJoin(schema.rentalRequests, eq(schema.rentalLineItems.rentalRequestId, schema.rentalRequests.id))
          .where(and(
            inArray(schema.rentalLineItems.rentalFleetId, fleetIds),
            isNull(schema.rentalLineItems.deletedAt),
            isNull(schema.rentalRequests.deletedAt),
            ne(schema.rentalRequests.id, rental.id),
            inArray(schema.rentalRequests.status, ["pending", "approved", "active", "overdue"]),
            sql`COALESCE(${schema.rentalLineItems.startDate}, ${schema.rentalRequests.startDate}) <= ${endIso}`,
            sql`COALESCE(${schema.rentalLineItems.endDate}, ${schema.rentalRequests.endDate}) >= ${nowIso}`,
          ));
        for (const c of [...pointerConflicts, ...lineConflicts]) {
          if (c.fid != null) conflictedIds.add(c.fid);
        }
      }

      const sameModelAs = (f: typeof oldFleet) => {
        if (oldFleet.equipmentModelId && f.equipmentModelId) return oldFleet.equipmentModelId === f.equipmentModelId;
        if (oldFleet.catalogCacheId && f.catalogCacheId) return oldFleet.catalogCacheId === f.catalogCacheId;
        if (oldFleet.brand && oldFleet.model && f.brand && f.model) {
          return oldFleet.brand.trim().toLowerCase() === f.brand.trim().toLowerCase()
            && oldFleet.model.trim().toLowerCase() === f.model.trim().toLowerCase();
        }
        return false;
      };

      const candidates = rows
        .filter((r) => !conflictedIds.has(r.rental_fleet.id))
        .map((r) => ({
          id: r.rental_fleet.id,
          assetNumber: r.rental_fleet.assetNumber,
          serialNumber: r.rental_fleet.serialNumber,
          brand: r.rental_fleet.brand,
          model: r.rental_fleet.model,
          category: r.rental_fleet.category,
          year: r.rental_fleet.year,
          sameModel: sameModelAs(r.rental_fleet),
          rates: resolvePricing(r.rental_fleet, r.equipment_models),
        }))
        .sort((a, b) => Number(b.sameModel) - Number(a.sameModel));

      return {
        current: {
          id: oldFleet.id,
          assetNumber: oldFleet.assetNumber,
          serialNumber: oldFleet.serialNumber,
          brand: oldFleet.brand,
          model: oldFleet.model,
          rates: resolvePricing(oldFleet, old.equipment_models),
        },
        candidates,
      };
    }),

  // Mid-rental swap: replace a unit that broke down (or must otherwise be
  // recalled) on an ACTIVE/OVERDUE non-credit order. The old unit goes to
  // maintenance, the replacement takes over the order; optionally records an
  // adjustment charge (damage_claims — merges into the order invoice with
  // tax), opens a repair work order on the old unit, and re-routes dispatch.
  // Credit orders keep using exchangeBin; pre-delivery orders use swapFleet.
  midRentalSwap: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      rentalRequestId: z.number(),
      oldRentalFleetId: z.number(),
      newRentalFleetId: z.number(),
      reasonType: z.enum(["equipment_fault", "customer_fault", "other"]),
      reason: z.string().min(1).max(1000),
      chargeAmount: zMoneyOptional(),
      chargeDescription: z.string().max(1000).optional(),
      createWorkOrder: z.boolean().optional(),
      workOrderPriority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      createDispatch: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!(await isFeatureEnabled("mid_rental_swap"))) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Mid-rental swap is not enabled (feature flag: mid_rental_swap)" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      if (rental.isCreditOrder) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Credit orders swap through bin exchange, not mid-rental swap" });
      }
      if (!["active", "overdue"].includes(rental.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Mid-rental swap is only allowed on active/overdue orders (got ${rental.status})` });
      }
      if (input.oldRentalFleetId === input.newRentalFleetId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "New asset is the same as the current one" });
      }

      // The old unit must actually be part of this order.
      const pointerMatch = rental.rentalFleetId === input.oldRentalFleetId;
      const [oldLine] = await db
        .select({ id: schema.rentalLineItems.id })
        .from(schema.rentalLineItems)
        .where(and(
          eq(schema.rentalLineItems.rentalRequestId, rental.id),
          eq(schema.rentalLineItems.rentalFleetId, input.oldRentalFleetId),
          isNull(schema.rentalLineItems.deletedAt),
        ))
        .limit(1);
      if (!pointerMatch && !oldLine) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The unit being replaced is not part of this order" });
      }

      const [oldFleet] = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(eq(schema.rentalFleet.id, input.oldRentalFleetId), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);
      if (!oldFleet) throw new TRPCError({ code: "NOT_FOUND", message: "Current asset not found" });

      const [newFleet] = await db
        .select()
        .from(schema.rentalFleet)
        .where(and(eq(schema.rentalFleet.id, input.newRentalFleetId), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);
      if (!newFleet) throw new TRPCError({ code: "NOT_FOUND", message: "New asset not found" });
      if (newFleet.currentStatus !== "available") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `New asset is not available (status: ${newFleet.currentStatus})` });
      }

      // Booking-free for the remaining period. checkDateRangeAvailability
      // covers pending/approved/active (pointer + line items); overdue orders
      // hold their unit regardless of dates, but those units are 'rented' and
      // already excluded by the availability status check above.
      const now = new Date();
      const availability = await checkDateRangeAvailability(input.newRentalFleetId, now, rental.endDate, rental.id);
      if (!availability.isAvailable) {
        throw new TRPCError({ code: "CONFLICT", message: "New asset is not available for the remaining rental period" });
      }

      const chargeAmount = input.chargeAmount && parseFloat(input.chargeAmount) > 0 ? input.chargeAmount : null;
      const workOrderNumber = input.createWorkOrder ? await (await import("../services/workOrderNumber")).getNextWorkOrderNumber() : null;
      const ref = rental.rentalNumber || `#${rental.id}`;
      const oldLabel = [oldFleet.brand, oldFleet.model, oldFleet.serialNumber].filter(Boolean).join(" ");
      const newLabel = [newFleet.brand, newFleet.model, newFleet.serialNumber].filter(Boolean).join(" ");

      const txResult = await db.transaction(async (tx) => {
        // 1. Parent pointer (single-asset orders keep it in sync; multi-item
        //    orders deliberately leave it NULL — see assignFleetAssetToRental).
        let updated = rental;
        if (pointerMatch) {
          [updated] = await tx
            .update(schema.rentalRequests)
            .set({
              rentalFleetId: input.newRentalFleetId,
              equipmentModelId: newFleet.equipmentModelId ?? rental.equipmentModelId,
              updatedAt: new Date(),
            })
            .where(eq(schema.rentalRequests.id, rental.id))
            .returning();
        }

        // 2. Line-item mirror — contracts, dispatch and the customer portal read this.
        await tx
          .update(schema.rentalLineItems)
          .set({
            rentalFleetId: input.newRentalFleetId,
            ...(newFleet.equipmentModelId ? { equipmentModelId: newFleet.equipmentModelId } : {}),
            updatedAt: new Date(),
          })
          .where(and(
            eq(schema.rentalLineItems.rentalRequestId, rental.id),
            eq(schema.rentalLineItems.rentalFleetId, input.oldRentalFleetId),
            isNull(schema.rentalLineItems.deletedAt),
          ));

        // 3. Claim the replacement (optimistic lock). Unlike exchangeBin we
        //    fail loudly when the claim misses — the whole swap rolls back.
        const claimed = await tx
          .update(schema.rentalFleet)
          .set({ currentStatus: "rented", updatedAt: new Date() })
          .where(and(eq(schema.rentalFleet.id, input.newRentalFleetId), eq(schema.rentalFleet.currentStatus, "available")))
          .returning({ id: schema.rentalFleet.id });
        if (claimed.length === 0) {
          throw new TRPCError({ code: "CONFLICT", message: "New asset was claimed by another operation — pick a different unit" });
        }

        // 4. The replaced unit goes to maintenance unconditionally — it broke.
        await tx
          .update(schema.rentalFleet)
          .set({ currentStatus: "maintenance", updatedAt: new Date() })
          .where(eq(schema.rentalFleet.id, input.oldRentalFleetId));

        // 5. Optional adjustment charge → damage_claims (accepted simple
        //    charge; merges into the order's invoice with provincial tax).
        let damageClaim: { id: number } | null = null;
        if (chargeAmount) {
          [damageClaim] = await tx
            .insert(schema.damageClaims)
            .values({
              rentalId: rental.id,
              customerId: rental.customerId ?? undefined,
              chargeType: "swap",
              description: input.chargeDescription || `Equipment swap adjustment (${ref}): ${oldLabel} → ${newLabel} — ${input.reason}`,
              amount: chargeAmount,
              approvedAmount: chargeAmount,
              status: "accepted",
              createdBy: ctx.user?.id,
            })
            .returning({ id: schema.damageClaims.id });
        }

        // 6. Optional repair work order on the OLD unit.
        let workOrder: { id: number } | null = null;
        if (workOrderNumber) {
          [workOrder] = await tx
            .insert(schema.workOrders)
            .values({
              workOrderNumber,
              rentalFleetId: input.oldRentalFleetId,
              damageClaimId: damageClaim?.id,
              type: "repair",
              priority: input.workOrderPriority ?? "high",
              status: "open",
              description: `[Mid-rental swap ${ref}] ${input.reasonType}: ${input.reason}`,
              createdBy: ctx.user?.id,
            })
            .returning({ id: schema.workOrders.id });
        }

        // 7. Dispatch: void not-yet-executed runs still pointing at the old
        //    unit (same pattern as order cancellation), then optionally create
        //    the two swap movements.
        await tx
          .update(schema.dispatchOrders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(and(
            eq(schema.dispatchOrders.rentalRequestId, rental.id),
            eq(schema.dispatchOrders.rentalFleetId, input.oldRentalFleetId),
            isNull(schema.dispatchOrders.deletedAt),
            inArray(schema.dispatchOrders.status, ["pending", "assigned"]),
          ));
        const dispatchIds: number[] = [];
        if (input.createDispatch) {
          const [pickup] = await tx.insert(schema.dispatchOrders).values({
            orderType: "pickup",
            confirmationToken: nanoid(32),
            rentalRequestId: rental.id,
            rentalFleetId: input.oldRentalFleetId,
            customerId: rental.customerId,
            scheduledDate: now,
            pickupAddress: rental.deliveryAddress,
            notes: `Mid-rental swap ${ref} — pick up replaced unit ${oldLabel}`,
          }).returning({ id: schema.dispatchOrders.id });
          const [delivery] = await tx.insert(schema.dispatchOrders).values({
            orderType: "delivery",
            confirmationToken: nanoid(32),
            rentalRequestId: rental.id,
            rentalFleetId: input.newRentalFleetId,
            customerId: rental.customerId,
            scheduledDate: now,
            deliveryAddress: rental.deliveryAddress,
            notes: `Mid-rental swap ${ref} — deliver replacement ${newLabel}`,
          }).returning({ id: schema.dispatchOrders.id });
          dispatchIds.push(pickup.id, delivery.id);
        }

        return { updated, damageClaimId: damageClaim?.id ?? null, workOrderId: workOrder?.id ?? null, dispatchIds };
      });

      await logAudit({
        userId: ctx.user?.id,
        action: "mid_rental_swap",
        entityType: "rental",
        entityId: rental.id,
        changes: { rentalFleetId: { old: input.oldRentalFleetId, new: input.newRentalFleetId } },
        metadata: {
          reasonType: input.reasonType,
          reason: input.reason,
          chargeAmount: chargeAmount ?? undefined,
          damageClaimId: txResult.damageClaimId ?? undefined,
          workOrderId: txResult.workOrderId ?? undefined,
          workOrderNumber: workOrderNumber ?? undefined,
          dispatchIds: txResult.dispatchIds,
          oldAsset: { id: oldFleet.id, assetNumber: oldFleet.assetNumber, brand: oldFleet.brand, model: oldFleet.model },
          newAsset: { id: newFleet.id, assetNumber: newFleet.assetNumber, brand: newFleet.brand, model: newFleet.model },
        },
        ipAddress: ctx.req?.ip,
      });

      // --- Post-transaction best-effort side effects ---
      const failures: { kind: string; message: string }[] = [];

      // Contract reflects the equipment — regenerate with the replacement
      // (signatures re-embedded as-is; swap is a fulfilment continuation).
      let contractRegenerated = false;
      if (rental.contractGenerated || rental.contractUrl) {
        try {
          await regenerateContractPdf(rental.id);
          contractRegenerated = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("[RentalRequests] Contract regeneration after swap failed", { rentalId: rental.id, error: message });
          failures.push({ kind: "contract", message });
        }
      }

      let creditWarning = null;
      if (chargeAmount && rental.customerId) {
        try {
          creditWarning = await computeCreditWarning(rental.customerId);
        } catch { /* advisory only */ }
      }

      return {
        rental: txResult.updated,
        damageClaimId: txResult.damageClaimId,
        workOrderId: txResult.workOrderId,
        workOrderNumber,
        dispatchCreated: txResult.dispatchIds.length,
        contractRegenerated,
        creditWarning,
        failures,
      };
    }),

  generateContract: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => regenerateContractPdf(input.id)),

  // Admin signs as the company representative; mirrors signContract flow
  // and re-generates the PDF with both signatures embedded.
  signAsRep: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      id: z.number(),
      signature: z.string().min(50, "Signature is required"),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(and(eq(schema.rentalRequests.id, input.id), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      const now = new Date();
      await db.update(schema.rentalRequests).set({
        repSignature: input.signature,
        repSignedAt: now,
        repSignedBy: ctx.user?.id ?? null,
        updatedAt: now,
      }).where(eq(schema.rentalRequests.id, input.id));

      // Re-generate PDF with both signatures
      try {
        const r = rental.rental_requests;
        const fleet = rental.rental_fleet;
        // Contract PDF "Duration" text only — DST-safe so it matches the billed term.
        const days = calculateDaysBetween(r.startDate, r.endDate);
        const { generateContractPDF } = await import("../services/contractPDF");
        const { url } = await generateContractPDF({
          rentalId: r.id,
          rentalNumber: r.rentalNumber,
          customerName: r.customerName,
          customerEmail: r.customerEmail || "",
          customerPhone: r.customerPhone || "",
          companyName: r.customerCompany || undefined,
          equipmentBrand: fleet?.brand || "",
          equipmentModel: fleet?.model || "",
          equipmentCategory: fleet?.category || "",
          startDate: r.startDate,
          endDate: r.endDate,
          rentalDays: days,
          rentalFee: r.rentalFee || "0",
          freightCost: r.freightCost || "0",
          insuranceCost: r.insuranceCost || "0",
          taxAmount: r.taxAmount || "0",
          depositAmount: r.depositAmount || "0",
          totalCost: r.totalAmount || "0",
          customerDiscountPercent: r.customerDiscountPercent,
          priceMatchEnabled: r.priceMatchEnabled,
          priceMatchCompetitor: r.priceMatchCompetitor,
          priceMatchAmount: r.priceMatchAmount,
          deliveryAddress: r.deliveryAddress || "Customer pickup",
          projectDescription: r.projectDescription || undefined,
          contractTemplateId: r.contractTemplateId ?? undefined,
          customerSignature: r.customerSignature,
          customerSignedAt: r.contractSignedAt,
          repSignature: input.signature,
          repSignedAt: now,
          items: await getContractLineItems(r.id),
        });

        await db.update(schema.rentalRequests).set({
          contractUrl: url,
          contractGenerated: true,
          contractGeneratedAt: now,
          contractVersion: (r.contractVersion || 0) + 1,
        }).where(eq(schema.rentalRequests.id, input.id));
      } catch (err) {
        logger.error("[rentals.signAsRep] PDF regen failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "rental",
        entityId: input.id,
        changes: { repSignedAt: { old: null, new: now.toISOString() } },
        metadata: { repSignature: true },
        ipAddress: ctx.req?.ip,
      });

      return { signedAt: now };
    }),

  // Record customer signature along with IP, user-agent, and contract hash
  signContract: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.id), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      const signedAt = new Date();
      const meta = extractClientMetadata(ctx.req as { ip?: string; headers?: Record<string, string | string[] | undefined> });

      // Hash the contract metadata as a minimal tamper-evident fingerprint
      const contractContent = JSON.stringify({
        rentalId: rental.id,
        totalAmount: rental.totalAmount,
        customerName: rental.customerName,
        signedAt: signedAt.toISOString(),
      });
      const contractHash = hashDocument(contractContent);

      await db.update(schema.rentalRequests).set({
        contractSignedAt: signedAt,
        signatureIp: meta.ip ?? undefined,
        signatureUserAgent: meta.userAgent ?? undefined,
        signatureContractHash: contractHash,
        updatedAt: signedAt,
      }).where(eq(schema.rentalRequests.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "rental",
        entityId: input.id,
        changes: { contractSignedAt: { old: null, new: signedAt.toISOString() } },
        metadata: { customerName: rental.customerName, signatureEvidence: true },
        ipAddress: ctx.req?.ip,
      });

      return { signedAt, contractHash };
    }),

  // Close-out: admin marks rental complete after return inspection.
  // Records final-billing intent (damage / overage / actual return date),
  // releases fleet, runs late-fee compute, sets status=completed.
  // The actual payment / deposit refund step is wired in when Stripe lands.
  closeRental: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      id: z.number(),
      actualReturnedAt: z.string().optional(),
      damageCharges: z.string().max(20).optional(),
      adminNotes: z.string().max(2000).optional(),
      // When true, admin acknowledges return inspection isn't on file but
      // still wants to close (e.g. customer returned to a different yard).
      skipInspectionCheck: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.id), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      if (input.skipInspectionCheck) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Use the per-equipment super-admin inspection bypass before closing this rental",
        });
      }
      if (!["active", "approved", "overdue"].includes(rental.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot close rental in status "${rental.status}"`,
        });
      }
      const now = new Date();
      const returnedAt = input.actualReturnedAt ? new Date(input.actualReturnedAt) : now;

      // Late-fee compute — surfaces accrued late fees so the close summary
      // can include them, but only when automatic late fees are enabled. A
      // disabled flag must mean both "not billed" and "not displayed".
      let accruedLateFee = 0;
      if (await isFeatureEnabled("late_fee_auto")) {
        try {
          const { computeLateFee, dailyBaseRateFromRental } = await import("../services/lateFee");
          const settings = await db.select().from(schema.rentalSettings);
          const map = new Map(settings.map(s => [s.key, s.value]));
          const dailyPct = parseFloat(map.get("late_fee_daily_rate_pct") || "150") / 100;
          const graceHours = parseInt(map.get("late_fee_grace_hours") || "24");
          const baseRate = dailyBaseRateFromRental(rental);
          const { lateFeeAmount } = computeLateFee({
            endDate: rental.endDate,
            actualReturnDate: returnedAt,
            dailyBaseRate: baseRate,
            settings: { lateFeeDailyRatePct: dailyPct * 100, lateFeeGraceHours: graceHours },
          });
          accruedLateFee = lateFeeAmount;
        } catch (err) {
          logger.warn("[closeRental] late fee compute failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      const combinedNotes = input.adminNotes
        ? (rental.adminNotes ? `${rental.adminNotes}\n\n[CLOSE]\n${input.adminNotes}` : input.adminNotes)
        : rental.adminNotes ?? undefined;
      const transition = await transitionRentalStatus(db, {
        rentalId: input.id,
        targetStatus: "completed",
        adminNotes: combinedNotes,
        earlyReturn: true,
        actualReturnDate: returnedAt,
        transitionedAt: now,
        auditAction: "close",
        auditMetadata: {
          actualReturnedAt: returnedAt.toISOString(),
          accruedLateFee,
          damageCharges: input.damageCharges,
          inspectionOverride: false,
        },
        actor: { id: ctx.user?.id, ip: ctx.req?.ip },
      });

      return {
        ok: true,
        accruedLateFee,
        damageCharges: parseFloat(input.damageCharges || "0"),
        depositAmount: parseFloat(rental.depositAmount || "0"),
        failures: transition.failures,
      };
    }),

  // Close out a credit (挂账) order: stamp the real end date over the sentinel,
  // optionally record a lump-sum final charge, summarize lifetime totals onto
  // the order, mark it settled, release the bin, and invoice any unbilled
  // balance. Mirrors closeRental but never touches the deposit and bills via the
  // charges ledger. Idempotent: a second call is rejected by creditFinalizedAt.
  finalizeCreditOrder: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      id: z.number(),
      actualEndDate: z.string().max(30),
      finalAmount: zMoneyOptional(),
      adminNotes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.id), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      if (!rental.isCreditOrder) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a credit order" });
      if (rental.creditFinalizedAt) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Credit order is already settled" });
      }
      if (!["active", "approved", "overdue"].includes(rental.status)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot settle a ${rental.status} order` });
      }
      const actualEnd = parseCalendarDate(input.actualEndDate);
      if (isNaN(actualEnd.getTime()) || actualEnd <= rental.startDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Actual end date must be after the start date" });
      }

      const now = new Date();
      const finalAmount = input.finalAmount && parseFloat(input.finalAmount) > 0 ? input.finalAmount : null;

      // Compute totals, settle the order, enqueue lifecycle effects, and win the
      // status CAS in one transaction. A concurrent second finalization rolls
      // back its tentative final charge with the lost CAS.
      const transition = await transitionRentalStatus(db, {
        rentalId: rental.id,
        targetStatus: "completed",
        earlyReturn: true,
        systemInspectionOverrideReason: "credit_order_finalization",
        actualReturnDate: actualEnd,
        transitionedAt: now,
        auditAction: "credit_finalize",
        auditMetadata: { actualEndDate: actualEnd.toISOString(), finalAmount },
        actor: { id: ctx.user?.id, ip: ctx.req?.ip },
        prepareCoreUpdate: async (tx, currentRental) => {
          if (finalAmount) {
            await tx.insert(schema.rentalCharges).values({
              rentalRequestId: currentRental.id,
              chargeType: "final",
              amount: finalAmount,
              description: "Final settlement",
              chargeDate: actualEnd,
              createdBy: ctx.user?.id,
            });
          }

          const [sumRow] = await tx
            .select({ total: sql<string>`coalesce(sum(${schema.rentalCharges.amount}::numeric), 0)` })
            .from(schema.rentalCharges)
            .where(and(
              eq(schema.rentalCharges.rentalRequestId, currentRental.id),
              isNull(schema.rentalCharges.deletedAt),
            ));
          const rentalFee = Math.round(parseFloat(sumRow?.total ?? "0") * 100) / 100;

          let taxAmount = 0;
          let taxBreakdown: string | null = currentRental.taxBreakdown ?? null;
          if (currentRental.taxProvince && rentalFee > 0) {
            try {
              const { calculateTax } = await import("../services/taxCalculation");
              const taxResult = await calculateTax({
                rentalAmount: rentalFee,
                shippingAmount: 0,
                ldwAmount: 0,
                depositAmount: 0,
                province: currentRental.taxProvince,
              });
              taxAmount = taxResult.totalTax;
              taxBreakdown = taxResult.taxBreakdown;
            } catch (err) {
              logger.warn("[finalizeCreditOrder] tax calc failed, using 0", { rentalId: currentRental.id, error: err });
            }
          }
          const totalAmount = Math.round((rentalFee + taxAmount) * 100) / 100;

          return {
            endDate: actualEnd, // overwrite the open-ended sentinel with the real date
            rentalFee: rentalFee.toFixed(2),
            taxAmount: taxAmount.toFixed(2),
            taxBreakdown,
            totalAmount: totalAmount.toFixed(2),
            creditFinalizedAt: now,
            creditFinalizedBy: ctx.user?.id,
            adminNotes: input.adminNotes
              ? (currentRental.adminNotes ? `${currentRental.adminNotes}\n\n[SETTLE]\n${input.adminNotes}` : input.adminNotes)
              : currentRental.adminNotes,
          };
        },
      });

      // Invoice any unbilled balance (zero-fee-only orders raise PRECONDITION
      // and are simply skipped — nothing to bill).
      let invoice: { invoiceId: number; invoiceNumber: string } | null = null;
      try {
        const { generateInvoiceFromCharges } = await import("../services/invoiceGenerator");
        invoice = await generateInvoiceFromCharges({ rentalId: rental.id, createdBy: ctx.user?.id });
        try {
          const { generateInvoicePDF } = await import("../services/invoicePDF");
          await generateInvoicePDF(invoice.invoiceId);
        } catch (err) {
          logger.error("[finalizeCreditOrder] Auto PDF failed after generateInvoiceFromCharges", {
            invoiceId: invoice.invoiceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err) {
        // "Nothing to bill" is the expected case for zero-fee orders and is
        // genuinely uneventful. Anything else — a database error, a tax lookup
        // failure — used to be logged at info under the same "no chargeable
        // balance" wording and forgotten, while the order had already reached a
        // terminal state that only a super_admin can reopen. The unbilled
        // charges then stayed in the database with no invoice they could ever
        // reach, and operationalHealth's no_invoice check skips credit orders
        // entirely, so nothing would have surfaced it.
        const expected = err instanceof TRPCError && err.code === "PRECONDITION_FAILED";
        if (expected) {
          logger.info("[finalizeCreditOrder] no chargeable balance to invoice", {
            rentalId: rental.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        } else {
          logger.error("[finalizeCreditOrder] Invoicing failed on a settled credit order — charges are now unbilled", {
            rentalId: rental.id,
            rentalNumber: rental.rentalNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { ok: true, invoice, failures: transition.failures };
    }),

  // Recovery path for "completed" rentals that were closed by mistake.
  // super_admin only — re-assigns fleet and flips status back to active.
  // We don't reverse invoice or notifications side-effects; staff handles those.
  reopen: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      id: z.number(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user?.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Super admin access required to reopen a completed rental." });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.id), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      if (rental.status !== "completed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Only completed rentals can be reopened (current status: "${rental.status}").`,
        });
      }

      const now = new Date();
      const reopenStamp = `[REOPEN ${now.toISOString()}] ${input.reason || "no reason provided"}`;
      const transition = await transitionRentalStatus(db, {
        rentalId: input.id,
        targetStatus: "active",
        adminNotes: rental.adminNotes ? `${rental.adminNotes}\n\n${reopenStamp}` : reopenStamp,
        transitionOverrideReason: "super_admin_reopen",
        transitionedAt: now,
        auditAction: "reopen",
        auditMetadata: { reason: input.reason },
        actor: { id: ctx.user?.id, ip: ctx.req?.ip },
      });

      return {
        ok: true,
        fleetReassignFailed: transition.failures.filter((failure) => failure.kind === "fleetSync"),
        failures: transition.failures,
      };
    }),

  delete: protectedProcedure.use(moduleGuard('rentals', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.id), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      if (rental.status !== "completed" && rental.status !== "cancelled") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Cannot delete active rental. Only completed or cancelled rentals can be deleted." });
      }

      await db.update(schema.rentalRequests).set({ deletedAt: new Date() }).where(eq(schema.rentalRequests.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "rental",
        entityId: input.id,
        metadata: { customerName: rental.customerName },
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  getStatusHistory: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({ rentalId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.auditLogs.id,
          action: schema.auditLogs.action,
          changes: schema.auditLogs.changes,
          metadata: schema.auditLogs.metadata,
          createdAt: schema.auditLogs.createdAt,
          userName: schema.users.name,
          userUsername: schema.users.username,
        })
        .from(schema.auditLogs)
        .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
        .where(and(
          eq(schema.auditLogs.entityType, "rental"),
          eq(schema.auditLogs.entityId, input.rentalId),
        ))
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(50);
    }),

  // Get all rentals for a specific customer
  getByCustomerId: protectedProcedure.use(moduleGuard('rentals', 'read'))
    .input(z.object({
      customerId: z.number(),
      limit: z.number().min(1).max(200).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.rentalRequests.id,
          status: schema.rentalRequests.status,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
          totalAmount: schema.rentalRequests.totalAmount,
          deliveryMethod: schema.rentalRequests.deliveryMethod,
          deliveryAddress: schema.rentalRequests.deliveryAddress,
          equipmentDescription: schema.rentalRequests.equipmentDescription,
          fleetBrand: schema.rentalFleet.brand,
          fleetModel: schema.rentalFleet.model,
          fleetCategory: schema.rentalFleet.category,
          createdAt: schema.rentalRequests.createdAt,
        })
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(and(
          eq(schema.rentalRequests.customerId, input.customerId),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(input.limit ?? 100);
    }),

  // Public: lookup rental by ID + email (for customer self-service)
  lookupByIdAndEmail: publicProcedure
    .input(z.object({
      // The customer only ever sees their rentalNumber (e.g. "20260701TH"), so
      // accept that as the primary identifier. A bare numeric string still works
      // (the post-order redirect passes the DB id) — we match either the
      // rentalNumber or, when the ref is all digits, the numeric id.
      orderRef: z.string().trim().min(1).max(40),
      email: z.string().email().max(255),
    }))
    .query(async ({ input, ctx }) => {
      const ip = ctx.req?.ip || "unknown";
      if (!checkRateLimit(customerLookupLimiter, ip, RL_WINDOW_MS, RL_LOOKUP_MAX)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many lookups. Please wait a few minutes and try again." });
      }

      const db = await getDb();
      if (!db) return null;

      const ref = input.orderRef.trim();
      const numericId = /^\d+$/.test(ref) ? Number(ref) : null;
      const refMatch = numericId !== null
        ? or(eq(schema.rentalRequests.rentalNumber, ref), eq(schema.rentalRequests.id, numericId))
        : eq(schema.rentalRequests.rentalNumber, ref);

      const [result] = await db
        .select({
          id: schema.rentalRequests.id,
          rentalNumber: schema.rentalRequests.rentalNumber,
          status: schema.rentalRequests.status,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
          totalAmount: schema.rentalRequests.totalAmount,
          rentalFee: schema.rentalRequests.rentalFee,
          freightCost: schema.rentalRequests.freightCost,
          insuranceCost: schema.rentalRequests.insuranceCost,
          taxAmount: schema.rentalRequests.taxAmount,
          depositAmount: schema.rentalRequests.depositAmount,
          deliveryMethod: schema.rentalRequests.deliveryMethod,
          deliveryAddress: schema.rentalRequests.deliveryAddress,
          insuranceType: schema.rentalRequests.insuranceType,
          customerName: schema.rentalRequests.customerName,
          customerEmail: schema.rentalRequests.customerEmail,
          customerPhone: schema.rentalRequests.customerPhone,
          customerNotes: schema.rentalRequests.customerNotes,
          paymentStatus: schema.rentalRequests.paymentStatus,
          contractUrl: schema.rentalRequests.contractUrl,
          fleetBrand: schema.rentalFleet.brand,
          fleetModel: schema.rentalFleet.model,
          fleetCategory: schema.rentalFleet.category,
          createdAt: schema.rentalRequests.createdAt,
        })
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(and(
          refMatch,
          eq(schema.rentalRequests.customerEmail, input.email),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .limit(1);

      return result || null;
    }),

  // Public: customer self-service update (only pending/approved orders)
  customerUpdate: publicProcedure
    .input(z.object({
      id: z.number(),
      email: z.string().email().max(255),
      startDate: z.string().max(30).optional(),
      endDate: z.string().max(30).optional(),
      deliveryAddress: z.string().max(1000).optional(),
      customerNotes: z.string().max(2000).optional(),
      customerPhone: z.string().max(50).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.req?.ip || "unknown";
      if (!checkRateLimit(customerMutationLimiter, ip, RL_WINDOW_MS, RL_MUTATION_MAX)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many requests. Please wait a few minutes and try again." });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Verify ownership
      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.id, input.id),
          eq(schema.rentalRequests.customerEmail, input.email),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });

      // Only allow modifications on pending/approved
      if (!["pending", "approved"].includes(rental.status)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Can only modify pending or approved orders" });
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };

      // Validate dates if changing
      let priceRecalculated = false;
      let changedStart: Date | undefined;
      let changedEnd: Date | undefined;
      if (input.startDate || input.endDate) {
        const start = input.startDate ? parseCalendarDate(input.startDate) : rental.startDate;
        const end = input.endDate ? parseCalendarDate(input.endDate) : rental.endDate;
        if (start >= end) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Start date must be before end date" });
        }

        // Re-check availability
        if (rental.rentalFleetId) {
          const availability = await checkDateRangeAvailability(rental.rentalFleetId, start, end, rental.id);
          if (!availability.isAvailable) {
            throw new TRPCError({ code: "CONFLICT", message: "Equipment not available for selected dates" });
          }
        }

        if (input.startDate) { updateData.startDate = start; changedStart = start; }
        if (input.endDate) { updateData.endDate = end; changedEnd = end; }

        // Auto-recalculate pricing for customer date changes
        try {
          const recalc = await recalculateRentalPricing(rental.id, start, end);
          updateData.rentalFee = recalc.new.rentalFee.toFixed(2);
          updateData.insuranceCost = recalc.new.insuranceCost.toFixed(2);
          updateData.taxAmount = recalc.new.taxAmount.toFixed(2);
          updateData.taxBreakdown = recalc.new.taxBreakdown;
          updateData.totalAmount = recalc.new.totalAmount.toFixed(2);
          priceRecalculated = true;
        } catch (err) {
          logger.error("[RentalRequests] Customer price recalculation failed", { rentalId: rental.id, error: err });
        }
      }

      if (input.deliveryAddress !== undefined) updateData.deliveryAddress = input.deliveryAddress;
      if (input.customerNotes !== undefined) updateData.customerNotes = input.customerNotes;
      if (input.customerPhone !== undefined) updateData.customerPhone = input.customerPhone;

      const [result] = await db
        .update(schema.rentalRequests)
        .set(updateData)
        .where(eq(schema.rentalRequests.id, input.id))
        .returning();

      // Keep outstanding dispatch orders aligned with the new dates so a driver
      // isn't sent on the old delivery/pickup day.
      if (changedStart || changedEnd) {
        try {
          const { syncDispatchScheduleDates } = await import("../services/rentalLineItemSync");
          await syncDispatchScheduleDates(db, input.id, { startDate: changedStart, endDate: changedEnd });
        } catch (err) {
          logger.error("[RentalRequests] customerUpdate dispatch sync failed", { rentalId: input.id, error: err });
        }
      }

      // Audit log
      const auditChanges: Record<string, { old: unknown; new: unknown }> = {
        source: { old: null, new: "customer_self_service" },
      };
      if (input.startDate) auditChanges.startDate = { old: rental.startDate, new: input.startDate };
      if (input.endDate) auditChanges.endDate = { old: rental.endDate, new: input.endDate };
      if (priceRecalculated) {
        auditChanges.rentalFee = { old: rental.rentalFee, new: updateData.rentalFee };
        auditChanges.totalAmount = { old: rental.totalAmount, new: updateData.totalAmount };
        auditChanges.priceRecalculated = { old: null, new: true };
      }
      await logAudit({
        action: "update",
        entityType: "rental",
        entityId: input.id,
        changes: auditChanges,
        metadata: { customerName: rental.customerName },
      });

      return result;
    }),

  batchUpdateStatus: protectedProcedure.use(moduleGuard('rentals', 'update'))
    .input(z.object({
      ids: z.array(z.number()).min(1).max(100),
      status: z.enum(["pending", "approved", "rejected", "active", "completed", "cancelled", "overdue"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const successIds: number[] = [];
      const failedIds: { id: number; reason: string }[] = [];
      const details: TransitionResult[] = [];

      // Each id runs through the SAME transitionRentalStatus domain service as
      // the single updateStatus entry point, in its own transaction, so a batch
      // approval/completion produces identical side effects (dispatch, contract,
      // quotation, invoice, fleet sync, counters, notifications) — not just a
      // bare status flip. A failure on one id doesn't abort the rest.
      for (const id of input.ids) {
        try {
          const r = await transitionRentalStatus(db, {
            rentalId: id,
            targetStatus: input.status,
            actor: { id: ctx.user?.id, ip: ctx.req?.ip },
          });
          successIds.push(id);
          details.push(r);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Unknown error";
          failedIds.push({ id, reason });
          logger.error("[rentalRequests.batchUpdateStatus] Failed for id", { id, reason });
        }
      }

      return { successIds, failedIds, details };
    }),

  duplicate: protectedProcedure.use(moduleGuard('rentals', 'create'))
    .input(z.object({
      sourceId: z.number(),
      newStartDate: z.string(),
      newEndDate: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // 1. Fetch source rental — must exist, not soft-deleted
      const [source] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.sourceId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Source rental not found" });
      }

      // 2. Verify source status allows duplication
      const duplicableStatuses = ["completed", "active", "cancelled"] as const;
      if (!duplicableStatuses.includes(source.status as typeof duplicableStatuses[number])) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot duplicate a rental with status "${source.status}". Only completed, active, or cancelled rentals may be duplicated.`,
        });
      }

      // 3. Validate new dates
      const { start: newStart, end: newEnd } = validateDates(input.newStartDate, input.newEndDate);

      // 4. Check availability for same fleet asset in new window; clear fleet if conflict
      let assignedFleetId: number | null = source.rentalFleetId ?? null;
      if (assignedFleetId) {
        const availability = await checkDateRangeAvailability(assignedFleetId, newStart, newEnd);
        if (!availability.isAvailable) {
          assignedFleetId = null;
        }
      }

      // 5. Price the NEW window. Copying the source's amounts verbatim onto a
      // different date range was simply wrong — a 7-day order duplicated into a
      // 14-day one kept the 7-day price. Reprice from the SOURCE order rather
      // than from the new row: recalculateRentalPricing compares the booked fee
      // against the list price of the term it reads from the database, which is
      // how a negotiated rate carries across a date change. Run against the new
      // row, its "old" term would already be the new dates and the negotiated
      // ratio would come out as 1 — quietly restoring the stale price.
      let duplicatePricing: {
        rentalFee: string; freightCost: string; insuranceCost: string;
        taxAmount: string; taxBreakdown: string; depositAmount: string; totalAmount: string;
      } | null = null;
      try {
        const priced = await recalculateRentalPricing(source.id, newStart, newEnd);
        duplicatePricing = {
          rentalFee: priced.new.rentalFee.toFixed(2),
          freightCost: priced.new.freightCost.toFixed(2),
          insuranceCost: priced.new.insuranceCost.toFixed(2),
          taxAmount: priced.new.taxAmount.toFixed(2),
          taxBreakdown: priced.new.taxBreakdown,
          depositAmount: priced.new.depositAmount.toFixed(2),
          totalAmount: priced.new.totalAmount.toFixed(2),
        };
      } catch (err) {
        // Fall back to the source amounts so the duplicate still gets created,
        // but never silently — a wrong price here becomes a wrong invoice.
        logger.error("[rentals.duplicate] Repricing failed, copying source amounts", {
          sourceRentalId: source.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // 6. Insert new row — clone customer/equipment, reset contract/payment/inspection
      const rentalNumber = await generateRentalNumber();

      const [newRental] = await db.insert(schema.rentalRequests).values({
        rentalNumber,
        customerId: source.customerId,
        customerName: source.customerName,
        customerEmail: source.customerEmail ?? undefined,
        customerPhone: source.customerPhone ?? undefined,
        customerCompany: source.customerCompany ?? undefined,
        equipmentModelId: source.equipmentModelId ?? null,
        rentalFleetId: assignedFleetId,
        equipmentDescription: source.equipmentDescription ?? undefined,
        startDate: newStart,
        endDate: newEnd,
        status: "pending",
        paymentStatus: "pending",
        rentalFee: duplicatePricing?.rentalFee ?? source.rentalFee ?? undefined,
        freightCost: duplicatePricing?.freightCost ?? source.freightCost ?? undefined,
        insuranceCost: duplicatePricing?.insuranceCost ?? source.insuranceCost ?? undefined,
        taxAmount: duplicatePricing?.taxAmount ?? source.taxAmount ?? undefined,
        taxBreakdown: duplicatePricing?.taxBreakdown ?? source.taxBreakdown ?? undefined,
        depositAmount: duplicatePricing?.depositAmount ?? source.depositAmount ?? undefined,
        totalAmount: duplicatePricing?.totalAmount ?? source.totalAmount ?? undefined,
        insuranceType: source.insuranceType ?? undefined,
        deliveryMethod: source.deliveryMethod ?? undefined,
        deliveryAddress: source.deliveryAddress ?? undefined,
        deliveryNotes: source.deliveryNotes ?? undefined,
        deliveryProvince: source.deliveryProvince ?? undefined,
        pickupProvince: source.pickupProvince ?? undefined,
        taxProvince: source.taxProvince ?? undefined,
        scheduledDeliveryTime: source.scheduledDeliveryTime ?? undefined,
        scheduledPickupTime: source.scheduledPickupTime ?? undefined,
        projectId: source.projectId ?? null,
        projectDescription: source.projectDescription ?? undefined,
        billingCycleType: source.billingCycleType ?? undefined,
        shiftType: source.shiftType ?? undefined,
        hireType: source.hireType ?? undefined,
        fuelPolicy: source.fuelPolicy ?? undefined,
        // Reset: contract, payment, signature, inspection state
        contractUrl: null,
        contractGenerated: false,
        contractGeneratedAt: null,
        contractSignedAt: null,
        orderConfirmationPdfUrl: null,
        stripePaymentIntentId: null,
        stripeCheckoutSessionId: null,
        depositPaid: false,
        insuranceDocsReceived: false,
        deliveryInspectionCompleted: false,
        returnInspectionCompleted: false,
        deliveryInspectionId: null,
        returnInspectionId: null,
      }).returning();

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "rental",
        entityId: newRental.id,
        metadata: {
          customerName: source.customerName,
          source: "duplicate",
          sourceRentalId: source.id,
          sourceRentalNumber: source.rentalNumber,
        },
        ipAddress: ctx.req?.ip,
      });

      return { id: newRental.id, rentalNumber: newRental.rentalNumber };
    }),

  // Renew = extend the existing rental in place (same rentalId, same fleet,
  // same customer). Pushes endDate out, recalculates pricing, issues a
  // supplemental invoice for the delta, generates a contract addendum, and
  // logs an approved extension request for audit.
  //
  // Does NOT create a new rental_requests row — earlier behavior chained
  // orders via parentRentalId; that diverged invoicing/contracts and made
  // pricing wrong (source amounts were copied verbatim regardless of new
  // duration). Old chained rows from before this change stay as-is.
  renew: protectedProcedure
    .input(z.object({
      sourceId: z.number(),
      // Either pick a new end date (preferred) or add N days (legacy).
      newEndDate: z.string().max(30).optional(),
      extensionDays: z.number().min(1).max(365).optional(),
      // Admin override: proceed even if the asset is booked in the window
      // (e.g. the admin will reassign the unit). Logged + audited.
      allowConflict: z.boolean().optional(),
    }).refine((v) => v.newEndDate != null || v.extensionDays != null, {
      message: "Provide a new end date or number of days",
    }))
    .use(moduleGuard('rentals', 'update'))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [source] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.sourceId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);

      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      }

      if (!["active", "completed", "approved", "overdue"].includes(source.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Only active, approved, overdue, or completed rentals can be renewed",
        });
      }

      // Add calendar days to the Toronto end date, then re-anchor to Toronto
      // midnight. Doing the arithmetic on a UTC-midnight scratch date keeps it
      // pure calendar math; parseCalendarDate re-samples the (DST-aware) offset
      // so an extension that crosses a DST boundary still lands on local midnight.
      const oldEndDate = new Date(source.endDate);
      const oldEndStr = calendarDateStringInTimeZone(oldEndDate);
      const oldEndUtc = Date.parse(`${oldEndStr}T00:00:00.000Z`);

      // Preferred path: admin picked a new end date. Legacy: add N days.
      let newEndDate: Date;
      let extensionDays: number;
      if (input.newEndDate) {
        newEndDate = parseCalendarDate(input.newEndDate);
        const newEndStr = calendarDateStringInTimeZone(newEndDate);
        const newEndUtc = Date.parse(`${newEndStr}T00:00:00.000Z`);
        extensionDays = Math.round((newEndUtc - oldEndUtc) / (1000 * 60 * 60 * 24));
        if (extensionDays < 1) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "New end date must be after the current end date" });
        }
        if (extensionDays > 365) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Renewal cannot exceed 365 days" });
        }
      } else {
        extensionDays = input.extensionDays!;
        const scratch = new Date(`${oldEndStr}T00:00:00.000Z`);
        scratch.setUTCDate(scratch.getUTCDate() + extensionDays);
        newEndDate = parseCalendarDate(scratch.toISOString().slice(0, 10));
      }

      // Cap cumulative renewals per rental to keep audit history sane.
      const existingExtensions = await db
        .select({ id: schema.extensionRequests.id })
        .from(schema.extensionRequests)
        .where(and(
          eq(schema.extensionRequests.rentalRequestId, source.id),
          eq(schema.extensionRequests.status, "approved"),
        ));
      if (existingExtensions.length >= 20) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Rental has reached the renewal limit (20). Open a new order instead.",
        });
      }

      // Block if the fleet is booked by another rental in the extension window.
      // Strict (lt/gt) boundaries so a back-to-back booking that ends exactly on
      // oldEnd, or starts exactly on newEnd, does NOT false-conflict. An admin can
      // override (allowConflict) when they will reassign the unit.
      if (source.rentalFleetId && !input.allowConflict) {
        const conflicts = await db
          .select({ id: schema.rentalRequests.id, rentalNumber: schema.rentalRequests.rentalNumber })
          .from(schema.rentalRequests)
          .where(and(
            eq(schema.rentalRequests.rentalFleetId, source.rentalFleetId),
            ne(schema.rentalRequests.id, source.id),
            isNull(schema.rentalRequests.deletedAt),
            inArray(schema.rentalRequests.status, ["approved", "active", "overdue"]),
            // overlap: existing.start < newEnd AND existing.end > oldEnd (strict)
            lt(schema.rentalRequests.startDate, newEndDate),
            gt(schema.rentalRequests.endDate, oldEndDate),
          ));
        if (conflicts.length > 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Cannot renew: fleet is booked by rental ${conflicts[0].rentalNumber ?? `#${conflicts[0].id}`} during the extension window. Reassign the unit or confirm the override to proceed.`,
          });
        }
      } else if (source.rentalFleetId && input.allowConflict) {
        logger.warn("[Renew] Admin overrode a fleet-conflict on renewal", { rentalId: source.id, fleetId: source.rentalFleetId, newEndDate });
      }

      // Recalculate pricing for the full new term. Falls back to a simple
      // pro-rata estimate if the calculator can't run (no fleet, etc.).
      let newRentalFee = parseFloat(source.rentalFee || "0");
      let newInsuranceCost = parseFloat(source.insuranceCost || "0");
      let newTaxAmount = parseFloat(source.taxAmount || "0");
      let newTaxBreakdown: string | null = source.taxBreakdown ?? null;
      let newTotalAmount = parseFloat(source.totalAmount || "0");
      let recalcUsed: "calculator" | "prorata" = "prorata";

      try {
        const recalc = await recalculateRentalPricing(source.id, source.startDate, newEndDate);
        newRentalFee = recalc.new.rentalFee;
        newInsuranceCost = recalc.new.insuranceCost;
        newTaxAmount = recalc.new.taxAmount;
        newTaxBreakdown = recalc.new.taxBreakdown;
        newTotalAmount = recalc.new.totalAmount;
        recalcUsed = "calculator";
      } catch (err) {
        // Pro-rata fallback: (oldDays + extensionDays) / oldDays * oldRentalFee
        const oldDays = Math.max(
          1,
          Math.ceil((oldEndDate.getTime() - source.startDate.getTime()) / (1000 * 60 * 60 * 24)),
        );
        const ratio = (oldDays + extensionDays) / oldDays;
        newRentalFee = +(parseFloat(source.rentalFee || "0") * ratio).toFixed(2);
        newInsuranceCost = +(parseFloat(source.insuranceCost || "0") * ratio).toFixed(2);
        const freight = parseFloat(source.freightCost || "0");
        // Tax must NOT scale with the day ratio — freight doesn't grow with
        // the term, so ratio-scaling the tax over-counts the freight tax
        // (#20260626TE). Recompute on the new base; province-rate lookup only
        // depends on the order, so it works for multi-item rentals too.
        const newTaxBase = newRentalFee + newInsuranceCost + freight;
        try {
          const { calculateTax } = await import("../services/taxCalculation");
          const taxRes = await calculateTax({
            rentalAmount: newTaxBase,
            shippingAmount: 0,
            ldwAmount: 0,
            depositAmount: 0,
            province: source.taxProvince || source.deliveryProvince || source.pickupProvince || "ON",
          });
          newTaxAmount = taxRes.totalTax;
          newTaxBreakdown = taxRes.taxBreakdown;
        } catch {
          // Last resort: scale the old tax by the change in its base.
          newTaxAmount = scaleTaxByBase(
            parseFloat(source.taxAmount || "0"),
            parseFloat(source.rentalFee || "0") + parseFloat(source.insuranceCost || "0") + freight,
            newTaxBase,
          );
        }
        newTotalAmount = +(newRentalFee + freight + newInsuranceCost + newTaxAmount).toFixed(2);
        logger.warn("[Renew] recalculateRentalPricing failed; used pro-rata fallback", {
          rentalId: source.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const oldRentalFee = parseFloat(source.rentalFee || "0");
      const oldInsuranceCost = parseFloat(source.insuranceCost || "0");
      const oldTaxAmount = parseFloat(source.taxAmount || "0");
      const oldTotalAmount = parseFloat(source.totalAmount || "0");
      const supplementAmount = +(newTotalAmount - oldTotalAmount).toFixed(2);

      // Non-positive supplement happens when the rental's totalAmount was
      // manually edited above the calculator's value, or when the old order
      // has no pricing data on record. We still allow the extension to go
      // through — admin can adjust pricing or issue a manual invoice
      // afterwards — but we skip auto-generating a supplement invoice.
      const skipSupplementInvoice = supplementAmount <= 0;
      if (skipSupplementInvoice) {
        logger.warn("[Renew] Non-positive supplement; extending rental without auto-invoice", {
          rentalId: source.id,
          oldTotalAmount,
          newTotalAmount,
          supplementAmount,
          recalcUsed,
        });
      }

      const newVersion = (source.contractVersion ?? 1) + 1;

      // Stage all DB writes in a transaction so a contract/invoice failure
      // doesn't leave the rental with a moved endDate but no supplement.
      const { extensionId, lineItemsUpdated } = await db.transaction(async (tx) => {
        // When the supplement is non-positive (manually-edited total or
        // missing pricing data) only push out the endDate and bump the
        // contract version — don't overwrite the existing price fields.
        const priceUpdates = skipSupplementInvoice
          ? {}
          : {
              rentalFee: newRentalFee.toFixed(2),
              insuranceCost: newInsuranceCost.toFixed(2),
              taxAmount: newTaxAmount.toFixed(2),
              taxBreakdown: newTaxBreakdown,
              totalAmount: newTotalAmount.toFixed(2),
            };

        await tx
          .update(schema.rentalRequests)
          .set({
            endDate: newEndDate,
            ...priceUpdates,
            contractVersion: newVersion,
            contractSignedAt: null,
            // Asset is already on-site (or returned then renewed); a delivery
            // inspection is not required again. Return inspection moves with
            // the new end date.
            returnInspectionCompleted: false,
            returnInspectionId: null,
            // If rental had been marked completed, renewal puts it back into active.
            status: source.status === "completed" ? "active" : source.status,
            updatedAt: new Date(),
          })
          .where(eq(schema.rentalRequests.id, source.id));

        const [ext] = await tx.insert(schema.extensionRequests).values({
          rentalRequestId: source.id,
          customerId: source.customerId,
          requestedEndDate: newEndDate,
          reason: `Admin renewal: +${extensionDays} day${extensionDays !== 1 ? "s" : ""}`,
          status: "approved",
          reviewedBy: ctx.user?.id,
          reviewedAt: new Date(),
          adminNotes: `Generated by rentals.renew (recalc=${recalcUsed})`,
        }).returning();

        const { extendLineItemEndDates, syncDispatchScheduleDates } = await import("../services/rentalLineItemSync");
        const txDb = tx as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>;
        const { updated } = await extendLineItemEndDates(
          txDb,
          source.id,
          oldEndDate,
          newEndDate,
        );

        // Push the outstanding return-pickup dispatch order to the new end date
        // so the driver doesn't arrive to collect equipment that's still rented.
        await syncDispatchScheduleDates(txDb, source.id, { endDate: newEndDate });

        return { extensionId: ext.id, lineItemsUpdated: updated };
      });

      // Side effects outside the transaction: invoice + contract addendum.
      // Both touch Supabase Storage / depend on side-effect-free DB reads,
      // and we want the renewal to succeed even if PDF generation hiccups.
      let supplementInvoiceNumber: string | null = null;
      let supplementInvoiceId: number | null = null;
      if (!skipSupplementInvoice) {
        try {
          const { generateRenewalSupplementInvoice } = await import("../services/invoiceGenerator");
          const result = await generateRenewalSupplementInvoice({
            rentalId: source.id,
            oldEndDate,
            newEndDate,
            oldRentalFee,
            newRentalFee,
            oldInsuranceCost,
            newInsuranceCost,
            oldTaxAmount,
            newTaxAmount,
            newTaxBreakdown,
            createdBy: ctx.user?.id,
          });
          supplementInvoiceNumber = result.invoiceNumber;
          supplementInvoiceId = result.invoiceId;
        } catch (err) {
          logger.error("[Renew] Supplement invoice generation failed (non-blocking)", {
            rentalId: source.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      let addendumUrl: string | null = null;
      try {
        const [fleet] = source.rentalFleetId
          ? await db.select().from(schema.rentalFleet)
              .where(and(eq(schema.rentalFleet.id, source.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
              .limit(1)
          : [null];
        const equipmentDesc = fleet
          ? `${fleet.brand} ${fleet.model}`
          : (source.equipmentDescription || "Equipment");

        const { generateRenewalAddendumPDF } = await import("../services/contractPDF");
        const previousContractUrl = source.contractUrl;
        // When skipping the invoice (manual override / missing pricing), the
        // addendum still notes the term extension but shows the existing
        // total and a $0 supplement to avoid confusing the customer.
        const effectiveSupplement = skipSupplementInvoice ? 0 : supplementAmount;
        const effectiveNewTotal = skipSupplementInvoice ? oldTotalAmount : newTotalAmount;
        const { url } = await generateRenewalAddendumPDF({
          rentalId: source.id,
          rentalNumber: source.rentalNumber,
          customerName: source.customerName,
          equipmentDescription: equipmentDesc,
          oldEndDate,
          newEndDate,
          extensionDays,
          supplementAmount: effectiveSupplement.toFixed(2),
          newTotalAmount: effectiveNewTotal.toFixed(2),
          newVersion,
        });
        addendumUrl = url;
        await db.update(schema.rentalRequests).set({
          contractUrl: url,
          contractGenerated: true,
          contractGeneratedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(schema.rentalRequests.id, source.id));

        await logAudit({
          userId: ctx.user?.id,
          action: "update",
          entityType: "rental",
          entityId: source.id,
          changes: {
            contractUrl: { old: previousContractUrl, new: url },
            contractVersion: { old: source.contractVersion, new: newVersion },
          },
          metadata: {
            source: "renewal_addendum",
            previousContractUrl,
          },
          ipAddress: ctx.req?.ip,
        });
      } catch (err) {
        logger.error("[Renew] Contract addendum generation failed (non-blocking)", {
          rentalId: source.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const auditedNewTotal = skipSupplementInvoice ? oldTotalAmount : newTotalAmount;
      const auditedNewRentalFee = skipSupplementInvoice ? oldRentalFee : newRentalFee;
      const auditedSupplement = skipSupplementInvoice ? 0 : supplementAmount;

      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "rental",
        entityId: source.id,
        changes: {
          endDate: { old: oldEndDate.toISOString(), new: newEndDate.toISOString() },
          totalAmount: { old: oldTotalAmount.toFixed(2), new: auditedNewTotal.toFixed(2) },
          rentalFee: { old: oldRentalFee.toFixed(2), new: auditedNewRentalFee.toFixed(2) },
          contractVersion: { old: source.contractVersion, new: newVersion },
        },
        metadata: {
          source: "renewal",
          extensionDays,
          extensionRequestId: extensionId,
          supplementInvoiceId,
          supplementInvoiceNumber,
          supplementAmount: auditedSupplement.toFixed(2),
          supplementSkipped: skipSupplementInvoice,
          lineItemsUpdated,
          recalcUsed,
          customerName: source.customerName,
          // Full pre-renewal snapshot for the undo path. Stored here (rather
          // than in a new column) so undoLastRenewal can revert every field
          // without a migration. addendumUrl gets backfilled by the addendum
          // audit row above, but we capture the prior contractUrl here too
          // so undo doesn't need to find that separate row.
          snapshotBefore: {
            endDate: oldEndDate.toISOString(),
            rentalFee: source.rentalFee,
            insuranceCost: source.insuranceCost,
            taxAmount: source.taxAmount,
            taxBreakdown: source.taxBreakdown,
            totalAmount: source.totalAmount,
            contractVersion: source.contractVersion,
            contractUrl: source.contractUrl,
            contractSignedAt: source.contractSignedAt ? source.contractSignedAt.toISOString() : null,
            contractGenerated: source.contractGenerated,
            contractGeneratedAt: source.contractGeneratedAt ? source.contractGeneratedAt.toISOString() : null,
            status: source.status,
            returnInspectionCompleted: source.returnInspectionCompleted,
            returnInspectionId: source.returnInspectionId,
          },
        },
        ipAddress: ctx.req?.ip,
      });

      return {
        id: source.id,
        rentalNumber: source.rentalNumber,
        newEndDate,
        extensionDays,
        supplementAmount: auditedSupplement.toFixed(2),
        newTotalAmount: auditedNewTotal.toFixed(2),
        supplementInvoiceNumber,
        supplementInvoiceId,
        addendumUrl,
        contractVersion: newVersion,
        supplementSkipped: skipSupplementInvoice,
      };
    }),

  // Undo the most recent renewal on this rental (stack-pop). Reads the
  // snapshotBefore stashed in the renewal's audit metadata and reverses
  // every field that renew touched: endDate, prices, contract version /
  // URL / signature, status, return-inspection flags, and line item end
  // dates. Cancels the extensionRequest (status="rejected") and
  // soft-deletes the supplement invoice — but refuses if that invoice
  // already has any payment recorded, since that would create a credit
  // situation the admin should resolve manually.
  undoLastRenewal: protectedProcedure
    .use(moduleGuard('rentals', 'update'))
    .input(z.object({
      rentalId: z.number(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      // Find the most recent renewal audit entry. Newer renewals carry a
      // full snapshotBefore in metadata; older ones (before snapshot was
      // added) only carry the `changes` diff — we fall back to that and
      // recover what we can.
      const renewalAudits = await db
        .select()
        .from(schema.auditLogs)
        .where(and(
          eq(schema.auditLogs.entityType, "rental"),
          eq(schema.auditLogs.entityId, input.rentalId),
        ))
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(50);

      let renewalAudit: (typeof renewalAudits)[number] | null = null;
      let snapshot: Record<string, unknown> | null = null;
      let meta: Record<string, unknown> | null = null;
      let changesObj: Record<string, { old: unknown; new: unknown }> | null = null;
      for (const a of renewalAudits) {
        if (!a.metadata) continue;
        try {
          const m = JSON.parse(a.metadata) as Record<string, unknown>;
          if (m.source !== "renewal") continue;
          renewalAudit = a;
          meta = m;
          snapshot = (m.snapshotBefore as Record<string, unknown>) ?? null;
          if (a.changes) {
            try {
              changesObj = JSON.parse(a.changes) as Record<string, { old: unknown; new: unknown }>;
            } catch {
              changesObj = null;
            }
          }
          break;
        } catch {
          // ignore corrupt rows
        }
      }

      if (!renewalAudit || !meta) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No undo-able renewal found on this rental",
        });
      }

      // Legacy fallback path. We extract whatever we can from `changes`;
      // unknown fields stay as they are on the rental (admin can fix in
      // the Pricing tab afterwards).
      if (!snapshot) {
        if (!changesObj || !changesObj.endDate?.old) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "This renewal predates the undo snapshot and has no recoverable diff. Adjust dates and prices manually.",
          });
        }
        snapshot = {
          endDate: changesObj.endDate.old,
          totalAmount: changesObj.totalAmount?.old ?? null,
          rentalFee: changesObj.rentalFee?.old ?? null,
          contractVersion: changesObj.contractVersion?.old ?? null,
          // unrecoverable from legacy renewals — keep current values
          insuranceCost: rental.insuranceCost,
          taxAmount: rental.taxAmount,
          taxBreakdown: rental.taxBreakdown,
          // contractUrl is in a separate "renewal_addendum" audit row
          contractUrl: rental.contractUrl,
          contractSignedAt: rental.contractSignedAt ? rental.contractSignedAt.toISOString() : null,
          contractGenerated: rental.contractGenerated,
          contractGeneratedAt: rental.contractGeneratedAt ? rental.contractGeneratedAt.toISOString() : null,
          status: rental.status,
          returnInspectionCompleted: rental.returnInspectionCompleted,
          returnInspectionId: rental.returnInspectionId,
        };

        // Try to pull contractUrl from the matching renewal_addendum row.
        // It will be the row recorded just after the renewal one.
        for (const a of renewalAudits) {
          if (!a.metadata) continue;
          if (a.createdAt < renewalAudit.createdAt) break;
          if (a.id === renewalAudit.id) continue;
          try {
            const m = JSON.parse(a.metadata) as Record<string, unknown>;
            if (m.source !== "renewal_addendum") continue;
            if (!a.changes) continue;
            const ch = JSON.parse(a.changes) as Record<string, { old: unknown; new: unknown }>;
            if (ch.contractUrl?.old !== undefined) {
              snapshot.contractUrl = ch.contractUrl.old;
            }
          } catch {
            // ignore
          }
        }

        logger.warn("[Renew.undo] Legacy renewal — partial undo via `changes` only", {
          rentalId: input.rentalId,
          auditId: renewalAudit.id,
        });
      }

      const extensionRequestId = (meta.extensionRequestId as number) ?? null;
      const supplementInvoiceId = (meta.supplementInvoiceId as number | null) ?? null;

      // Refuse if the supplement invoice has any payment.
      if (supplementInvoiceId) {
        const [inv] = await db
          .select()
          .from(schema.invoices)
          .where(and(eq(schema.invoices.id, supplementInvoiceId), isNull(schema.invoices.deletedAt)))
          .limit(1);
        if (inv && parseFloat(inv.amountPaid || "0") > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Cannot undo: supplement invoice ${inv.invoiceNumber} already has payments recorded ($${inv.amountPaid}). Refund and void the payment first.`,
          });
        }
      }

      // Parse snapshot fields with safe fallbacks.
      const restoredEndDate = new Date(snapshot.endDate as string);

      const restoreUpdates: Record<string, unknown> = {
        endDate: restoredEndDate,
        rentalFee: snapshot.rentalFee ?? null,
        insuranceCost: snapshot.insuranceCost ?? null,
        taxAmount: snapshot.taxAmount ?? null,
        taxBreakdown: snapshot.taxBreakdown ?? null,
        totalAmount: snapshot.totalAmount ?? null,
        contractVersion: snapshot.contractVersion ?? 1,
        contractUrl: snapshot.contractUrl ?? null,
        contractSignedAt: snapshot.contractSignedAt
          ? new Date(snapshot.contractSignedAt as string)
          : null,
        contractGenerated: snapshot.contractGenerated ?? false,
        contractGeneratedAt: snapshot.contractGeneratedAt
          ? new Date(snapshot.contractGeneratedAt as string)
          : null,
        status: snapshot.status as string,
        returnInspectionCompleted: snapshot.returnInspectionCompleted ?? false,
        returnInspectionId: snapshot.returnInspectionId ?? null,
        updatedAt: new Date(),
      };

      const currentEndDate = rental.endDate;

      await db.transaction(async (tx) => {
        await tx.update(schema.rentalRequests)
          .set(restoreUpdates)
          .where(eq(schema.rentalRequests.id, input.rentalId));

        // Roll line item end dates back. Mirror the renewal's behaviour:
        // only rewind lines whose endDate matches the current (post-renewal)
        // endDate, in case ops staggered any line.
        const lines = await tx
          .select({ id: schema.rentalLineItems.id, endDate: schema.rentalLineItems.endDate })
          .from(schema.rentalLineItems)
          .where(and(
            eq(schema.rentalLineItems.rentalRequestId, input.rentalId),
            isNull(schema.rentalLineItems.deletedAt),
          ));
        for (const line of lines) {
          if (!line.endDate) continue;
          if (line.endDate.getTime() !== currentEndDate.getTime()) continue;
          await tx.update(schema.rentalLineItems)
            .set({ endDate: restoredEndDate, updatedAt: new Date() })
            .where(eq(schema.rentalLineItems.id, line.id));
        }

        if (extensionRequestId) {
          await tx.update(schema.extensionRequests)
            .set({
              status: "rejected",
              adminNotes: `Undone by ${ctx.user?.email ?? "admin"} at ${new Date().toISOString()}${input.reason ? ` — ${input.reason}` : ""}`,
              updatedAt: new Date(),
            })
            .where(eq(schema.extensionRequests.id, extensionRequestId));
        }

        if (supplementInvoiceId) {
          await tx.update(schema.invoices)
            .set({
              status: "cancelled",
              deletedAt: new Date(),
              internalNotes: `Voided by renewal undo (by ${ctx.user?.email ?? "admin"})`,
              updatedAt: new Date(),
            })
            .where(eq(schema.invoices.id, supplementInvoiceId));
        }
      });

      await logAudit({
        userId: ctx.user?.id,
        action: "undo_renewal",
        entityType: "rental",
        entityId: input.rentalId,
        changes: {
          endDate: { old: currentEndDate.toISOString(), new: restoredEndDate.toISOString() },
          totalAmount: { old: rental.totalAmount, new: snapshot.totalAmount ?? null },
          contractVersion: { old: rental.contractVersion, new: snapshot.contractVersion ?? 1 },
          status: { old: rental.status, new: snapshot.status as string },
        },
        metadata: {
          source: "undo_renewal",
          reason: input.reason,
          undoneAuditId: renewalAudit.id,
          extensionRequestId,
          supplementInvoiceVoided: supplementInvoiceId,
          customerName: rental.customerName,
        },
        ipAddress: ctx.req?.ip,
      });

      return {
        ok: true,
        restoredEndDate,
        restoredTotalAmount: (snapshot.totalAmount as string | null) ?? null,
        supplementInvoiceVoided: !!supplementInvoiceId,
      };
    }),

  // Public: customer self-service cancellation
  customerCancel: publicProcedure
    .input(z.object({
      id: z.number(),
      email: z.string().email().max(255),
      reason: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.req?.ip || "unknown";
      if (!checkRateLimit(customerMutationLimiter, ip, RL_WINDOW_MS, RL_MUTATION_MAX)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many requests. Please wait a few minutes and try again." });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.id, input.id),
          eq(schema.rentalRequests.customerEmail, input.email),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });

      if (!["pending", "approved"].includes(rental.status)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Can only cancel pending or approved orders" });
      }

      const transition = await transitionRentalStatus(db, {
        rentalId: input.id,
        targetStatus: "cancelled",
        additionalUpdates: {
          customerNotes: input.reason
            ? `${rental.customerNotes ? rental.customerNotes + "\n" : ""}[Cancellation reason]: ${input.reason}`
            : rental.customerNotes,
        },
        auditMetadata: { source: "customer_self_service", reason: input.reason },
        actor: { ip: ctx.req?.ip },
      });

      return { success: true, failures: transition.failures };
    }),
});
