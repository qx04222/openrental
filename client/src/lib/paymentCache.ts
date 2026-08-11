import { trpc } from "./trpc";

type TrpcUtils = ReturnType<typeof trpc.useUtils>;

/**
 * Invalidate every query whose data derives from an order's prepayment ledger.
 *
 * Recording a payment from the invoice page (`invoices.recordPayment`) and from
 * rental management (`rentalPrepayments.create/delete`) both settle the SAME
 * server-side ledger, so both views must refresh regardless of where the entry
 * was made. Centralizing the invalidation here stops the two flows from drifting
 * out of sync (the frontend mirror of `recalculateInvoicesForRental`).
 */
export function invalidatePaymentCaches(utils: TrpcUtils) {
  void utils.invoices.list.invalidate();
  void utils.invoices.summary.invalidate();
  void utils.rentalPrepayments.list.invalidate();
  void utils.rentals.paymentStatusMap.invalidate();
  // Refresh any open rental detail (its invoice-status summary derives from the ledger too).
  void utils.rentals.getById.invalidate();
}
