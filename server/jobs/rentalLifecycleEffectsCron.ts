import { and, eq, inArray, isNull, lte, notInArray } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { settleLifecycleEffect } from "../services/rentalLifecycleEffects";
import type { LifecycleEffectType } from "../services/rentalLifecycle";
import { renewalSupplementSourceKey } from "../services/invoiceReconciliation";
import { isFeatureEnabled } from "../services/featureFlags";

interface RenewalSupplementEffectPayload {
  extensionRequestId: number;
  actorId?: number;
  oldEndDate: Date;
  newEndDate: Date;
  oldRentalFee: number;
  newRentalFee: number;
  oldInsuranceCost: number;
  newInsuranceCost: number;
  oldTaxAmount: number;
  newTaxAmount: number;
  newTaxBreakdown: string | null;
}

export function parseRenewalSupplementPayload(payload: Record<string, unknown>): RenewalSupplementEffectPayload {
  const numberFields = [
    "extensionRequestId",
    "oldRentalFee",
    "newRentalFee",
    "oldInsuranceCost",
    "newInsuranceCost",
    "oldTaxAmount",
    "newTaxAmount",
  ] as const;
  const validNumbers = numberFields.every((field) => typeof payload[field] === "number" && Number.isFinite(payload[field]));
  const oldEndDate = new Date(String(payload.oldEndDate ?? ""));
  const newEndDate = new Date(String(payload.newEndDate ?? ""));
  if (!validNumbers || Number.isNaN(oldEndDate.getTime()) || Number.isNaN(newEndDate.getTime())) {
    throw new Error("Invalid renewal supplement effect payload");
  }
  return {
    extensionRequestId: payload.extensionRequestId as number,
    actorId: typeof payload.actorId === "number" ? payload.actorId : undefined,
    oldEndDate,
    newEndDate,
    oldRentalFee: payload.oldRentalFee as number,
    newRentalFee: payload.newRentalFee as number,
    oldInsuranceCost: payload.oldInsuranceCost as number,
    newInsuranceCost: payload.newInsuranceCost as number,
    oldTaxAmount: payload.oldTaxAmount as number,
    newTaxAmount: payload.newTaxAmount as number,
    newTaxBreakdown: typeof payload.newTaxBreakdown === "string" ? payload.newTaxBreakdown : null,
  };
}

export function planRenewalSupplementEffect(
  issuedInvoices: Array<{ sourceKey: string | null }>,
  sourceKey: string,
): "generate" | "already_generated" | "skip" {
  if (issuedInvoices.some((invoice) => invoice.sourceKey === sourceKey)) return "already_generated";
  return issuedInvoices.length > 0 ? "generate" : "skip";
}

