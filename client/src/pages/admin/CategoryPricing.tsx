import { useState, useCallback, Fragment } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { DollarSign, Save, Package, Calendar, History, ChevronDown, ChevronRight } from "lucide-react";
import { CategoryTypeBadge } from "@/components/CategoryManager";
import { DEFAULT_TIMEZONE } from "@/lib/dateUtils";

interface CategoryRow {
  category: string;
  equipmentType: "machine" | "attachment";
  dailyRate: string;
  weeklyRate: string;
  monthlyRate: string;
  totalAssets: number;
  availableAssets: number;
  dirty: boolean;
}

export default function CategoryPricing() {
  const { t } = useTranslation(["fleet", "common"]);
  const utils = trpc.useUtils();
  const { data: categoriesData, isLoading: catLoading } = trpc.equipmentCategories.listActive.useQuery();
  const { data: modelsData, isLoading: modelsLoading } = trpc.equipmentModels.list.useQuery();
  const updateCategoryRates = trpc.equipmentModels.updateCategoryRates.useMutation({
    onSuccess: () => {
      utils.equipmentModels.list.invalidate();
    },
  });

  const [edits, setEdits] = useState<Record<string, Partial<CategoryRow>>>({});
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: DEFAULT_TIMEZONE });
  const [effectiveDate, setEffectiveDate] = useState(todayStr);
  const [expanded, setExpanded] = useState<string | null>(null);
  const isScheduled = effectiveDate > todayStr;

  const isLoading = catLoading || modelsLoading;

  // Build category rows from equipment_categories, enriched with model data
  const categories: CategoryRow[] = (() => {
    if (!categoriesData) return [];

    // Aggregate model data by category — pick first non-empty rate across all models
    const modelMap = new Map<string, { dailyRate: string; weeklyRate: string; monthlyRate: string; totalAssets: number; availableAssets: number }>();
    if (modelsData) {
      for (const m of modelsData) {
        const existing = modelMap.get(m.category);
        if (existing) {
          existing.totalAssets += m.totalAssets;
          existing.availableAssets += m.availableAssets;
          if (!existing.dailyRate && m.dailyRate) existing.dailyRate = m.dailyRate;
          if (!existing.weeklyRate && m.weeklyRate) existing.weeklyRate = m.weeklyRate;
          if (!existing.monthlyRate && m.monthlyRate) existing.monthlyRate = m.monthlyRate;
        } else {
          modelMap.set(m.category, {
            dailyRate: m.dailyRate || "",
            weeklyRate: m.weeklyRate || "",
            monthlyRate: m.monthlyRate || "",
            totalAssets: m.totalAssets,
            availableAssets: m.availableAssets,
          });
        }
      }
    }

    return categoriesData.map((cat) => {
      const modelInfo = modelMap.get(cat.name);
      return {
        category: cat.name,
        equipmentType: cat.equipmentType,
        dailyRate: modelInfo?.dailyRate || "",
        weeklyRate: modelInfo?.weeklyRate || "",
        monthlyRate: modelInfo?.monthlyRate || "",
        totalAssets: modelInfo?.totalAssets || 0,
        availableAssets: modelInfo?.availableAssets || 0,
        dirty: false,
      };
    });
  })();

  const getEditedValue = (cat: string, field: keyof CategoryRow): string => {
    const edit = edits[cat];
    if (edit && field in edit) return (edit as Record<string, string>)[field];
    const row = categories.find((c) => c.category === cat);
    return row ? (row[field] as string) : "";
  };

  const handleChange = useCallback((cat: string, field: string, value: string) => {
    setEdits((prev) => ({
      ...prev,
      [cat]: { ...prev[cat], [field]: value },
    }));
  }, []);

  const hasDirtyRows = Object.keys(edits).length > 0;

  const handleSaveAll = async () => {
    const promises = Object.entries(edits).map(([category, changes]) => {
      const payload: { category: string; dailyRate?: string; weeklyRate?: string; monthlyRate?: string; effectiveFrom: string } = { category, effectiveFrom: effectiveDate };
      if ("dailyRate" in changes) payload.dailyRate = changes.dailyRate || undefined;
      if ("weeklyRate" in changes) payload.weeklyRate = changes.weeklyRate || undefined;
      if ("monthlyRate" in changes) payload.monthlyRate = changes.monthlyRate || undefined;
      return updateCategoryRates.mutateAsync(payload);
    });

    try {
      await Promise.all(promises);
      await utils.equipmentModels.list.refetch();
      setEdits({});
      toast.success(isScheduled
        ? t("categoryPricing.scheduledSaved", { date: effectiveDate, defaultValue: `Price change scheduled for ${effectiveDate}` })
        : t("categoryPricing.saved"));
    } catch {
      toast.error(t("categoryPricing.saveFailed", { defaultValue: "Failed to save" }));
    }
  };

  const inputClass = "bg-white border border-slate-300 rounded px-2 py-1.5 text-sm text-right w-28 focus:ring-1 focus:ring-[var(--primary)]/50 focus:border-[var(--primary)]";

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("categoryPricing.title")}</h1>
            <p className="text-sm text-slate-500 mt-1">{t("categoryPricing.subtitle")}</p>
          </div>
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--muted-foreground)] flex items-center gap-1">
                <Calendar size={12} /> {t("categoryPricing.effectiveDate", { defaultValue: "Effective date" })}
              </label>
              <input
                type="date"
                value={effectiveDate}
                min={todayStr}
                onChange={(e) => setEffectiveDate(e.target.value || todayStr)}
                className="bg-white border border-slate-300 rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-[var(--primary)]/50 focus:border-[var(--primary)]"
              />
            </div>
            <button
              onClick={handleSaveAll}
              disabled={!hasDirtyRows || updateCategoryRates.isPending}
              className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={18} />
              {updateCategoryRates.isPending
                ? t("saving", { ns: "common", defaultValue: "Saving..." })
                : isScheduled
                  ? t("categoryPricing.schedule", { defaultValue: "Schedule change" })
                  : t("categoryPricing.saveAll")}
            </button>
          </div>
        </div>
        {isScheduled && (
          <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <Calendar size={14} />
            {t("categoryPricing.scheduledHint", { date: effectiveDate, defaultValue: `Changes take effect on ${effectiveDate}. Current prices stay active until then; orders booked before that date keep the old price.` })}
          </div>
        )}

        <div className="card overflow-x-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="spinner" />
              <span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span>
            </div>
          ) : categories.length === 0 ? (
            <div className="py-12 text-center text-slate-400">{t("categoryPricing.noCategories")}</div>
          ) : (
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="bg-[var(--surface-container-low)]/50">
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)]">{t("categoryPricing.category")}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)] text-right">{t("dailyRate")}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)] text-right">{t("weeklyRate")}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)] text-right">{t("monthlyRate")}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)] text-center">{t("categoryPricing.assetCount")}</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((row) => {
                  const isDirty = !!edits[row.category];
                  const isOpen = expanded === row.category;
                  return (
                    <Fragment key={row.category}>
                    <tr
                      className={`hover:bg-[var(--surface-container-low)]/30 transition-colors ${isDirty ? "bg-amber-50/50" : ""}`}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setExpanded(isOpen ? null : row.category)}
                            className="text-slate-400 hover:text-[var(--primary)]"
                            title={t("categoryPricing.priceHistory", { defaultValue: "Price history" })}
                          >
                            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                          </button>
                          <Package size={16} className="text-slate-400" />
                          <span className="font-medium text-slate-900">{row.category}</span>
                          <CategoryTypeBadge type={row.equipmentType} />
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <DollarSign size={14} className="text-slate-400" />
                          <input
                            type="text"
                            inputMode="decimal"
                            value={getEditedValue(row.category, "dailyRate")}
                            onChange={(e) => handleChange(row.category, "dailyRate", e.target.value)}
                            className={inputClass}
                            placeholder="0.00"
                          />
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <DollarSign size={14} className="text-slate-400" />
                          <input
                            type="text"
                            inputMode="decimal"
                            value={getEditedValue(row.category, "weeklyRate")}
                            onChange={(e) => handleChange(row.category, "weeklyRate", e.target.value)}
                            className={inputClass}
                            placeholder="0.00"
                          />
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <DollarSign size={14} className="text-slate-400" />
                          <input
                            type="text"
                            inputMode="decimal"
                            value={getEditedValue(row.category, "monthlyRate")}
                            onChange={(e) => handleChange(row.category, "monthlyRate", e.target.value)}
                            className={inputClass}
                            placeholder="0.00"
                          />
                        </div>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="text-slate-600">{row.totalAssets}</span>
                        <span className="text-slate-400 text-xs ml-1">({row.availableAssets} {t("categoryPricing.available")})</span>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={5} className="bg-slate-50/70 px-6 py-4">
                          <CategoryTimeline category={row.category} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}

