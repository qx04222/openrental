import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import type { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { recalculateRentalPricing } from "./priceRecalculation";
import { checkDateRangeAvailability } from "./rentalStatusSync";
import {
  extendLineItemEndDates,
  getRentalFleetIds,
  syncDispatchScheduleDates,
} from "./rentalLineItemSync";

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

interface ApprovalDependencies {
  recalculatePricing: typeof recalculateRentalPricing;
  getFleetIds: typeof getRentalFleetIds;
  checkAvailability: typeof checkDateRangeAvailability;
  extendLineItems: typeof extendLineItemEndDates;
  syncDispatch: typeof syncDispatchScheduleDates;
}

const defaultDependencies: ApprovalDependencies = {
  recalculatePricing: recalculateRentalPricing,
  getFleetIds: getRentalFleetIds,
  checkAvailability: checkDateRangeAvailability,
  extendLineItems: extendLineItemEndDates,
  syncDispatch: syncDispatchScheduleDates,
};

export async function approveExtensionRequest(
  db: AppDb,
  input: { id: number; adminNotes?: string; reviewedBy: number },
  dependencies: ApprovalDependencies = defaultDependencies,
) {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as AppDb;
    const [extension] = await tx
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
    if (!extension.rentalRequestId) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Extension request is not linked to a rental" });
    }

    const [rental] = await tx
      .select()
      .from(schema.rentalRequests)
      .where(and(
        eq(schema.rentalRequests.id, extension.rentalRequestId),
        isNull(schema.rentalRequests.deletedAt),
      ))
      .limit(1);
    if (!rental) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found for extension request" });
    }
    if (extension.requestedEndDate <= rental.endDate) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Requested end date must be later than the current rental end date" });
    }

    const fleetIds = await dependencies.getFleetIds(txDb, rental.id);
    for (const fleetId of fleetIds) {
      const availability = await dependencies.checkAvailability(
        fleetId,
        rental.startDate,
        extension.requestedEndDate,
        rental.id,
        txDb,
      );
      if (!availability.isAvailable) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Extension conflicts with another rental for fleet asset ${fleetId}`,
        });
      }
    }

    // Pricing is deliberately fail-closed. If it cannot be computed, no date,
    // linked line item, dispatch, or approval status is changed.
    const recalc = await dependencies.recalculatePricing(
      rental.id,
      rental.startDate,
      extension.requestedEndDate,
      txDb,
    );
    const now = new Date();
    await tx
      .update(schema.rentalRequests)
      .set({
        endDate: extension.requestedEndDate,
        rentalFee: recalc.new.rentalFee.toFixed(2),
        insuranceCost: recalc.new.insuranceCost.toFixed(2),
        taxAmount: recalc.new.taxAmount.toFixed(2),
        taxBreakdown: recalc.new.taxBreakdown,
        depositAmount: recalc.new.depositAmount.toFixed(2),
        totalAmount: recalc.new.totalAmount.toFixed(2),
        updatedAt: now,
      })
      .where(eq(schema.rentalRequests.id, rental.id));

    await dependencies.extendLineItems(
      txDb,
      rental.id,
      rental.endDate,
      extension.requestedEndDate,
    );
    await dependencies.syncDispatch(txDb, rental.id, { endDate: extension.requestedEndDate });

    const [updated] = await tx
      .update(schema.extensionRequests)
      .set({
        status: "approved",
        adminNotes: input.adminNotes,
        reviewedBy: input.reviewedBy,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.extensionRequests.id, input.id),
        eq(schema.extensionRequests.status, "pending"),
      ))
      .returning();

    if (!updated) {
      throw new TRPCError({ code: "CONFLICT", message: "Extension request was already reviewed" });
    }

    const commandKey = `extension:${extension.id}:approval`;
    const oldTotalAmount = Number.parseFloat(rental.totalAmount || "0");
    const effects: Array<typeof schema.rentalLifecycleEffects.$inferInsert> = [{
      commandKey,
      rentalRequestId: rental.id,
      effectType: "notification",
      payload: { extensionRequestId: extension.id, actorId: input.reviewedBy },
      nextAttemptAt: now,
    }];
    if (recalc.new.totalAmount - oldTotalAmount > 0.005) {
      effects.push({
        commandKey,
        rentalRequestId: rental.id,
        effectType: "renewal_supplement",
        payload: {
          extensionRequestId: extension.id,
          actorId: input.reviewedBy,
          oldEndDate: rental.endDate.toISOString(),
          newEndDate: extension.requestedEndDate.toISOString(),
          oldRentalFee: Number.parseFloat(rental.rentalFee || "0"),
          newRentalFee: recalc.new.rentalFee,
          oldInsuranceCost: Number.parseFloat(rental.insuranceCost || "0"),
          newInsuranceCost: recalc.new.insuranceCost,
          oldTaxAmount: Number.parseFloat(rental.taxAmount || "0"),
          newTaxAmount: recalc.new.taxAmount,
          newTaxBreakdown: recalc.new.taxBreakdown,
        },
        nextAttemptAt: now,
      });
    }
    await tx.insert(schema.rentalLifecycleEffects).values(effects).onConflictDoNothing();

    return { updated, extension, commandKey };
  });
}
