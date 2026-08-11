/**
 * Waiving an extra charge that has ALREADY been invoiced.
 *
 * The in-place edit path (editableGuard rule 1) deliberately refuses to touch a
 * row that sits on an issued invoice: mutating it would silently desync a
 * document the customer already holds. The accounting-correct way to give the
 * money back is to leave the original invoice exactly as issued and offset it
 * with a credit note. That is what this module does.
 *
 * Worked example (the case this was built for):
 *   INV-2026-0152 = rental 280.00 + insurance 42.00 + fuel 36.00
 *                 = subtotal 358.00, HST 46.54, total 404.54
 *   Waiving the 36.00 fuel charge issues CN-2026-NNNN for -(36.00 + 4.68) =
 *   -40.68, so the customer nets 363.86 — which is 322.00 x 1.13.
 *
 * Not-invoiced charges do NOT come here: those are still directly editable /
 * deletable, and routing them through a credit note would create a document for
 * money that was never billed.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { i18nError } from "../_core/i18nError";
import { calendarPartsInTimeZone } from "../_core/dateUtils";
import { insertWithInvoiceNumber } from "./invoiceNumber";
import { calculateTax } from "./taxCalculation";
import { assertEditReason, diffFields, logEdit } from "./editableGuard";
import { EXTRA_CHARGE_LABELS, type ExtraChargeReason } from "../../shared/extraCharges";

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => round2(n).toFixed(2);

/** Idempotency key for the credit note a waiver produces. */
export function waiverSourceKey(claimId: number): string {
  return `waive:claim:${claimId}`;
}

export interface WaivableClaim {
  approvedAmount: string | null;
  amount: string | null;
  repairEstimate: string | null;
}

/**
 * The amount this charge is actually billed at. Same precedence as
 * invoiceReconciliation.planExtraChargeReconciliation and orderCharges — the
 * credit must reverse exactly what was charged, so the two must never diverge.
 */
export function resolveClaimAmount(claim: WaivableClaim): number {
  const amount = Number.parseFloat(claim.approvedAmount || claim.amount || claim.repairEstimate || "0");
  return Number.isFinite(amount) ? round2(amount) : 0;
}

/**
 * Tax rate to reverse, derived from the ORIGINAL invoice: taxAmount / subtotal.
 *
 * Deliberately not `calculateTax` first and not a hardcoded 13%. What has to be
 * credited back is the tax the customer was actually billed on that document.
 * Re-deriving it from today's tax_rates table would silently produce the wrong
 * credit for an invoice issued before a rate change, or for an invoice whose
 * province was recorded differently. The stored document is the authority.
 *
 * Returns null when the rate cannot be derived (subtotal 0 / missing), in which
 * case the caller falls back to calculateTax for the order's province.
 */
export function deriveInvoiceTaxRate(invoice: { subtotal: string | null; taxAmount: string | null }): number | null {
  const subtotal = Number.parseFloat(invoice.subtotal || "0");
  const taxAmount = Number.parseFloat(invoice.taxAmount || "0");
  if (!Number.isFinite(subtotal) || !Number.isFinite(taxAmount) || subtotal <= 0) return null;
  const rate = taxAmount / subtotal;
  if (!Number.isFinite(rate) || rate < 0) return null;
  return rate;
}

export interface WaiverAmounts {
  /** Pre-tax amount being reversed (positive). */
  chargeAmount: number;
  /** Tax being reversed (positive). */
  taxAmount: number;
  /** chargeAmount + taxAmount (positive). */
  totalAmount: number;
  /** Rate used, for the audit trail. */
  taxRate: number;
}

/** Split the waived charge into the pre-tax credit and its tax. */
export function computeWaiverAmounts(chargeAmount: number, taxRate: number): WaiverAmounts {
  const charge = round2(chargeAmount);
  const tax = round2(charge * taxRate);
  return {
    chargeAmount: charge,
    taxAmount: tax,
    totalAmount: round2(charge + tax),
    taxRate,
  };
}

export interface WaiveChargeInput {
  claimId: number;
  reason: string;
  reasonNote?: string;
  userId?: number;
  ipAddress?: string;
}

export interface WaiveChargeResult {
  creditNoteId: number;
  creditNoteNumber: string;
  /** Positive figures; the credit note itself stores them negative. */
  chargeAmount: number;
  taxAmount: number;
  totalAmount: number;
}

