import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Pencil, Plus, X } from "lucide-react";
import { serverErrorText } from "@/lib/serverError";

export default function TaxRatesTab() {
  const { t } = useTranslation(["admin", "common"]);
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const { data: taxRates, refetch } = trpc.rentalSettings.getTaxRates.useQuery();

  const addMutation = trpc.rentalSettings.addTaxRate.useMutation({
    onSuccess: () => { refetch(); toast.success(t("taxRates.saved")); setEditing(null); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateMutation = trpc.rentalSettings.updateTaxRate.useMutation({
    onSuccess: () => { refetch(); toast.success(t("taxRates.updated")); setEditing(null); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [editing, setEditing] = useState<{ province: string; provinceName: string; gstRate: string; pstRate: string; hstRate: string; isNew?: boolean } | null>(null);

  const openEdit = (rate: { province: string; provinceName: string; gstRate: number; pstRate: number; hstRate: number }) => {
    setEditing({
      province: rate.province,
      provinceName: rate.provinceName,
      gstRate: (rate.gstRate * 100).toFixed(2),
      pstRate: (rate.pstRate * 100).toFixed(2),
      hstRate: (rate.hstRate * 100).toFixed(2),
    });
  };

  const openAdd = () => {
    setEditing({ province: "", provinceName: "", gstRate: "5.00", pstRate: "0.00", hstRate: "0.00", isNew: true });
  };

  const handleSave = () => {
    if (!editing) return;
    const data = {
      province: editing.province,
      provinceName: editing.provinceName,
      gstRate: parseFloat(editing.gstRate) / 100,
      pstRate: parseFloat(editing.pstRate) / 100,
      hstRate: parseFloat(editing.hstRate) / 100,
    };
    if (editing.isNew) {
      addMutation.mutate(data);
    } else {
      updateMutation.mutate(data);
    }
  };

  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{t("rentalSettings.canadianTaxRates")}</h3>
          <p className="text-sm text-slate-500">{t("rentalSettings.taxReadOnly")}</p>
        </div>
        {isSuperAdmin && (
          <button onClick={openAdd} className="btn-primary text-sm inline-flex items-center gap-1.5">
            <Plus size={14} />
            {t("taxRates.addTaxRate")}
          </button>
        )}
      </div>

      {/* Read-only banner for non-super_admin */}
      {!isSuperAdmin && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm text-blue-800">
            {t("taxRates.readOnlyBanner")}
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="pb-2 font-medium">{t("rentalSettings.provinceName")}</th>
            <th className="pb-2 font-medium">{t("rentalSettings.provinceFullName")}</th>
            <th className="pb-2 font-medium">{t("rentalSettings.gst")}</th>
            <th className="pb-2 font-medium">{t("rentalSettings.pst")}</th>
            <th className="pb-2 font-medium">{t("rentalSettings.hst")}</th>
            <th className="pb-2 font-medium">{t("rentalSettings.totalTax")}</th>
            {isSuperAdmin && <th className="pb-2 font-medium text-right">{t("taxRates.actions")}</th>}
          </tr></thead>
          <tbody>
            {taxRates?.map((rate) => (
              <tr key={rate.province} className="border-b border-slate-100">
                <td className="py-2 font-medium">{rate.province}</td>
                <td className="py-2">{rate.provinceName}</td>
                <td className="py-2">{rate.gstRate > 0 ? `${(rate.gstRate * 100).toFixed(2)}%` : "-"}</td>
                <td className="py-2">{rate.pstRate > 0 ? `${(rate.pstRate * 100).toFixed(2)}%` : "-"}</td>
                <td className="py-2">{rate.hstRate > 0 ? `${(rate.hstRate * 100).toFixed(2)}%` : "-"}</td>
                <td className="py-2 font-medium">{((rate.hstRate || (rate.gstRate + rate.pstRate)) * 100).toFixed(2)}%</td>
                {isSuperAdmin && (
                  <td className="py-2 text-right">
                    <button onClick={() => openEdit(rate)} className="p-1.5 hover:bg-slate-100 rounded-lg transition text-slate-500 hover:text-slate-700" title="Edit">
                      <Pencil size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {(!taxRates || taxRates.length === 0) && (
              <tr><td colSpan={isSuperAdmin ? 7 : 6} className="py-4 text-center text-slate-400">{t("rentalSettings.noTaxRates")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Edit / Add Dialog */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">
                {editing.isNew ? t("taxRates.addTitle") : t("taxRates.editTitle", { province: editing.province })}
              </h3>
              <button onClick={() => setEditing(null)} className="p-1.5 hover:bg-slate-100 rounded-lg transition">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {editing.isNew && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("taxRates.provinceCode")}</label>
                    <input maxLength={2} value={editing.province} onChange={(e) => setEditing({ ...editing, province: e.target.value.toUpperCase() })} placeholder="ON" className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("taxRates.provinceName")}</label>
                    <input value={editing.provinceName} onChange={(e) => setEditing({ ...editing, provinceName: e.target.value })} placeholder="Ontario" className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                  </div>
                </>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("taxRates.gstPercent")}</label>
                  <input type="number" step="0.01" min="0" max="100" value={editing.gstRate} onChange={(e) => setEditing({ ...editing, gstRate: e.target.value })} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("taxRates.pstPercent")}</label>
                  <input type="number" step="0.01" min="0" max="100" value={editing.pstRate} onChange={(e) => setEditing({ ...editing, pstRate: e.target.value })} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("taxRates.hstPercent")}</label>
                  <input type="number" step="0.01" min="0" max="100" value={editing.hstRate} onChange={(e) => setEditing({ ...editing, hstRate: e.target.value })} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleSave} disabled={addMutation.isPending || updateMutation.isPending} className="btn-primary text-sm">
                {(addMutation.isPending || updateMutation.isPending) ? t("saving", { ns: "common" }) : t("save", { ns: "common" })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
