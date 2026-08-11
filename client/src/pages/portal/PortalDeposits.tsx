import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import PortalLayout from "./PortalLayout";
import { formatCurrency } from "@/lib/pricing";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { Wallet } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  held: "bg-blue-100 text-blue-700",
  released: "bg-green-100 text-green-700",
  pending: "bg-yellow-100 text-yellow-700",
};

// The deposits feed is per-order: a security deposit is "held" only while the
// rental is open and the office has marked it collected; "pending" until then;
// settled/"released" once the rental closes (there is no per-order refund field
// yet — close-out settlement is the convention, see reports.depositLiability).
function depositStatus(depositPaid: boolean, rentalStatus: string): string {
  if (!depositPaid) return "pending";
  if (rentalStatus === "completed" || rentalStatus === "cancelled") return "released";
  return "held";
}

export default function PortalDeposits() {
  const { t } = useTranslation("portal");
  const fmtDate = useFormatCalendarDate();
  const { data: depositsRaw, isLoading } = trpc.customerPortal.deposits.useQuery();
  // Only orders that actually carry a deposit belong in the deposits ledger.
  const deposits = (depositsRaw ?? []).filter(
    (d: Record<string, unknown>) => Number(d.depositAmount ?? 0) > 0
  );

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-slate-900">{t("deposits.title")}</h1>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="spinner" />
          </div>
        ) : !deposits || deposits.length === 0 ? (
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-12 text-center">
            <Wallet className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500">{t("deposits.noDeposits")}</p>
          </div>
        ) : (
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-slate-500 border-b border-slate-200 bg-slate-50/50">
                  <tr>
                    <th className="py-3 px-4 font-medium">{t("deposits.depositId")}</th>
                    <th className="py-3 px-4 font-medium">{t("deposits.amount")}</th>
                    <th className="py-3 px-4 font-medium hidden sm:table-cell">{t("deposits.date")}</th>
                    <th className="py-3 px-4 font-medium">{t("deposits.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {deposits.map((dep: Record<string, unknown>) => {
                    const id = dep.id as number;
                    const amount = Number(dep.depositAmount ?? 0) || 0;
                    const date = dep.createdAt ? fmtDate(dep.createdAt as string | Date) : "-";
                    const status = depositStatus(
                      Boolean(dep.depositPaid),
                      (dep.status as string) || ""
                    );

                    return (
                      <tr key={id} className="border-b border-slate-100 hover:bg-slate-50/50">
                        <td className="py-3 px-4 font-medium text-slate-900">DEP-{id}</td>
                        <td className="py-3 px-4 text-slate-900">{formatCurrency(amount)}</td>
                        <td className="py-3 px-4 text-slate-500 hidden sm:table-cell">{date}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-slate-100 text-slate-600"}`}>
                            {t(`deposits.${status}` as const, status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </PortalLayout>
  );
}
