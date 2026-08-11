import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { Wallet } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";

/**
 * What the company owes its customers, in one place.
 *
 * Nothing else reports this. Before the credit ledger existed the money was
 * scattered across inflated invoice `amountPaid` values and unconverted
 * deposits, so "how much of the cash on hand is actually the customers'" had no
 * answer at all.
 */
export default function CustomerCredit() {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const { data, isLoading } = trpc.customerCredit.overview.useQuery();

  const fmtMoney = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (d: Date | string | null) =>
    d ? new Date(d).toLocaleDateString(i18n.language === "zh" ? "zh-CN" : "en-CA") : "—";

  const customers = data?.customers ?? [];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)] flex items-center gap-3">
            <Wallet size={28} /> {t("credit.overviewTitle")}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t("credit.overviewSubtitle")}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
            <div className="text-xs text-slate-500 uppercase tracking-wide">{t("credit.overviewTotal")}</div>
            <div className="text-3xl font-bold text-emerald-700 tabular-nums mt-1">
              {fmtMoney(data?.total ?? 0)}
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
            <div className="text-xs text-slate-500 uppercase tracking-wide">{t("credit.overviewCustomers")}</div>
            <div className="text-3xl font-bold text-slate-900 tabular-nums mt-1">{customers.length}</div>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-slate-400">{t("loading", { ns: "common" })}</div>
          ) : customers.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">{t("credit.overviewEmpty")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-slate-200 bg-slate-50">
                    <th className="py-3 px-4 font-medium">{t("credit.colCustomer")}</th>
                    <th className="py-3 px-4 font-medium text-right">{t("credit.colAmount")}</th>
                    <th className="py-3 px-4 font-medium text-right hidden sm:table-cell">{t("credit.colEntries")}</th>
                    <th className="py-3 px-4 font-medium hidden md:table-cell">{t("credit.colLastActivity")}</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.customerId} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                      <td className="py-3 px-4">
                        <Link
                          href={`/admin/customers/${c.customerId}`}
                          className="text-[var(--primary)] hover:underline font-medium"
                        >
                          {c.name}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums font-medium text-emerald-700">
                        {fmtMoney(c.balance)}
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                        {c.entryCount}
                      </td>
                      <td className="py-3 px-4 text-slate-500 hidden md:table-cell whitespace-nowrap">
                        {fmtDate(c.lastActivity)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
