// Why a recorded charge / payment / line was changed after the fact.
//
// Distinct from EXTRA_CHARGE_REASONS (shared/extraCharges.ts), which says what a
// charge IS FOR. This says why an already-recorded row was corrected — it is the
// "why" half of the evidence chain, stored alongside the old→new diff in the
// audit log so a later reader can tell a typo fix from a negotiated discount.

export const EDIT_REASONS = [
  "wrong_amount",
  "customer_agreed",
  "duplicate",
  "wrong_document",
  "waived",
  "other",
] as const;
export type EditReason = (typeof EDIT_REASONS)[number];

export const EDIT_REASON_LABELS: Record<EditReason, { en: string; zh: string }> = {
  wrong_amount: { en: "Wrong amount entered", zh: "录错金额" },
  customer_agreed: { en: "Agreed with customer", zh: "客户协商一致" },
  duplicate: { en: "Duplicate record", zh: "重复记录" },
  wrong_document: { en: "Wrong document / order", zh: "凭证或订单记错" },
  waived: { en: "Waived", zh: "免除" },
  other: { en: "Other", zh: "其他" },
};

/** Free-text note is required when the reason alone does not explain the change. */
export const EDIT_REASON_REQUIRES_NOTE: readonly EditReason[] = ["other"];

export function isEditReason(value: unknown): value is EditReason {
  return typeof value === "string" && (EDIT_REASONS as readonly string[]).includes(value);
}

/**
 * The evidence payload carried into the audit log's `metadata`.
 * Kept in one shape so every module records the "why" identically and the
 * change-history UI can render it without per-module special cases.
 */
export interface EditEvidence {
  reason: EditReason;
  reasonNote?: string;
}
