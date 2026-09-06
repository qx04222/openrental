export type InsightKind = "work_order" | "draft_invoice" | "damage_claim" | "dispatch_order" | "extension_request" | "held_deposit" | "unbilled_credit_charges" | "overdue_invoice";
export interface InsightQueue { buckets: { kind: string; slaDays: number; items: { id: number; ref: string; ageDays: number; overdue: boolean }[] }[] }
const impact: Record<InsightKind, number> = { extension_request: 30, dispatch_order: 28, work_order: 26, held_deposit: 24, overdue_invoice: 22, unbilled_credit_charges: 20, draft_invoice: 18, damage_claim: 16 };
const destinations: Record<InsightKind, string> = { work_order: "/admin/work-orders", draft_invoice: "/admin/invoices", damage_claim: "/admin/damage-claims", dispatch_order: "/admin/dispatch", extension_request: "/admin/extension-requests", held_deposit: "/admin/rental-management", unbilled_credit_charges: "/admin/invoices", overdue_invoice: "/admin/invoices" };
/** Explainable suggestions from observed work, never an instruction to charge,
 * refund, message a customer or change a rental automatically. */
export function prioritizeOperations(queue: InsightQueue, limit = 3) {
  const candidates = queue.buckets.flatMap(bucket => {
    if (!Object.prototype.hasOwnProperty.call(impact, bucket.kind)) return [];
    const kind = bucket.kind as InsightKind;
    return bucket.items.map(item => {
      const ageDays = Math.max(0, item.ageDays), overdueBy = Math.max(0, ageDays - bucket.slaDays);
      const score = (item.overdue ? 100 : 0) + Math.min(overdueBy, 90) * 2 + impact[kind];
      const parameter = kind === "draft_invoice" || kind === "overdue_invoice" ? `?invoiceId=${item.id}` : kind === "held_deposit" ? `?rentalId=${item.id}` : "";
      return { key: `${kind}-${item.id}`, kind, id: item.id, ref: item.ref, ageDays, slaDays: bucket.slaDays, overdueBy, score, urgency: (!item.overdue ? "planned" : overdueBy >= 7 ? "urgent" : "attention") as "planned" | "urgent" | "attention", href: destinations[kind] + parameter };
    });
  });
  const distinct = [...new Map(candidates.map(item => [item.key, item])).values()];
  return distinct.sort((a, b) => b.score - a.score || b.ageDays - a.ageDays || a.key.localeCompare(b.key)).slice(0, Math.max(0, Math.min(limit, 8)));
}
