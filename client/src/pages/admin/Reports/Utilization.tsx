/**
 * Fleet Utilization Dashboard — feature #20
 * Gated by the utilization_dashboard feature flag.
 */
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { exportToCSV } from "@/lib/exportUtils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Download, ArrowUp, ArrowDown, Minus, Lock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────

type SortKey =
  | "assetNumber"
  | "brand"
  | "warehouseName"
  | "rentedDays"
  | "maintenanceDays"
  | "idleDays"
  | "utilizationPct";

interface AssetRow {
  fleetId: number;
  assetNumber: string | null;
  brand: string;
  model: string;
  warehouseName: string | null;
  rentedDays: number;
  maintenanceDays: number;
  idleDays: number;
  totalDays: number;
  utilizationPct: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function toIso(date: Date): string {
  return date.toISOString().split("T")[0];
}

function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return toIso(d);
}

function defaultEnd(): string {
  return toIso(new Date());
}

function pctColor(pct: number): string {
  if (pct >= 70) return "#10B981";
  if (pct >= 40) return "#F59E0B";
  return "#2563EB";
}

const IDLE_COLOR = "#6B7280";
const MAINT_COLOR = "#8B5CF6";

// ── Sub-components ───────────────────────────────────────────────────

function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  if (dir === "asc") return <ArrowUp size={12} className="inline ml-1" />;
  if (dir === "desc") return <ArrowDown size={12} className="inline ml-1" />;
  return <Minus size={12} className="inline ml-1 opacity-20" />;
}

