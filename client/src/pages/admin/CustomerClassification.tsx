import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { toast } from "sonner";
import { ListChecks } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { serverErrorText } from "@/lib/serverError";
import {
  CUSTOMER_INDUSTRIES,
  CUSTOMER_LANGUAGES,
  industryI18nKey,
  languageI18nKey,
} from "@shared/customerClassification";

/**
 * Human sign-off on the industry/language auto-classification. Unconfirmed
 * rows float to the top (server-sorted); editing a dropdown IS the review, so
 * it self-confirms — the checkbox flow here is only for blessing rows that
 * were never touched.
 */
export default function CustomerClassification() {
  const { t } = useTranslation(["admin", "common"]);
  const { data, isLoading } = trpc.customers.classificationList.useQuery();
  const utils = trpc.useUtils();

  const [selected, setSelected] = useState<Set<number>>(new Set());

  const updateMutation = trpc.customers.update.useMutation({
    onSuccess: () => {
      utils.customers.classificationList.invalidate();
      toast.success(t("classify.saved"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const confirmMutation = trpc.customers.confirmClassification.useMutation({
    onSuccess: () => {
      utils.customers.classificationList.invalidate();
      toast.success(t("classify.confirmed"));
      setSelected(new Set());
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const rows = data ?? [];
  const pendingRows = useMemo(() => rows.filter((r) => !r.classificationConfirmedAt), [rows]);
  const pendingCount = pendingRows.length;

  const fmtMoney = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const allPendingSelected = pendingCount > 0 && pendingRows.every((r) => selected.has(r.id));

  const toggleSelectAll = () => {
    if (allPendingSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(pendingRows.map((r) => r.id)));
    }
  };

  const toggleRow = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirmSelected = () => {
    if (selected.size === 0) return;
    confirmMutation.mutate({ ids: Array.from(selected) });
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)] flex items-center gap-3">
              <ListChecks size={28} /> {t("classify.title")}
            </h1>
            <p className="text-sm text-slate-500 mt-1">{t("classify.subtitle")}</p>
          </div>
          {pendingCount > 0 && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold bg-amber-100 text-amber-800">
              {t("classify.pendingCount", { count: pendingCount })}
            </span>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-slate-400">{t("loading", { ns: "common" })}</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">{t("classify.empty")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-slate-200 bg-slate-50">
                    <th className="py-3 px-4 font-medium w-10">
                      <input
                        type="checkbox"
                        checked={allPendingSelected}
                        onChange={toggleSelectAll}
                        disabled={pendingCount === 0}
                        aria-label={t("classify.selectAll")}
                        className="rounded border-slate-300"
                      />
                    </th>
                    <th className="py-3 px-4 font-medium">{t("classify.colCustomer")}</th>
                    <th className="py-3 px-4 font-medium text-right hidden sm:table-cell">{t("classify.colOrders")}</th>
                    <th className="py-3 px-4 font-medium text-right">{t("classify.colRevenue")}</th>
                    <th className="py-3 px-4 font-medium">{t("classify.colIndustry")}</th>
                    <th className="py-3 px-4 font-medium">{t("classify.colLanguage")}</th>
                    <th className="py-3 px-4 font-medium">{t("classify.colStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const confirmed = !!r.classificationConfirmedAt;
                    return (
                      <tr key={r.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                        <td className="py-3 px-4">
                          {!confirmed && (
                            <input
                              type="checkbox"
                              checked={selected.has(r.id)}
                              onChange={() => toggleRow(r.id)}
                              aria-label={t("classify.selectAll")}
                              className="rounded border-slate-300"
                            />
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <Link
                            href={`/admin/customers/${r.id}`}
                            className="text-[var(--primary)] hover:underline font-medium"
                          >
                            {r.name}
                          </Link>
                          {r.company && <div className="text-xs text-slate-400">{r.company}</div>}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums text-slate-500 hidden sm:table-cell">
                          {r.totalRentals}
                        </td>
                        <td className="py-3 px-4 text-right tabular-nums font-medium text-slate-700">
                          {fmtMoney(r.totalRevenue)}
                        </td>
                        <td className="py-3 px-4">
                          <select
                            value={r.industry ?? ""}
                            onChange={(e) =>
                              updateMutation.mutate({
                                id: r.id,
                                industry: e.target.value ? (e.target.value as (typeof CUSTOMER_INDUSTRIES)[number]) : null,
                              })
                            }
                            className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                          >
                            <option value="">{t("customers.classificationUnset")}</option>
                            {CUSTOMER_INDUSTRIES.map((v) => (
                              <option key={v} value={v}>
                                {t(industryI18nKey(v))}
                              </option>
                            ))}
                          </select>
                          {((r.secondaryIndustries ?? []) as string[]).length > 0 && (
                            <div className="text-[10px] text-slate-400 mt-0.5">
                              +{((r.secondaryIndustries ?? []) as string[]).map((v) => t(industryI18nKey(v as (typeof CUSTOMER_INDUSTRIES)[number]))).join(" / ")}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <select
                            value={r.preferredLanguage ?? ""}
                            onChange={(e) =>
                              updateMutation.mutate({
                                id: r.id,
                                preferredLanguage: e.target.value ? (e.target.value as (typeof CUSTOMER_LANGUAGES)[number]) : null,
                              })
                            }
                            className="border border-slate-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
                          >
                            <option value="">{t("customers.classificationUnset")}</option>
                            {CUSTOMER_LANGUAGES.map((v) => (
                              <option key={v} value={v}>
                                {t(languageI18nKey(v))}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3 px-4">
                          {confirmed ? (
                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                              {t("classify.statusConfirmed")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                              {t("classify.statusPending")}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-slate-900 text-white rounded-full shadow-lg px-6 py-3 flex items-center gap-4">
          <span className="text-sm font-medium">{selected.size}</span>
          <button
            onClick={handleConfirmSelected}
            disabled={confirmMutation.isPending}
            className="bg-[var(--primary)] hover:opacity-90 disabled:opacity-50 text-white text-sm font-semibold px-4 py-1.5 rounded-full transition-opacity"
          >
            {t("classify.confirmSelected")}
          </button>
        </div>
      )}
    </DashboardLayout>
  );
}
