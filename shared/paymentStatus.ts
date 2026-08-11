/**
 * Derived payment state — single source of truth for "is this order paid?".
 *
 * Driven by the prepayment ledger (amount collected) vs the billed total, NOT
 * the rental_requests.paymentStatus column (which is unreliable — never updated
 * by the office). Keeps the badge consistent with the AR / cash reports, which
 * also net prepayments. A half-cent tolerance absorbs rounding.
 */
export type DerivedPaymentState = "paid" | "partial" | "unpaid";

export function derivePaymentState(total: number, prepaid: number): DerivedPaymentState {
  if (total > 0 && prepaid >= total - 0.005) return "paid";
  if (prepaid > 0) return "partial";
  return "unpaid";
}

/**
 * Allocate an order's prepayment ledger across its invoices.
 *
 * An order's payments live in ONE order-level ledger (rental_prepayments), but an
 * order can carry MANY invoices (credit/挂账 monthly billing, renewal supplements).
 * Applying the whole ledger sum to every invoice would mark them all paid off a
 * single payment — so we distribute instead, conserving the total exactly:
 *
 *   1. A payment tagged to a specific invoice (invoiceId) goes to THAT invoice.
 *   2. Whatever is left (untagged deposits/prepayments, or tagged overflow) fills
 *      the remaining invoice balances oldest-first (FIFO) — standard AR behaviour.
 *   3. Anything still left over is a genuine overpayment and is RETURNED rather
 *      than allocated. It used to be forced onto the newest invoice so that the
 *      allocations summed to the ledger total — which is why 35 production
 *      invoices show amountPaid above their own total, and why "how much did we
 *      overcollect" was unanswerable. The caller books it to the customer's
 *      credit ledger instead; conservation still holds, as
 *      sum(allocations) + leftover === sum(payments).
 *
 * `invoices` MUST be pre-sorted oldest-first.
 */
export interface AllocInvoice { id: number; total: number }
export interface AllocPrepayment { amount: number; invoiceId: number | null }
export interface AllocationResult {
  /** invoiceId → amount applied. */
  allocations: Map<number, number>;
  /** Money that belongs to the customer but settles no invoice. Never negative. */
  leftover: number;
}

export function allocatePrepayments(
  invoices: AllocInvoice[],
  prepayments: AllocPrepayment[],
): AllocationResult {
  const paid = new Map<number, number>(invoices.map((i) => [i.id, 0]));
  if (invoices.length === 0) {
    // With no invoices to settle, everything positive is the customer's credit.
    const unallocated = prepayments.reduce((sum, p) => (p.amount > 0 ? sum + p.amount : sum), 0);
    return { allocations: paid, leftover: Math.round(unallocated * 100) / 100 };
  }

  const byId = new Map(invoices.map((i) => [i.id, i]));
  let pool = 0;

  // 1) Tagged payments → their invoice (cap at the invoice total; overflow pools).
  for (const p of prepayments) {
    const amt = p.amount;
    if (amt <= 0) continue;
    if (p.invoiceId != null && byId.has(p.invoiceId)) {
      const inv = byId.get(p.invoiceId)!;
      const room = Math.max(0, inv.total - paid.get(inv.id)!);
      const give = Math.min(room, amt);
      paid.set(inv.id, paid.get(inv.id)! + give);
      pool += amt - give;
    } else {
      pool += amt; // untagged, or tag points at a deleted/foreign invoice
    }
  }

  // 2) Untagged pool fills remaining balances, oldest invoice first.
  for (const inv of invoices) {
    if (pool <= 0.005) break;
    const room = Math.max(0, inv.total - paid.get(inv.id)!);
    const give = Math.min(room, pool);
    paid.set(inv.id, paid.get(inv.id)! + give);
    pool -= give;
  }

  // 3) Whatever survives is a real overpayment. Hand it back to the caller to
  //    book against the customer, rather than inflating an invoice with it.
  return {
    allocations: paid,
    leftover: pool > 0.005 ? Math.round(pool * 100) / 100 : 0,
  };
}