function SummaryBar({
  averageUtilizationPct,
  fleetCount,
}: {
  averageUtilizationPct: number;
  fleetCount: number;
}) {
  return (
    <div className="flex gap-6 flex-wrap">
      <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm px-6 py-4 flex-1 min-w-[180px]">
        <p className="text-xs font-bold text-[var(--muted-foreground)] uppercase tracking-widest mb-1">
          Average Utilization
        </p>
        <p
          className="text-3xl font-extrabold tracking-tight font-headline"
          style={{ color: pctColor(averageUtilizationPct) }}
        >
          {averageUtilizationPct.toFixed(1)}%
        </p>
      </div>
      <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm px-6 py-4 flex-1 min-w-[180px]">
        <p className="text-xs font-bold text-[var(--muted-foreground)] uppercase tracking-widest mb-1">
          Fleet Assets
        </p>
        <p className="text-3xl font-extrabold tracking-tight font-headline text-[var(--on-surface)]">
          {fleetCount}
        </p>
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

export default function Utilization() {
  const { t } = useTranslation("admin");
  const enabled = useFeatureFlag("utilization_dashboard");

  const [startDate, setStartDate] = useState<string>(defaultStart);
  const [endDate, setEndDate] = useState<string>(defaultEnd);
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "utilizationPct",
    dir: "desc",
  });

  const { data: warehouses } = trpc.warehouses.list.useQuery();

  const { data, isLoading } = trpc.reports.utilizationByFleet.useQuery(
    {
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      warehouseId: warehouseId ? Number(warehouseId) : undefined,
    },
    {},
  );

  const assets: AssetRow[] = useMemo(() => {
    const rows = data?.assets ?? [];
    return [...rows].sort((a, b) => {
      const aVal = a[sort.key] ?? "";
      const bVal = b[sort.key] ?? "";
      if (typeof aVal === "number" && typeof bVal === "number") {
        return sort.dir === "asc" ? aVal - bVal : bVal - aVal;
      }
      const aStr = String(aVal);
      const bStr = String(bVal);
      return sort.dir === "asc"
        ? aStr.localeCompare(bStr)
        : bStr.localeCompare(aStr);
    });
  }, [data, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  }

  function handleExportCSV() {
    exportToCSV(
      assets.map((a) => ({
        assetNumber: a.assetNumber ?? "",
        name: `${a.brand} ${a.model}`,
        warehouse: a.warehouseName ?? "",
        rentedDays: a.rentedDays,
        maintenanceDays: a.maintenanceDays,
        idleDays: a.idleDays,
        totalDays: a.totalDays,
        utilizationPct: a.utilizationPct,
      })),
      "fleet_utilization",
      [
        { key: "assetNumber", label: "Asset #" },
        { key: "name", label: "Asset" },
        { key: "warehouse", label: "Warehouse" },
        { key: "rentedDays", label: "Rented Days" },
        { key: "maintenanceDays", label: "Maintenance Days" },
        { key: "idleDays", label: "Idle Days" },
        { key: "totalDays", label: "Total Days" },
        { key: "utilizationPct", label: "Utilization %" },
      ],
    );
  }

  const topUtilization = useMemo(
    () =>
      [...(data?.assets ?? [])]
        .sort((a, b) => b.utilizationPct - a.utilizationPct)
        .slice(0, 10)
        .map((a) => ({
          name: a.assetNumber ?? `${a.brand} ${a.model}`.slice(0, 12),
          value: a.utilizationPct,
        })),
    [data],
  );

  const topIdle = useMemo(
    () =>
      (data?.topIdle ?? []).map((a) => ({
        name: a.assetNumber ?? `${a.brand} ${a.model}`.slice(0, 12),
        value: a.idleDays,
      })),
    [data],
  );

  const th = (key: SortKey, label: string) => (
    <th
      key={key}
      className="px-3 py-2 text-left text-xs font-bold uppercase tracking-wider cursor-pointer select-none hover:bg-gray-50 whitespace-nowrap"
      onClick={() => toggleSort(key)}
    >
      {label}
      <SortIcon dir={sort.key === key ? sort.dir : null} />
    </th>
  );

  if (!enabled) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center h-96 gap-4 text-center">
          <Lock size={48} className="text-[var(--muted-foreground)] opacity-30" />
          <p className="text-lg font-semibold text-[var(--on-surface)]">
            Fleet Utilization Dashboard
          </p>
          <p className="text-sm text-[var(--muted-foreground)] max-w-sm">
            This feature is not enabled for your account. Contact your
            administrator to enable the utilization_dashboard flag.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 p-6">
        {/* Page header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-extrabold font-headline text-[var(--on-surface)]">
              Fleet Utilization Dashboard
            </h1>
            <p className="text-sm text-[var(--muted-foreground)] mt-0.5">
              Per-asset rented, idle, and maintenance days over a selected range.
            </p>
          </div>
          <button
            onClick={handleExportCSV}
            disabled={assets.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--primary)] text-white text-sm font-semibold disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            <Download size={16} />
            Export CSV
          </button>
        </div>

        {/* Filters */}
        <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 flex flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-[var(--muted-foreground)] uppercase tracking-wide">
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              max={endDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="border border-[var(--border)] rounded-md px-3 py-1.5 text-sm bg-[var(--surface-container)] text-[var(--on-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-[var(--muted-foreground)] uppercase tracking-wide">
              End Date
            </label>
            <input
              type="date"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="border border-[var(--border)] rounded-md px-3 py-1.5 text-sm bg-[var(--surface-container)] text-[var(--on-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-[var(--muted-foreground)] uppercase tracking-wide">
              Warehouse
            </label>
            <select
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              className="border border-[var(--border)] rounded-md px-3 py-1.5 text-sm bg-[var(--surface-container)] text-[var(--on-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
            >
              <option value="">{t("utilization.allWarehouses")}</option>
              {(warehouses ?? []).map((w) => (
                <option key={w.id} value={String(w.id)}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Summary bar */}
        <SummaryBar
          averageUtilizationPct={data?.averageUtilizationPct ?? 0}
          fleetCount={assets.length}
        />

        {/* Content grid: table + charts */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Table */}
          <div className="xl:col-span-2 bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              {isLoading ? (
                <div className="flex items-center justify-center h-48 text-[var(--muted-foreground)] text-sm">
                  Loading...
                </div>
              ) : assets.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-[var(--muted-foreground)] text-sm">
                  No fleet assets found for the selected filters.
                </div>
              ) : (
                <table className="w-full text-sm text-[var(--on-surface)]">
                  <thead className="bg-gray-50 border-b border-[var(--border)] text-[var(--muted-foreground)]">
                    <tr>
                      {th("assetNumber", "Asset #")}
                      {th("brand", "Asset")}
                      {th("warehouseName", "Warehouse")}
                      {th("rentedDays", "Rented")}
                      {th("maintenanceDays", "Maint.")}
                      {th("idleDays", "Idle")}
                      {th("utilizationPct", "Util %")}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {assets.map((row) => (
                      <tr
                        key={row.fleetId}
                        className="hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-3 py-2 font-mono text-xs">
                          {row.assetNumber ?? "—"}
                        </td>
                        <td className="px-3 py-2 font-medium">
                          {row.brand} {row.model}
                        </td>
                        <td className="px-3 py-2 text-[var(--muted-foreground)]">
                          {row.warehouseName ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {row.rentedDays.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-purple-600">
                          {row.maintenanceDays.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--muted-foreground)]">
                          {row.idleDays.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span
                            className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-bold text-white"
                            style={{ backgroundColor: pctColor(row.utilizationPct) }}
                          >
                            {row.utilizationPct.toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Charts */}
          <div className="flex flex-col gap-6">
            {/* Top 10 by utilization */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-bold text-[var(--on-surface)] mb-3 font-headline">
                Top 10 Utilization
              </h3>
              {topUtilization.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-[var(--muted-foreground)] text-xs">
                  No data
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={topUtilization}
                    layout="vertical"
                    margin={{ left: 8, right: 16 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      tickFormatter={(v) => `${v}%`}
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={60}
                      tick={{ fontSize: 10 }}
                    />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                      {topUtilization.map((entry, i) => (
                        <Cell key={i} fill={pctColor(Number(entry.value))} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Top 10 idle */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-bold text-[var(--on-surface)] mb-3 font-headline">
                Most Idle Assets (days)
              </h3>
              {topIdle.length === 0 ? (
                <div className="flex items-center justify-center h-48 text-[var(--muted-foreground)] text-xs">
                  No idle assets
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={topIdle}
                    layout="vertical"
                    margin={{ left: 8, right: 16 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={60}
                      tick={{ fontSize: 10 }}
                    />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" fill={IDLE_COLOR} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Top maintenance */}
            {(data?.topMaintenance ?? []).length > 0 && (
              <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4">
                <h3 className="text-sm font-bold text-[var(--on-surface)] mb-3 font-headline">
                  Most Maintenance (days)
                </h3>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart
                    data={(data?.topMaintenance ?? []).map((a) => ({
                      name: a.assetNumber ?? `${a.brand} ${a.model}`.slice(0, 12),
                      value: a.maintenanceDays,
                    }))}
                    layout="vertical"
                    margin={{ left: 8, right: 16 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={60}
                      tick={{ fontSize: 10 }}
                    />
                    <Tooltip contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="value" fill={MAINT_COLOR} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
