/**
 * "Overdue" for an invoice is a DERIVED payment reminder — never a stored status
 * or a money charge. An invoice is overdue when it still owes money and its due
 * date has passed. Only payment-open invoices (sent / partial) qualify; draft,
 * paid, cancelled and credited never show overdue.
 *
 * Computed at read time so the invoices view can never drift from 订单管理 (whose
 * prepayment ledger drives balanceDue/status). `todayUtc` is the Toronto "today"
 * midnight as a UTC instant (see server/_core/dateUtils zonedTodayPlusDaysUtc).
 */
export function isInvoiceOverdue(
  status: string,
  dueDate: Date | string | null,
  balanceDue: string | number | null,
  todayUtc: Date,
): boolean {
  if (status !== "sent" && status !== "partial") return false;
  const bal = typeof balanceDue === "number" ? balanceDue : parseFloat(balanceDue ?? "0") || 0;
  if (bal <= 0.005) return false;
  if (!dueDate) return false;
  return new Date(dueDate).getTime() < todayUtc.getTime();
}
