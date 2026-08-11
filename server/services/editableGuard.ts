/**
 * One place that decides whether an already-recorded row may still be edited,
 * and one place that records WHY it was edited.
 *
 * Two rules, set by the business and identical for every module:
 *
 *   1. Not yet invoiced. Once a row is on an issued invoice, editing its amount
 *      would silently desync the invoice. Those go through the waive/credit-note
 *      path instead — the issued document is never mutated.
 *   2. The order is still open. A closed/settled order is a finished book;
 *      corrections after that are an accounting act, not an edit.
 *
 * Deliberately shared rather than reimplemented per router: the recurring defect
 * in this codebase has been a correct rule that never propagated to every call
 * site (see sql/095 vs sql/099, BOOKING_OCCUPYING_STATUSES). One guard, imported
 * everywhere, is the fix for that class of drift.
 */

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { i18nError } from "../_core/i18nError";
import { logAudit } from "./auditLog";
import {
  EDIT_REASON_REQUIRES_NOTE,
  isEditReason,
  type EditEvidence,
  type EditReason,
} from "../../shared/editReasons";

/** Order states in which nothing may be corrected in place any more. */
export const CLOSED_RENTAL_STATUSES = ["completed", "cancelled"] as const;

export interface EditableCheck {
  /** Set once the row has been billed onto an issued invoice. */
  invoiceId: number | null | undefined;
  /** The order the row belongs to. */
  rentalRequestId: number | null | undefined;
  /** What the caller is editing, for the error message: "charge" | "payment" | … */
  subject: EditSubject;
}

export type EditSubject =
  | "charge"
  | "payment"
  | "workOrderPart"
  | "workOrderLabor"
  | "downtime";

const SUBJECT_LABELS: Record<EditSubject, string> = {
  charge: "extra charge",
  payment: "payment",
  workOrderPart: "work-order part",
  workOrderLabor: "work-order labour",
  downtime: "downtime record",
};

/**
 * Throw unless the row may still be corrected in place.
 * Returns the parent rental so callers don't re-query it.
 */
export async function assertEditable(check: EditableCheck) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const label = SUBJECT_LABELS[check.subject];

  // Rule 1 — already billed.
  if (check.invoiceId != null) {
    throw i18nError({
      code: "PRECONDITION_FAILED",
      message: `This ${label} is already on an issued invoice and cannot be edited. Waive it instead, which issues a credit note.`,
      i18nKey: "errors.edit.alreadyInvoiced",
      i18nParams: { subject: check.subject },
    });
  }

  if (check.rentalRequestId == null) {
    // Not attached to an order (e.g. a standalone work order): rule 2 cannot
    // apply, so rule 1 alone governs.
    return { rental: null };
  }

  const [rental] = await db
    .select()
    .from(schema.rentalRequests)
    .where(and(
      eq(schema.rentalRequests.id, check.rentalRequestId),
      isNull(schema.rentalRequests.deletedAt),
    ))
    .limit(1);

  if (!rental) {
    throw i18nError({
      code: "NOT_FOUND",
      message: "Rental not found",
      i18nKey: "errors.rentalNotFound",
    });
  }

  // Rule 2 — order already closed.
  if ((CLOSED_RENTAL_STATUSES as readonly string[]).includes(rental.status)) {
    throw i18nError({
      code: "PRECONDITION_FAILED",
      message: `The order is already closed, so this ${label} can no longer be edited.`,
      i18nKey: "errors.edit.orderClosed",
      i18nParams: { subject: check.subject },
    });
  }

  // Credit orders have their own settlement gate on top of the status.
  if (rental.creditFinalizedAt) {
    throw i18nError({
      code: "PRECONDITION_FAILED",
      message: `The credit order is already settled, so this ${label} can no longer be edited.`,
      i18nKey: "errors.edit.orderSettled",
      i18nParams: { subject: check.subject },
    });
  }

  return { rental };
}

/**
 * Validate the caller-supplied reason. The reason is mandatory on every edit —
 * an audit entry that records only old→new answers "what" but not "why", which
 * is the half a finance reviewer actually needs.
 */
export function assertEditReason(reason: string, reasonNote?: string): EditEvidence {
  if (!isEditReason(reason)) {
    throw i18nError({
      code: "BAD_REQUEST",
      message: "A valid change reason is required",
      i18nKey: "errors.edit.reasonRequired",
    });
  }

  const note = reasonNote?.trim() || undefined;
  if (EDIT_REASON_REQUIRES_NOTE.includes(reason as EditReason) && !note) {
    throw i18nError({
      code: "BAD_REQUEST",
      message: 'A note is required when the reason is "Other"',
      i18nKey: "errors.edit.noteRequired",
    });
  }

  return { reason: reason as EditReason, reasonNote: note };
}

/** Field-level old→new diff, skipping fields that did not actually change. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue;
    const oldValue = before[key] ?? null;
    const newValue = after[key] ?? null;
    if (String(oldValue) === String(newValue)) continue;
    changes[key] = { old: oldValue, new: newValue };
  }
  return changes;
}

/**
 * Write the evidence chain for an in-place correction.
 *
 * `rentalRequestId` goes into metadata so auditLog.getByRental can surface the
 * entry on the order's change-history tab — without it the record exists but is
 * invisible to the person who needs it.
 */
export async function logEdit(params: {
  userId?: number;
  entityType: string;
  entityId: number;
  rentalRequestId?: number | null;
  changes: Record<string, { old: unknown; new: unknown }>;
  evidence: EditEvidence;
  action?: "update" | "delete" | "waive";
  extraMetadata?: Record<string, unknown>;
  ipAddress?: string;
}) {
  await logAudit({
    userId: params.userId,
    action: params.action ?? "update",
    entityType: params.entityType,
    entityId: params.entityId,
    changes: params.changes,
    metadata: {
      ...(params.extraMetadata ?? {}),
      rentalRequestId: params.rentalRequestId ?? undefined,
      reason: params.evidence.reason,
      reasonNote: params.evidence.reasonNote,
    },
    ipAddress: params.ipAddress,
  });
}