function CategoryTimeline({ category }: { category: string }) {
  const { t } = useTranslation(["fleet", "common"]);
  const { data, isLoading } = trpc.equipmentModels.categoryPriceTimeline.useQuery({ category });

  const fmtDate = (d: string | Date | null) =>
    d ? new Date(d).toLocaleDateString("en-CA", { timeZone: DEFAULT_TIMEZONE }) : t("categoryPricing.present", { defaultValue: "present" });
  const fmtMoney = (v: string | null) => (v ? `$${parseFloat(v).toLocaleString()}` : "—");

  if (isLoading) return <div className="text-xs text-slate-400">{t("loading", { ns: "common" })}</div>;
  if (!data || data.length === 0) return <div className="text-xs text-slate-400">{t("categoryPricing.noHistory", { defaultValue: "No price history yet" })}</div>;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[var(--muted-foreground)]">
        <History size={12} /> {t("categoryPricing.priceHistory", { defaultValue: "Price history" })}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-400">
            <th className="text-left font-medium py-1 pr-4">{t("categoryPricing.effectivePeriod", { defaultValue: "Effective period" })}</th>
            <th className="text-right font-medium py-1 pr-4">{t("dailyRate")}</th>
            <th className="text-right font-medium py-1 pr-4">{t("weeklyRate")}</th>
            <th className="text-right font-medium py-1 pr-4">{t("monthlyRate")}</th>
            <th className="text-left font-medium py-1">{t("categoryPricing.status", { defaultValue: "Status" })}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((v, i) => (
            <tr key={i} className={v.isCurrent ? "text-slate-900 font-medium" : "text-slate-500"}>
              <td className="py-1 pr-4">{fmtDate(v.effectiveFrom)} → {fmtDate(v.effectiveTo)}</td>
              <td className="py-1 pr-4 text-right">{fmtMoney(v.dailyRate)}</td>
              <td className="py-1 pr-4 text-right">{fmtMoney(v.weeklyRate)}</td>
              <td className="py-1 pr-4 text-right">{fmtMoney(v.monthlyRate)}</td>
              <td className="py-1">
                {v.isCurrent && <span className="inline-block px-1.5 py-0.5 rounded bg-green-100 text-green-700">{t("categoryPricing.current", { defaultValue: "Current" })}</span>}
                {v.isFuture && <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{t("categoryPricing.scheduledTag", { defaultValue: "Scheduled" })}</span>}
                {!v.isCurrent && !v.isFuture && <span className="text-slate-400">{t("categoryPricing.past", { defaultValue: "Past" })}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
