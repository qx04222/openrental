import { useTranslation } from "react-i18next";
import type { DerivedPaymentState } from "@shared/paymentStatus";

const TONE: Record<DerivedPaymentState, string> = {
  paid: "bg-emerald-100 text-emerald-700",
  partial: "bg-amber-100 text-amber-700",
  unpaid: "bg-slate-100 text-slate-500",
};

/** Small Paid / Partial / Unpaid pill, derived from the prepayment ledger. */
export default function PaymentBadge({ state, className = "" }: { state: DerivedPaymentState; className?: string }) {
  const { t } = useTranslation("rental");
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${TONE[state]} ${className}`}>
      {t(`management.pay.${state}`)}
    </span>
  );
}
