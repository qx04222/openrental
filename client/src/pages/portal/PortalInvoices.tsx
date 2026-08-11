import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import PortalLayout from "./PortalLayout";
import { formatCurrency } from "@/lib/pricing";
import { Receipt } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  partial: "bg-amber-100 text-amber-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-500",
  credited: "bg-purple-100 text-purple-700",
  refunded: "bg-teal-100 text-teal-700",
  failed: "bg-red-100 text-red-700",
};

export default function PortalInvoices() {
  const { t } = useTranslation("portal");
  const { data: invoices, isLoading } = trpc.customerPortal.invoices.useQuery();

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-slate-900">{t("invoices.title")}</h1>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="spinner" />
          </div>
        ) : !invoices || invoices.length === 0 ? (
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-12 text-center">
            <Receipt className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500">{t("invoices.noInvoices")}</p>
          </div>
        ) : (
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-slate-500 border-b border-slate-200 bg-slate-50/50">
                  <tr>
                    <th className="py-3 px-4 font-medium">{t("invoices.invoiceNumber")}</th>
                    <th className="py-3 px-4 font-medium">{t("invoices.amount")}</th>
                    <th className="py-3 px-4 font-medium hidden sm:table-cell">{t("invoices.dueDate")}</th>
                    <th className="py-3 px-4 font-medium">{t("invoices.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv: Record<string, unknown>) => {
                    const id = inv.id as number;
                    const invoiceNumber = (inv.invoiceNumber as string) || (inv.invoice_number as string) || `INV-${id}`;
                    const amount = (inv.amount as number) || (inv.total as number) || 0;
                    const dueDate = (inv.dueDate as string) || (inv.due_date as string) || "-";
                    const status = (inv.status as string) || "draft";

                    return (
                      <tr key={id} className="border-b border-slate-100 hover:bg-slate-50/50">
                        <td className="py-3 px-4 font-medium text-slate-900">{invoiceNumber}</td>
                        <td className="py-3 px-4 text-slate-900">{formatCurrency(amount)}</td>
                        <td className="py-3 px-4 text-slate-500 hidden sm:table-cell">{dueDate}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-slate-100 text-slate-600"}`}>
                            {t(`invoices.${status}` as const, status)}
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
