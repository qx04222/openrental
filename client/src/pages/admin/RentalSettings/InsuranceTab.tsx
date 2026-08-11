import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Pencil, X } from "lucide-react";

export default function InsuranceTab() {
  const { t } = useTranslation("admin");
  const { data: settings, refetch } = trpc.rentalSettings.getAll.useQuery({ category: "insurance" });
  const updateSetting = trpc.rentalSettings.update.useMutation({
    onSuccess: () => { refetch(); toast.success(t("rentalSettings.save")); },
  });

  const [editingType, setEditingType] = useState<"basic" | "full" | null>(null);
  const [form, setForm] = useState({ rate: "", deductible: "" });

  const getVal = (key: string, fallback: string) => settings?.find((s) => s.key === key)?.value || fallback;

  const basicRate = parseFloat(getVal("insurance_basic_rate", "0.15")) * 100;
  const fullRate = parseFloat(getVal("insurance_full_rate", "0.25")) * 100;
  const basicDeductible = getVal("insurance_basic_deductible", "1000");
  const fullDeductible = getVal("insurance_full_deductible", "0");

  const openEdit = (type: "basic" | "full") => {
    setEditingType(type);
    setForm({
      rate: type === "basic" ? basicRate.toString() : fullRate.toString(),
      deductible: type === "basic" ? basicDeductible : fullDeductible,
    });
  };

  const handleSave = () => {
    if (!editingType) return;
    const prefix = editingType === "basic" ? "insurance_basic" : "insurance_full";
    updateSetting.mutate({ key: `${prefix}_rate`, value: (parseFloat(form.rate) / 100).toString() });
    updateSetting.mutate({ key: `${prefix}_deductible`, value: form.deductible });
    setEditingType(null);
  };

  const rows = [
    { type: "basic" as const, label: t("rentalSettings.basicInsurance"), rate: basicRate, deductible: basicDeductible },
    { type: "full" as const, label: t("rentalSettings.fullCoverage"), rate: fullRate, deductible: fullDeductible },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{t("rentalSettings.insuranceOptions")}</h3>
          <p className="text-sm text-slate-500 mt-1">{t("rentalSettings.coverageDescription")}</p>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-slate-200 shadow-sm bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 font-medium text-slate-600">{t("rentalSettings.plan")}</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">{t("rentalSettings.ratePercent")}</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">{t("rentalSettings.deductible")}</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">{t("rentalSettings.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.type} className="border-b border-slate-100 hover:bg-slate-50 transition">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${row.type === "basic" ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"}`}>
                      {row.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono font-medium text-slate-900">{row.rate}%</td>
                  <td className="px-4 py-3 font-mono text-slate-700">${parseFloat(row.deductible).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openEdit(row.type)}
                      className="p-1.5 hover:bg-slate-100 rounded-lg transition text-slate-500 hover:text-slate-700"
                      title={t("rentalSettings.edit")}
                    >
                      <Pencil size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Info card */}
      <div className="rounded-xl border border-slate-200 bg-blue-50 p-4">
        <p className="text-sm text-blue-800">
          <strong>{t("rentalSettings.howInsuranceWorks")}</strong> {t("rentalSettings.insuranceExplanation")}
        </p>
      </div>

      {/* System preset notice */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p className="text-sm text-amber-800">
          {t("rentalSettings.systemInsurancePresetNotice")}
        </p>
      </div>

      {/* Edit Dialog */}
      {editingType && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">
                {editingType === "basic" ? t("rentalSettings.editBasic") : t("rentalSettings.editFull")}
              </h3>
              <button onClick={() => setEditingType(null)} className="p-1.5 hover:bg-slate-100 rounded-lg transition">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("rentalSettings.ratePercent")}</label>
                <div className="relative">
                  <input
                    type="number"
                    step="1"
                    min="0"
                    max="100"
                    value={form.rate}
                    onChange={(e) => setForm({ ...form, rate: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 pr-8 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">%</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">{t("rentalSettings.rateHint")}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("rentalSettings.deductible")}</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                  <input
                    type="number"
                    step="100"
                    min="0"
                    value={form.deductible}
                    onChange={(e) => setForm({ ...form, deductible: e.target.value })}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg pl-7 pr-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                  />
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button
                onClick={() => setEditingType(null)}
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
              >
                {t("rentalSettings.cancel")}
              </button>
              <button
                onClick={handleSave}
                disabled={updateSetting.isPending}
                className="btn-primary text-sm"
              >
                {updateSetting.isPending ? t("depositRules.saving") : t("rentalSettings.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
