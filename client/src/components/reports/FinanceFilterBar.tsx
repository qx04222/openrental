import { useTranslation } from "react-i18next";
import { Filter, RotateCcw } from "lucide-react";
import { CUSTOMER_INDUSTRIES, industryI18nKey, type CustomerIndustry } from "@shared/customerClassification";

export type FinancePreset =
  | "thisMonth"
  | "lastMonth"
  | "thisQuarter"
  | "thisYear"
  | "last12m"
  | "allTime"
  | "custom";

/** Raw UI state held by the parent — survives tab switches. */
export type FinanceFilterState = {
  preset: FinancePreset;
  startDate: string; // YYYY-MM-DD, only used when preset === "custom"
  endDate: string;
  locationId?: number;
  category?: string;
  equipmentModelId?: number;
  customerId?: number;
  industry?: CustomerIndustry;
};

export const DEFAULT_FINANCE_FILTER: FinanceFilterState = {
  preset: "allTime",
  startDate: "",
  endDate: "",
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

/**
 * Turns the UI state into the query input the reports endpoints expect.
 * Date presets are resolved against the browser's clock; "allTime" sends no
 * date bounds (matching the historical, unfiltered behaviour).
 */
export function resolveFinanceFilter(s: FinanceFilterState): {
  startDate?: string;
  endDate?: string;
  locationId?: number;
  category?: string;
  equipmentModelId?: number;
  customerId?: number;
  industry?: CustomerIndustry;
} {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  let start: Date | null = null;
  let end: Date | null = endOfDay(now);

  switch (s.preset) {
    case "thisMonth":
      start = new Date(y, m, 1);
      break;
    case "lastMonth":
      start = new Date(y, m - 1, 1);
      end = endOfDay(new Date(y, m, 0)); // day 0 of this month = last day of prev
      break;
    case "thisQuarter":
      start = new Date(y, Math.floor(m / 3) * 3, 1);
      break;
    case "thisYear":
      start = new Date(y, 0, 1);
      break;
    case "last12m":
      start = new Date(y, m - 11, 1);
      break;
    case "custom":
      start = s.startDate ? startOfDay(new Date(s.startDate)) : null;
      end = s.endDate ? endOfDay(new Date(s.endDate)) : null;
      break;
    case "allTime":
    default:
      start = null;
      end = null;
  }

  return {
    startDate: start ? start.toISOString() : undefined,
    endDate: end ? end.toISOString() : undefined,
    locationId: s.locationId,
    category: s.category,
    equipmentModelId: s.equipmentModelId,
    customerId: s.customerId,
    industry: s.industry,
  };
}

type Option = { id: number; name: string };
type CustomerOption = { id: number; name: string; company?: string | null };
type ModelOption = { id: number; displayName?: string | null; brand?: string | null; model?: string | null };

export default function FinanceFilterBar({
  state,
  onChange,
  warehouses,
  categories,
  customers,
  models = [],
}: {
  state: FinanceFilterState;
  onChange: (patch: Partial<FinanceFilterState>) => void;
  warehouses: Option[];
  categories: { name: string }[];
  customers: CustomerOption[];
  models?: ModelOption[];
}) {
  const { t } = useTranslation("dashboard");
  const { t: tAdmin } = useTranslation("admin");

  const presets: FinancePreset[] = [
    "thisMonth",
    "lastMonth",
    "thisQuarter",
    "thisYear",
    "last12m",
    "allTime",
    "custom",
  ];

  const isDirty =
    state.preset !== DEFAULT_FINANCE_FILTER.preset ||
    state.locationId != null ||
    state.category != null ||
    state.equipmentModelId != null ||
    state.customerId != null ||
    state.industry != null;

  const selectCls =
    "h-9 rounded-lg border border-slate-200 bg-[var(--surface-container-lowest)] px-2 text-sm text-[var(--on-surface)] focus:border-[var(--primary)] focus:outline-none";

  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 flex flex-wrap items-end gap-3">
      <div className="flex items-center gap-2 text-slate-500 mr-1">
        <Filter size={16} />
      </div>

      {/* Period */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-500">{t("reports.filter.period")}</span>
        <select
          className={selectCls}
          value={state.preset}
          onChange={(e) => onChange({ preset: e.target.value as FinancePreset })}
        >
          {presets.map((p) => (
            <option key={p} value={p}>
              {t(`reports.filter.preset.${p}`)}
            </option>
          ))}
        </select>
      </label>

      {/* Custom range inputs — only when "custom" */}
      {state.preset === "custom" && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500">{t("reports.filter.from")}</span>
            <input
              type="date"
              className={selectCls}
              value={state.startDate}
              max={state.endDate || undefined}
              onChange={(e) => onChange({ startDate: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-slate-500">{t("reports.filter.to")}</span>
            <input
              type="date"
              className={selectCls}
              value={state.endDate}
              min={state.startDate || undefined}
              onChange={(e) => onChange({ endDate: e.target.value })}
            />
          </label>
        </>
      )}

      {/* Warehouse */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-500">{t("reports.filter.warehouse")}</span>
        <select
          className={selectCls}
          value={state.locationId ?? ""}
          onChange={(e) => onChange({ locationId: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">{t("reports.filter.all")}</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>

      {/* Category */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-500">{t("reports.filter.category")}</span>
        <select
          className={selectCls}
          value={state.category ?? ""}
          onChange={(e) => onChange({ category: e.target.value || undefined })}
        >
          <option value="">{t("reports.filter.all")}</option>
          {categories.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {/* Equipment model (车型) */}
      {models.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-slate-500">{t("reports.filter.model")}</span>
          <select
            className={`${selectCls} max-w-[200px]`}
            value={state.equipmentModelId ?? ""}
            onChange={(e) => onChange({ equipmentModelId: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">{t("reports.filter.all")}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName || `${m.brand ?? ""} ${m.model ?? ""}`.trim()}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Customer industry */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-500">{t("reports.filter.industry")}</span>
        <select
          className={selectCls}
          value={state.industry ?? ""}
          onChange={(e) => onChange({ industry: (e.target.value || undefined) as CustomerIndustry | undefined })}
        >
          <option value="">{t("reports.filter.all")}</option>
          {CUSTOMER_INDUSTRIES.map((v) => (
            <option key={v} value={v}>
              {tAdmin(industryI18nKey(v))}
            </option>
          ))}
        </select>
      </label>

      {/* Customer */}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-slate-500">{t("reports.filter.customer")}</span>
        <select
          className={`${selectCls} max-w-[200px]`}
          value={state.customerId ?? ""}
          onChange={(e) => onChange({ customerId: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">{t("reports.filter.all")}</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.company ? `${c.name} · ${c.company}` : c.name}
            </option>
          ))}
        </select>
      </label>

      {isDirty && (
        <button
          type="button"
          onClick={() => onChange(DEFAULT_FINANCE_FILTER)}
          className="h-9 flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 transition"
        >
          <RotateCcw size={14} /> {t("reports.filter.reset")}
        </button>
      )}
    </div>
  );
}
