import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Pencil } from "lucide-react";

/**
 * Deposit policy (editable; the engine reads these keys):
 *   deposit = multiplier × after-tax (rent + insurance + freight), rounded UP to
 *   `roundTo` dollars. Account / credit customers (creditLimit > 0) are waived to $0.
 */
export default function DepositsTab() {
  const { t } = useTranslation("admin");
  const { data: settings, refetch } = trpc.rentalSettings.getAll.useQuery({ category: "deposits" });
  const updateSetting = trpc.rentalSettings.update.useMutation({
    onSuccess: () => { refetch(); toast.success(t("rentalSettings.save")); },
  });
  const getVal = (key: string, fallback: string) => settings?.find((s) => s.key === key)?.value || fallback;

  const [multiplier, setMultiplier] = useState("1.5");
  const [roundTo, setRoundTo] = useState("50");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (settings) {
      setMultiplier(getVal("deposit_multiplier", "1.5"));
      setRoundTo(getVal("deposit_round_to", "50"));
    }
  }, [settings]);

  const save = () => {
    updateSetting.mutate({ key: "deposit_multiplier", value: multiplier });
    updateSetting.mutate({ key: "deposit_round_to", value: roundTo });
    setEditing(false);
  };

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-900">{t("rentalSettings.depositSettings")}</h3>

      <div className="rounded-xl border border-slate-200 shadow-sm bg-white overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-blue-500">{"ℹ️"}</span>
            <h4 className="font-semibold text-slate-900">{t("rentalSettings.howDepositsWork")}</h4>
          </div>
          {!editing && (
            <button onClick={() => setEditing(true)} className="p-1.5 hover:bg-slate-100 rounded-lg transition text-slate-500">
              <Pencil size={16} />
            </button>
          )}
        </div>
        <div className="p-6 space-y-4">
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("rentalSettings.depositMultiplier")}</label>
                  <input type="number" step="0.1" min="0" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("rentalSettings.depositRoundTo")}</label>
                  <input type="number" step="10" min="1" value={roundTo} onChange={(e) => setRoundTo(e.target.value)} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={save} disabled={updateSetting.isPending} className="btn-primary text-sm">{t("rentalSettings.save")}</button>
                <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800">{t("rentalSettings.cancel")}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-blue-50 rounded-xl p-4 text-center">
                  <p className="text-3xl font-black text-blue-700">{multiplier}×</p>
                  <p className="text-sm text-blue-600 mt-1">{t("rentalSettings.depositMultiplier")}</p>
                </div>
                <div className="bg-slate-50 rounded-xl p-4 text-center">
                  <p className="text-3xl font-black text-slate-900">${parseFloat(roundTo).toLocaleString()}</p>
                  <p className="text-sm text-slate-500 mt-1">{t("rentalSettings.depositRoundTo")}</p>
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg px-4 py-3 text-sm text-slate-600">{t("rentalSettings.depositFormulaV2")}</div>
              <p className="text-xs text-emerald-700">{t("rentalSettings.depositAccountWaive")}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