export async function runRentalLifecycleEffectsCron(options: { now?: Date; limit?: number } = {}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = options.now ?? new Date();
  const candidates = await db
    .select()
    .from(schema.rentalLifecycleEffects)
    .where(and(
      inArray(schema.rentalLifecycleEffects.status, ["pending", "failed"]),
      lte(schema.rentalLifecycleEffects.nextAttemptAt, now),
    ))
    .limit(options.limit ?? 25);

  for (const candidate of candidates) {
    const [claimed] = await db
      .update(schema.rentalLifecycleEffects)
      .set({ status: "processing", updatedAt: now })
      .where(and(
        eq(schema.rentalLifecycleEffects.id, candidate.id),
        eq(schema.rentalLifecycleEffects.status, candidate.status),
        eq(schema.rentalLifecycleEffects.attempts, candidate.attempts),
      ))
      .returning();
    if (!claimed) continue;

    const effectType = claimed.effectType as LifecycleEffectType;
    try {
      const payload = (claimed.payload ?? {}) as { actorId?: number | null };
      if (effectType === "order_confirmation" || effectType === "notification") {
        throw new Error("Delivery outcome is ambiguous after interruption; verify manually before resending");
      }

      const [rental] = await db
        .select({
          isCreditOrder: schema.rentalRequests.isCreditOrder,
          contractGenerated: schema.rentalRequests.contractGenerated,
          contractUrl: schema.rentalRequests.contractUrl,
        })
        .from(schema.rentalRequests)
        .where(eq(schema.rentalRequests.id, claimed.rentalRequestId))
        .limit(1);
      if (!rental) {
        await settleLifecycleEffect(db, {
          commandKey: claimed.commandKey,
          effectType,
          skipped: true,
        });
        continue;
      }

      if (effectType === "contract_generate") {
        if (rental.contractGenerated && rental.contractUrl) {
          await settleLifecycleEffect(db, { commandKey: claimed.commandKey, effectType, skipped: true });
          continue;
        }
        const { regenerateContractPdf } = await import("../routers/rentalRequests.router");
        await regenerateContractPdf(claimed.rentalRequestId);
      } else if (effectType === "quotation_generate") {
        // Same gate as the inline path in rentalRequests.router — a retry must
        // not resurrect the post-approval quote that the flag turned off.
        if (!(await isFeatureEnabled("auto_quotation_on_approve"))) {
          await settleLifecycleEffect(db, { commandKey: claimed.commandKey, effectType, skipped: true });
          continue;
        }
        const { generateQuotationFromRental } = await import("../services/quotationGenerator");
        await generateQuotationFromRental({ rentalId: claimed.rentalRequestId, createdBy: payload.actorId ?? undefined });
      } else if (effectType === "invoice_reconcile") {
        if (rental.isCreditOrder) {
          await settleLifecycleEffect(db, { commandKey: claimed.commandKey, effectType, skipped: true });
          continue;
        }
        const { generateInvoiceFromRental } = await import("../services/invoiceGenerator");
        await generateInvoiceFromRental({ rentalId: claimed.rentalRequestId, createdBy: payload.actorId ?? undefined });
      } else if (effectType === "invoice_document") {
        if (rental.isCreditOrder) {
          await settleLifecycleEffect(db, { commandKey: claimed.commandKey, effectType, skipped: true });
          continue;
        }
        const { generateInvoiceFromRental } = await import("../services/invoiceGenerator");
        const invoice = await generateInvoiceFromRental({ rentalId: claimed.rentalRequestId, createdBy: payload.actorId ?? undefined });
        const { generateInvoicePDF } = await import("../services/invoicePDF");
        await generateInvoicePDF(invoice.invoiceId);
      } else if (effectType === "renewal_supplement") {
        const supplement = parseRenewalSupplementPayload((claimed.payload ?? {}) as Record<string, unknown>);
        const sourceKey = renewalSupplementSourceKey(claimed.rentalRequestId, supplement.extensionRequestId);
        const issuedInvoices = await db
          .select({ id: schema.invoices.id, sourceKey: schema.invoices.sourceKey })
          .from(schema.invoices)
          .where(and(
            eq(schema.invoices.rentalId, claimed.rentalRequestId),
            eq(schema.invoices.type, "rental"),
            notInArray(schema.invoices.status, ["cancelled", "credited"]),
            isNull(schema.invoices.deletedAt),
          ));
        const supplementPlan = planRenewalSupplementEffect(issuedInvoices, sourceKey);
        if (supplementPlan === "already_generated") {
          await settleLifecycleEffect(db, { commandKey: claimed.commandKey, effectType });
          continue;
        }
        if (supplementPlan === "skip") {
          await settleLifecycleEffect(db, { commandKey: claimed.commandKey, effectType, skipped: true });
          continue;
        }
        const { generateRenewalSupplementInvoice } = await import("../services/invoiceGenerator");
        await generateRenewalSupplementInvoice({
          rentalId: claimed.rentalRequestId,
          sourceKey,
          ...supplement,
          createdBy: supplement.actorId,
        });
      }

      await settleLifecycleEffect(db, { commandKey: claimed.commandKey, effectType });
    } catch (error) {
      await settleLifecycleEffect(db, { commandKey: claimed.commandKey, effectType, error });
      logger.warn("[RentalLifecycleEffectsCron] Effect attempt failed", {
        effectId: claimed.id,
        rentalId: claimed.rentalRequestId,
        effectType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