export async function waiveInvoicedCharge(input: WaiveChargeInput): Promise<WaiveChargeResult> {
  const db = await getDb();
  if (!db) {
    throw i18nError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database not available",
      i18nKey: "errors.databaseUnavailable",
    });
  }

  // The "why" is validated before anything is written — a waiver with no reason
  // is exactly the evidence gap this whole feature exists to close.
  const evidence = assertEditReason(input.reason, input.reasonNote);

  const result = await db.transaction(async (tx) => {
    // Lock the claim: two concurrent waivers of the same charge would otherwise
    // both pass the already-waived check and issue two credit notes.
    const [claim] = await tx
      .select()
      .from(schema.damageClaims)
      .where(and(eq(schema.damageClaims.id, input.claimId), isNull(schema.damageClaims.deletedAt)))
      .limit(1)
      .for("update");

    if (!claim) {
      throw i18nError({
        code: "NOT_FOUND",
        message: "Extra charge not found",
        i18nKey: "errors.damageClaim.notFound",
      });
    }

    // Only invoiced charges are waived. An un-invoiced one is still directly
    // editable/deletable, and crediting it would document money never billed.
    if (claim.invoiceId == null) {
      throw i18nError({
        code: "PRECONDITION_FAILED",
        message: "This charge has not been invoiced yet — edit or delete it directly instead of waiving it.",
        i18nKey: "errors.waive.notInvoiced",
      });
    }

    const chargeAmount = resolveClaimAmount(claim);
    if (chargeAmount <= 0) {
      throw i18nError({
        code: "PRECONDITION_FAILED",
        message: "This charge has no outstanding amount to waive.",
        i18nKey: "errors.waive.nothingToWaive",
      });
    }

    const sourceKey = waiverSourceKey(claim.id);
    // Deliberately NOT filtered by deletedAt: invoices_source_key_unique is a
    // plain (non-partial) unique index, so a soft-deleted credit note still owns
    // the key and a second insert would fail anyway. Better a clear "already
    // waived" than a raw constraint violation.
    const [existingCredit] = await tx
      .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
      .from(schema.invoices)
      .where(eq(schema.invoices.sourceKey, sourceKey))
      .limit(1);
    if (existingCredit) {
      throw i18nError({
        code: "PRECONDITION_FAILED",
        message: `This charge was already waived by credit note ${existingCredit.invoiceNumber}.`,
        i18nKey: "errors.waive.alreadyWaived",
        i18nParams: { invoiceNumber: existingCredit.invoiceNumber },
      });
    }

    const [originalInvoice] = await tx
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, claim.invoiceId), isNull(schema.invoices.deletedAt)))
      .limit(1);
    if (!originalInvoice) {
      throw i18nError({
        code: "NOT_FOUND",
        message: "The invoice this charge was billed on no longer exists.",
        i18nKey: "errors.waive.invoiceNotFound",
      });
    }

    // Tax: the rate actually charged on the original document (see
    // deriveInvoiceTaxRate). Only if that is underivable do we fall back to the
    // province rate — same call invoiceGenerator/orderCharges make.
    let taxRate = deriveInvoiceTaxRate(originalInvoice);
    let taxSource: "original_invoice" | "province_rate" | "none" = "original_invoice";
    if (taxRate == null) {
      taxSource = "province_rate";
      const province = originalInvoice.taxProvince || "ON";
      try {
        const calc = await calculateTax({
          rentalAmount: chargeAmount,
          shippingAmount: 0,
          ldwAmount: 0,
          depositAmount: 0,
          province,
        });
        taxRate = chargeAmount > 0 ? calc.totalTax / chargeAmount : 0;
      } catch {
        // Best-effort, mirroring invoiceGenerator: never block the waiver on the
        // tax lookup. A zero-tax credit is visibly wrong and correctable; a
        // failed waiver leaves the customer billed for money we agreed to drop.
        taxRate = 0;
        taxSource = "none";
      }
    }

    const amounts = computeWaiverAmounts(chargeAmount, taxRate);

    const year = calendarPartsInTimeZone(new Date()).year;
    const prefix = `CN-${year}-`;
    const chargeLabel =
      EXTRA_CHARGE_LABELS[(claim.chargeType ?? "other") as ExtraChargeReason]?.en ?? "Extra charge";
    const noteText =
      `Waiver of ${chargeLabel.toLowerCase()} on ${originalInvoice.invoiceNumber} ` +
      `(charge #${claim.id}). Reason: ${evidence.reason}` +
      (evidence.reasonNote ? ` — ${evidence.reasonNote}` : "");

    // The cast is only about Drizzle's nominal split between a database handle
    // and a transaction handle: insertWithInvoiceNumber uses select/insert, which
    // a transaction supports identically. Running it INSIDE the transaction is
    // the point — the number allocation and the insert must not straddle it.
    const creditNote = await insertWithInvoiceNumber<typeof schema.invoices.$inferSelect>(
      tx as unknown as Parameters<typeof insertWithInvoiceNumber>[0],
      prefix,
      async (invoiceNumber) =>
      // Nested transaction = SAVEPOINT. A duplicate invoice number aborts only
      // this attempt, so insertWithInvoiceNumber can recompute and retry without
      // the whole outer transaction being left in an aborted state.
      tx.transaction(async (sp) => {
        const [inv] = await sp
          .insert(schema.invoices)
          .values({
            invoiceNumber,
            // Idempotency backstop: invoices_source_key_unique makes a second
            // credit note for the same charge impossible even if the read-check
            // above is somehow bypassed.
            sourceKey,
            rentalId: claim.rentalId,
            customerId: claim.customerId ?? originalInvoice.customerId,
            type: "credit_note",
            // 'sent' (not draft) so the negative balance nets against
            // receivables in the invoice stats, matching downtime credit notes.
            status: "sent",
            subtotal: money(-amounts.chargeAmount),
            taxAmount: money(-amounts.taxAmount),
            taxBreakdown: originalInvoice.taxBreakdown,
            totalAmount: money(-amounts.totalAmount),
            amountPaid: "0",
            balanceDue: money(-amounts.totalAmount),
            taxProvince: originalInvoice.taxProvince,
            issueDate: new Date(),
            notes: noteText,
            // Traceability back to the source document and the source charge.
            internalNotes: JSON.stringify({
              waivedClaimId: claim.id,
              originalInvoiceId: originalInvoice.id,
              originalInvoiceNumber: originalInvoice.invoiceNumber,
              taxRate: amounts.taxRate,
              taxSource,
            }),
            createdBy: input.userId,
          })
          .returning();
        return inv;
      }),
    );

    await tx.insert(schema.invoiceLineItems).values({
      invoiceId: creditNote.id,
      description: `Waived ${chargeLabel.toLowerCase()}: ${claim.description ?? ""}`.trim(),
      quantity: "1",
      unitPrice: money(-amounts.chargeAmount),
      amount: money(-amounts.chargeAmount),
      lineType: "credit",
      sortOrder: 1,
    });

    // How the claim is marked waived, and why it is done this way:
    // damage_claims.status has no 'waived' value and the brief forbids inventing
    // one (other code branches on the existing values — e.g. orderCharges counts
    // 'accepted'|'invoiced' as owed, invoiceGenerator picks up 'accepted'). So
    // the status stays 'invoiced' — which remains historically TRUE, it WAS
    // invoiced — and the charge is zeroed via approvedAmount = 0.00. Every
    // consumer resolves the billable figure as
    // approvedAmount || amount || repairEstimate, so a 0.00 approvedAmount wins
    // and the charge drops out of every total without a schema change. The
    // original figure is preserved in `amount`/`repairEstimate` and in the audit
    // diff, so nothing is destroyed. The credit note is the authoritative record
    // that a waiver happened.
    const patch = { approvedAmount: "0.00", updatedAt: new Date() };
    const changes = diffFields(claim as unknown as Record<string, unknown>, patch);
    await tx
      .update(schema.damageClaims)
      .set(patch)
      .where(eq(schema.damageClaims.id, claim.id));

    return {
      creditNote,
      claim,
      amounts,
      taxSource,
      changes,
      originalInvoice,
    };
  });

  // Audit AFTER commit — a rolled-back waiver must not leave an audit entry
  // claiming it happened.
  await logEdit({
    userId: input.userId,
    entityType: "damage_claim",
    entityId: result.claim.id,
    rentalRequestId: result.claim.rentalId,
    action: "waive",
    changes: {
      ...result.changes,
      waivedAmount: { old: money(result.amounts.chargeAmount), new: "0.00" },
    },
    evidence,
    extraMetadata: {
      creditNoteId: result.creditNote.id,
      creditNoteNumber: result.creditNote.invoiceNumber,
      originalInvoiceId: result.originalInvoice.id,
      originalInvoiceNumber: result.originalInvoice.invoiceNumber,
      creditSubtotal: money(-result.amounts.chargeAmount),
      creditTax: money(-result.amounts.taxAmount),
      creditTotal: money(-result.amounts.totalAmount),
      taxRate: result.amounts.taxRate,
      taxSource: result.taxSource,
    },
    ipAddress: input.ipAddress,
  });

  return {
    creditNoteId: result.creditNote.id,
    creditNoteNumber: result.creditNote.invoiceNumber,
    chargeAmount: result.amounts.chargeAmount,
    taxAmount: result.amounts.taxAmount,
    totalAmount: result.amounts.totalAmount,
  };
}
