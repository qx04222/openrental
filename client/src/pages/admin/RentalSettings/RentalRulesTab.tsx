import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Pencil, X } from "lucide-react";

interface RuleDef {
  key: string;
  label: string;
  value: string;
  suffix: string;
  type: "number" | "text" | "select" | "toggle" | "textarea" | "business_hours";
  options?: { value: string; label: string }[];
}

export default function RentalRulesTab() {
  const { t } = useTranslation("admin");
  const { data: settings, refetch } = trpc.rentalSettings.getAll.useQuery({ category: "rental_rules" });
  const { data: hours, refetch: refetchHours } = trpc.rentalSettings.getBusinessHours.useQuery();
  const updateSetting = trpc.rentalSettings.update.useMutation({
    onSuccess: () => { refetch(); toast.success(t("rentalSettings.save")); },
  });
  const saveHoursMut = trpc.rentalSettings.saveBusinessHours.useMutation({
    onSuccess: () => { refetchHours(); toast.success(t("rentalSettings.save")); },
  });

  const getVal = (key: string, fallback: string) => settings?.find((s) => s.key === key)?.value || fallback;

  const rules: RuleDef[] = [
    { key: "min_rental_days", label: t("rules.minRentalDays"), value: getVal("min_rental_days", "1"), suffix: t("rules.days"), type: "number" },
    { key: "max_rental_days", label: t("rules.maxRentalDays"), value: getVal("max_rental_days", "365"), suffix: t("rules.days"), type: "number" },
    { key: "advance_booking_days", label: t("rules.advanceBooking"), value: getVal("advance_booking_days", "1"), suffix: t("rules.days"), type: "number" },
    { key: "min_billing_days", label: t("rules.minBillingDays"), value: getVal("min_billing_days", "1"), suffix: t("rules.days"), type: "number" },
    { key: "overtime_rate_percent", label: t("rules.overtimeRate"), value: getVal("overtime_rate_percent", "150"), suffix: "%", type: "number" },
    { key: "late_return_penalty_percent", label: t("rules.lateReturnPenalty"), value: getVal("late_return_penalty_percent", "150"), suffix: "%", type: "number" },
    { key: "max_equipment_per_customer", label: t("rules.maxEquipmentPerCustomer"), value: getVal("max_equipment_per_customer", "0"), suffix: t("rules.zeroUnlimited"), type: "number" },
    { key: "depreciation_useful_life_years", label: t("rules.depreciationLife"), value: getVal("depreciation_useful_life_years", "7"), suffix: t("rules.years"), type: "number" },
    { key: "depreciation_salvage_pct", label: t("rules.depreciationSalvage"), value: getVal("depreciation_salvage_pct", "10"), suffix: "%", type: "number" },
    { key: "financing_term_months", label: t("rules.financingTerms"), value: getVal("financing_term_months", "36,48"), suffix: "", type: "text" },
    {
      key: "default_fuel_policy", label: t("rules.defaultFuelPolicy"), value: getVal("default_fuel_policy", "full_to_full"), suffix: "", type: "select",
      options: [
        { value: "full_to_full", label: t("rules.fuelFullToFull") },
        { value: "included", label: t("rules.fuelIncluded") },
        { value: "excluded", label: t("rules.fuelExcluded") },
      ],
    },
    { key: "require_insurance", label: t("rules.requireInsurance"), value: getVal("require_insurance", "false"), suffix: "", type: "toggle" },
    { key: "weekend_billable", label: t("rules.weekendBillable"), value: getVal("weekend_billable", "true"), suffix: "", type: "toggle" },
    { key: "cancellation_policy", label: t("rules.cancellationPolicy"), value: getVal("cancellation_policy", ""), suffix: "", type: "textarea" },
    { key: "business_hours", label: t("rules.businessHours"), value: `${hours?.start || "08:00"} - ${hours?.end || "17:00"} (${hours?.days || "Mon-Fri"})`, suffix: "", type: "business_hours" },
  ];

  const [editKey, setEditKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [bhStart, setBhStart] = useState("08:00");
  const [bhEnd, setBhEnd] = useState("17:00");
  const [bhDays, setBhDays] = useState("Mon,Tue,Wed,Thu,Fri");

  const editingRule = rules.find((r) => r.key === editKey);

  const openEdit = (rule: RuleDef) => {
    setEditKey(rule.key);
    if (rule.key === "business_hours") {
      setBhStart(hours?.start || "08:00");
      setBhEnd(hours?.end || "17:00");
      setBhDays(hours?.days || "Mon,Tue,Wed,Thu,Fri");
    } else {
      setEditValue(rule.value);
    }
  };

  const handleSave = () => {
    if (!editKey) return;
    if (editKey === "business_hours") {
      saveHoursMut.mutate({ start: bhStart, end: bhEnd, days: bhDays });
    } else {
      updateSetting.mutate({ key: editKey, value: editValue });
    }
    setEditKey(null);
  };

  const dayLabels: Record<string, string> = {
    Mon: t("rules.dayMon"),
    Tue: t("rules.dayTue"),
    Wed: t("rules.dayWed"),
    Thu: t("rules.dayThu"),
    Fri: t("rules.dayFri"),
    Sat: t("rules.daySat"),
    Sun: t("rules.daySun"),
  };
  const allDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const selectedBhDays = bhDays.split(",").filter(Boolean);
  const toggleDay = (day: string) => {
    const current = new Set(selectedBhDays);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    setBhDays(allDays.filter((d) => current.has(d)).join(","));
  };

  const formatDisplayValue = (rule: RuleDef) => {
    if (rule.type === "toggle") {
      return rule.value === "true" ? t("rules.yes") : t("rules.no");
    }
    if (rule.type === "select" && rule.options) {
      const opt = rule.options.find((o) => o.value === rule.value);
      return opt?.label || rule.value;
    }
    if (rule.type === "textarea") {
      return rule.value || t("rules.notSet");
    }
    if (rule.key === "max_equipment_per_customer" && rule.value === "0") {
      return t("rules.unlimited");
    }
    return `${rule.value}${rule.suffix ? ` ${rule.suffix}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{t("rules.title")}</h3>
          <p className="text-sm text-slate-500 mt-1">{t("rules.subtitle")}</p>
        </div>
      </div>

      {/* Rules table */}
      <div className="rounded-xl border border-slate-200 shadow-sm bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-4 py-3 font-medium text-slate-600">{t("rules.rule")}</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">{t("rules.value")}</th>
                <th className="text-right px-4 py-3 font-medium text-slate-600">{t("rules.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.key} className="border-b border-slate-100 hover:bg-slate-50 transition">
                  <td className="px-4 py-3 text-slate-900 font-medium">{rule.label}</td>
                  <td className="px-4 py-3">
                    {rule.type === "toggle" ? (
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        rule.value === "true" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                      }`}>
                        {formatDisplayValue(rule)}
                      </span>
                    ) : rule.type === "textarea" && !rule.value ? (
                      <span className="text-slate-400 italic">{formatDisplayValue(rule)}</span>
                    ) : rule.type === "textarea" ? (
                      <span className="text-slate-700 line-clamp-1">{rule.value}</span>
                    ) : (
                      <span className="font-mono text-slate-700">{formatDisplayValue(rule)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openEdit(rule)}
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
          <strong>{t("rules.howRulesWork")}</strong> {t("rules.rulesExplanation")}
        </p>
      </div>

      {/* Edit Dialog */}
      {editKey && editingRule && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">
                {t("rules.editRule")}: {editingRule.label}
              </h3>
              <button onClick={() => setEditKey(null)} className="p-1.5 hover:bg-slate-100 rounded-lg transition">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {editingRule.type === "number" && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{editingRule.label}</label>
                  <input
                    type="number"
                    min="0"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                  />
                  {editingRule.suffix && (
                    <p className="text-xs text-slate-500 mt-1">{editingRule.suffix}</p>
                  )}
                </div>
              )}

              {editingRule.type === "text" && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{editingRule.label}</label>
                  <input
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                  />
                  {editingRule.suffix && (
                    <p className="text-xs text-slate-500 mt-1">{editingRule.suffix}</p>
                  )}
                </div>
              )}

              {editingRule.type === "select" && editingRule.options && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{editingRule.label}</label>
                  <select
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                  >
                    {editingRule.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {editingRule.type === "toggle" && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">{editingRule.label}</label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setEditValue("true")}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition ${
                        editValue === "true"
                          ? "bg-emerald-50 border-emerald-300 text-emerald-700"
                          : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {t("rules.yes")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditValue("false")}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition ${
                        editValue === "false"
                          ? "bg-slate-100 border-slate-400 text-slate-700"
                          : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {t("rules.no")}
                    </button>
                  </div>
                </div>
              )}

              {editingRule.type === "textarea" && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{editingRule.label}</label>
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 h-28 resize-none text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                    placeholder={t("rentalSettings.cancellationPolicy")}
                  />
                </div>
              )}

              {editingRule.type === "business_hours" && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">{t("rules.openingTime")}</label>
                      <input
                        type="time"
                        value={bhStart}
                        onChange={(e) => setBhStart(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">{t("rules.closingTime")}</label>
                      <input
                        type="time"
                        value={bhEnd}
                        onChange={(e) => setBhEnd(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">{t("rules.businessDays")}</label>
                    <div className="flex gap-1.5 flex-wrap">
                      {allDays.map((day) => (
                        <button
                          key={day}
                          type="button"
                          onClick={() => toggleDay(day)}
                          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                            selectedBhDays.includes(day)
                              ? "bg-[var(--primary)] text-white border-[var(--primary)]"
                              : "bg-white text-slate-600 border-slate-300"
                          }`}
                        >
                          {dayLabels[day]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button
                onClick={() => setEditKey(null)}
                className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800"
              >
                {t("rentalSettings.cancel")}
              </button>
              <button
                onClick={handleSave}
                disabled={updateSetting.isPending || saveHoursMut.isPending}
                className="btn-primary text-sm"
              >
                {updateSetting.isPending || saveHoursMut.isPending ? t("depositRules.saving") : t("rentalSettings.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
