import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { serverErrorText } from "@/lib/serverError";

export default function ShippingTab() {
  const { t } = useTranslation("admin");
  const utils = trpc.useUtils();
  const { data: settingRows } = trpc.rentalSettings.getAll.useQuery();
  const updateSetting = trpc.rentalSettings.update.useMutation({
    onSuccess: () => { utils.rentalSettings.getAll.invalidate(); toast.success(t("rentalSettings.saved")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const settingValue = (key: string, dflt: string) => {
    const s = settingRows?.find((r) => r.key === key);
    return s?.value ?? dflt;
  };
  const [surchargePctInput, setSurchargePctInput] = useState<string | null>(null);
  const [roundTripInput, setRoundTripInput] = useState<string | null>(null);
  const surchargePct = surchargePctInput ?? (parseFloat(settingValue("freight_multi_item_surcharge_pct", "0.25")) * 100).toString();
  const roundTrip = roundTripInput ?? settingValue("freight_round_trip_multiplier", "2.0");

  // Distance-bracket freight (the values the engine actually charges). When the
  // driving distance can't be determined, the engine falls back to the ≤30km
  // bracket (freight_tier_30km) — see shared/freight.ts.
  const freightKeys: { key: string; label: string; dflt: string }[] = [
    { key: "freight_tier_30km", label: t("rentalSettings.freightTier30"), dflt: "285" },
    { key: "freight_tier_45km", label: t("rentalSettings.freightTier45"), dflt: "335" },
    { key: "freight_tier_60km", label: t("rentalSettings.freightTier60"), dflt: "385" },
    { key: "freight_tier_75km", label: t("rentalSettings.freightTier75"), dflt: "435" },
    { key: "freight_oneway_factor", label: t("rentalSettings.freightOnewayFactor"), dflt: "0.575" },
    { key: "freight_max_km", label: t("rentalSettings.freightMaxKm"), dflt: "75" },
  ];

  return (
    <div className="space-y-6">
      {/* Distance-bracket freight (what the engine charges) */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{t("rentalSettings.freightTiersTitle")}</h3>
          <p className="text-sm text-slate-500 mt-1">{t("rentalSettings.freightTiersDesc")}</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {freightKeys.map((f) => (
            <div key={f.key}>
              <label className="block text-xs text-slate-500 mb-1">{f.label}</label>
              <input
                type="number"
                step="0.001"
                defaultValue={settingValue(f.key, f.dflt)}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== "" && v !== settingValue(f.key, f.dflt)) updateSetting.mutate({ key: f.key, value: v });
                }}
                className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Multi-item / round-trip rules */}
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{t("rentalSettings.freightRulesTitle")}</h3>
          <p className="text-sm text-slate-500 mt-1">{t("rentalSettings.freightRulesDesc")}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-4">
          <div>
            <label className="block text-xs text-slate-500 mb-1">{t("rentalSettings.surchargePctLabel")}</label>
            <div className="flex gap-2">
              <input
                type="number"
                step="1"
                min="0"
                max="500"
                value={surchargePct}
                onChange={(e) => setSurchargePctInput(e.target.value)}
                className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
              <span className="self-center text-sm text-slate-500">%</span>
              <button
                onClick={() => {
                  const pct = parseFloat(surchargePct) / 100;
                  if (isNaN(pct) || pct < 0) return toast.error(t("rentalSettings.invalidValue"));
                  updateSetting.mutate({ key: "freight_multi_item_surcharge_pct", value: pct.toFixed(4), description: "Per-additional-item surcharge as fraction of largest item's freight" });
                  setSurchargePctInput(null);
                }}
                className="btn-secondary text-sm"
              >
                {t("rentalSettings.save")}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">{t("rentalSettings.surchargePctHint")}</p>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">{t("rentalSettings.roundTripLabel")}</label>
            <div className="flex gap-2">
              <input
                type="number"
                step="0.05"
                min="1"
                max="3"
                value={roundTrip}
                onChange={(e) => setRoundTripInput(e.target.value)}
                className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
              <span className="self-center text-sm text-slate-500">×</span>
              <button
                onClick={() => {
                  const m = parseFloat(roundTrip);
                  if (isNaN(m) || m < 1) return toast.error(t("rentalSettings.invalidValue"));
                  updateSetting.mutate({ key: "freight_round_trip_multiplier", value: m.toFixed(2), description: "Round-trip freight multiplier; 2.0 = full double, 1.8 = 10% off round trip" });
                  setRoundTripInput(null);
                }}
                className="btn-secondary text-sm"
              >
                {t("rentalSettings.save")}
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1">{t("rentalSettings.roundTripHint")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
