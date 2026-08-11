import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import FinanceFilterBar, {
  resolveFinanceFilter,
  DEFAULT_FINANCE_FILTER,
  type FinanceFilterState,
} from "@/components/reports/FinanceFilterBar";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
  type PieLabelRenderProps,
} from "recharts";
import { DollarSign, FileText, TrendingUp, Activity, Gauge, Truck, Users, Wrench, Calculator, type LucideIcon } from "lucide-react";
import ExportToolbar from "@/components/ExportToolbar";
import { serverErrorText } from "@/lib/serverError";
import { industryI18nKey } from "@shared/customerClassification";
import type { CustomerIndustry } from "@shared/customerClassification";

const COLORS = {
  red: "#2563EB", redLight: "#E04A3E", redLighter: "#EF7B6F",
  blue: "#3B82F6", green: "#10B981", amber: "#F59E0B", gray: "#6B7280", purple: "#8B5CF6",
};

const PIE_COLORS = [COLORS.red, COLORS.blue, COLORS.green, COLORS.amber, COLORS.redLight, COLORS.gray, COLORS.redLighter, "#8B5CF6", "#EC4899", "#14B8A6"];

const STATUS_COLORS: Record<string, string> = {
  pending: COLORS.amber, approved: COLORS.blue, active: COLORS.green,
  completed: COLORS.gray, rejected: COLORS.redLight, cancelled: COLORS.redLighter,
  overdue: COLORS.red,
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

function formatMonthLabel(yyyymm: string): string {
  const [year, month] = yyyymm.split("-");
  return new Date(Number(year), Number(month) - 1).toLocaleDateString("en-CA", { month: "short", year: "2-digit" });
}

function StatCard({ label, value, icon: Icon, color, bg }: { label: string; value: string | number; icon: LucideIcon; color: string; bg: string }) {
  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-6 relative overflow-hidden">
      <div className="relative z-10">
        <div className="flex items-center gap-3 mb-3">
          <div className={`${bg} p-2.5 rounded-xl`}><Icon size={18} className={color} /></div>
          <p className="text-xs font-bold text-[var(--muted-foreground)] uppercase tracking-widest">{label}</p>
        </div>
        <div className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)] font-headline">{value}</div>
      </div>
      <div className="absolute -right-4 -bottom-4 opacity-[0.04]">
        <Icon size={96} className={color} strokeWidth={1} />
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-6">
      <h3 className="text-sm font-bold text-[var(--on-surface)] mb-4 font-headline">{title}</h3>
      {children}
    </div>
  );
}

const tooltipStyle = { borderRadius: 8, border: "1px solid #E5E7EB", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" };

type IncomeRow = {
  rentalFee: number; insuranceCost: number; freightCost: number;
  extraCharges: number;
  lateFee: number; totalRevenue: number; taxAmount: number; depositAmount: number;
  billedTotal: number; orderCount: number;
};

/** Period-over-period change, coloured up/down. Renders an em-dash when there is no prior base. */
function DeltaBadge({ cur, prior }: { cur: number; prior: number }) {
  if (!prior) return <span className="text-slate-300">—</span>;
  const pct = ((cur - prior) / Math.abs(prior)) * 100;
  const up = pct >= 0;
  return (
    <span className={up ? "text-emerald-600" : "text-red-600"}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/** A formal income statement (P&L): revenue streams → total, then liability memo lines. */
function IncomeStatement({ data }: { data: { current: IncomeRow; prior: IncomeRow | null } }) {
  const { t } = useTranslation("dashboard");
  const c = data.current;
  const p = data.prior;
  const hasPrior = !!p;
  const cols = hasPrior ? 4 : 2;
  const Row = ({ label, cur, pri, bold, top, muted, indent }: {
    label: string; cur: number; pri?: number;
    bold?: boolean; top?: boolean; muted?: boolean; indent?: boolean;
  }) => (
    <tr className={`${top ? "border-t-2 border-slate-300" : "border-b border-slate-100"} ${bold ? "font-bold text-[var(--on-surface)]" : ""}`}>
      <td className={`py-1.5 px-3 ${indent ? "pl-6" : ""} ${muted ? "text-slate-500" : ""}`}>{label}</td>
      <td className={`py-1.5 px-3 text-right tabular-nums ${muted ? "text-slate-500" : ""}`}>{formatCurrency(cur)}</td>
      {hasPrior && <td className="py-1.5 px-3 text-right tabular-nums text-slate-500">{formatCurrency(pri ?? 0)}</td>}
      {hasPrior && <td className="py-1.5 px-3 text-right text-xs">{<DeltaBadge cur={cur} prior={pri ?? 0} />}</td>}
    </tr>
  );
  return (
    <ChartCard title={t("reports.fin.incomeStatement")}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-slate-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="py-1.5 px-3 text-left font-semibold">{t("reports.fin.lineItem")}</th>
              <th className="py-1.5 px-3 text-right font-semibold">{t("reports.fin.thisPeriod")}</th>
              {hasPrior && <th className="py-1.5 px-3 text-right font-semibold">{t("reports.fin.priorPeriod")}</th>}
              {hasPrior && <th className="py-1.5 px-3 text-right font-semibold">Δ%</th>}
            </tr>
          </thead>
          <tbody>
            <tr className="text-xs uppercase tracking-wide text-slate-400"><td className="pt-3 px-3" colSpan={cols}>{t("reports.fin.revenue")}</td></tr>
            <Row label={t("reports.fin.rentalFee")} cur={c.rentalFee} pri={p?.rentalFee} indent />
            <Row label={t("reports.fin.insuranceRevenue")} cur={c.insuranceCost} pri={p?.insuranceCost} indent />
            <Row label={t("reports.fin.freightRevenue")} cur={c.freightCost} pri={p?.freightCost} indent />
            <Row label={t("reports.fin.extraChargesRevenue")} cur={c.extraCharges} pri={p?.extraCharges} indent />
            <Row label={t("reports.fin.totalRevenue")} cur={c.totalRevenue} pri={p?.totalRevenue} bold top />
            <tr className="text-xs uppercase tracking-wide text-slate-400"><td className="pt-3 px-3" colSpan={cols}>{t("reports.fin.memoLiabilities")}</td></tr>
            <Row label={t("reports.fin.taxCollected")} cur={c.taxAmount} pri={p?.taxAmount} indent muted />
            <Row label={t("reports.fin.lateFeeAccrued")} cur={c.lateFee} pri={p?.lateFee} indent muted />
            <Row label={t("reports.fin.billedTotal")} cur={c.billedTotal} pri={p?.billedTotal} bold top />
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 mt-3">{t("reports.fin.accrualBasisNote", { count: c.orderCount })}</p>
    </ChartCard>
  );
}

type TaxProvinceRow = {
  province: string; provinceName: string; orderCount: number; taxableSales: number;
  taxCollected: number; hst: number; gst: number; pst: number; unallocated: number;
};
type TaxData = {
  byProvince: TaxProvinceRow[];
  totals: { taxableSales: number; taxCollected: number; hst: number; gst: number; pst: number; unallocated: number; orderCount: number } | null;
};

/** HST/GST remittance — filing-ready taxable sales + tax collected, by province. */
function TaxRemittance({ data }: { data: TaxData }) {
  const { t } = useTranslation("dashboard");
  if (!data.totals || data.byProvince.length === 0) return null;
  const tt = data.totals;
  const csvRows = data.byProvince.map((p) => ({
    province: p.provinceName, taxableSales: p.taxableSales, hst: p.hst,
    gst: p.gst, pst: p.pst, taxCollected: p.taxCollected, orderCount: p.orderCount,
  }));
  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-[var(--on-surface)] font-headline">{t("reports.tax.title")}</h3>
        <ExportToolbar
          allData={csvRows}
          pageData={csvRows}
          selectedData={[]}
          columns={[
            { key: "province", label: t("reports.tax.province") },
            { key: "taxableSales", label: t("reports.tax.taxableSales") },
            { key: "hst", label: "HST" }, { key: "gst", label: "GST" }, { key: "pst", label: "PST" },
            { key: "taxCollected", label: t("reports.tax.taxCollected") },
            { key: "orderCount", label: t("reports.tax.orders") },
          ]}
          fileName="hst-remittance"
          title={t("reports.tax.title")}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-slate-500 text-xs uppercase tracking-wide border-b border-slate-200">
            <tr>
              <th className="py-2 px-3 text-left font-semibold">{t("reports.tax.province")}</th>
              <th className="py-2 px-3 text-right font-semibold">{t("reports.tax.taxableSales")}</th>
              <th className="py-2 px-3 text-right font-semibold">HST</th>
              <th className="py-2 px-3 text-right font-semibold">GST</th>
              <th className="py-2 px-3 text-right font-semibold">PST</th>
              <th className="py-2 px-3 text-right font-semibold">{t("reports.tax.taxCollected")}</th>
              <th className="py-2 px-3 text-right font-semibold">{t("reports.tax.orders")}</th>
            </tr>
          </thead>
          <tbody>
            {data.byProvince.map((p) => (
              <tr key={p.province} className="border-b border-slate-100">
                <td className="py-2 px-3 font-medium">{p.provinceName}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(p.taxableSales)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(p.hst)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(p.gst)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(p.pst)}</td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold">{formatCurrency(p.taxCollected)}</td>
                <td className="py-2 px-3 text-right tabular-nums text-slate-500">{p.orderCount}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-bold">
              <td className="py-2 px-3">{t("reports.tax.total")}</td>
              <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(tt.taxableSales)}</td>
              <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(tt.hst)}</td>
              <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(tt.gst)}</td>
              <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(tt.pst)}</td>
              <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(tt.taxCollected)}</td>
              <td className="py-2 px-3 text-right tabular-nums text-slate-500">{tt.orderCount}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {tt.unallocated > 0.01 && (
        <p className="text-xs text-amber-600 mt-3">{t("reports.tax.unallocatedNote", { amount: formatCurrency(tt.unallocated) })}</p>
      )}
      <p className="text-xs text-slate-400 mt-2">{t("reports.tax.basisNote")}</p>
    </div>
  );
}

type DepositData = {
  totalHeld: number; orderCount: number;
  orders: { id: number; orderNo: string; customerName: string; depositAmount: number; startDate: string | null }[];
};

/** Deposit liability — security deposits held on open rentals (point-in-time). */
function DepositLiability({ data }: { data: DepositData }) {
  const { t } = useTranslation("dashboard");
  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-6">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-bold text-[var(--on-surface)] font-headline">{t("reports.deposit.title")}</h3>
        <div className="text-2xl font-extrabold tabular-nums text-[var(--on-surface)]">{formatCurrency(data.totalHeld)}</div>
      </div>
      <p className="text-xs text-slate-400 mb-4">{t("reports.deposit.subtitle", { count: data.orderCount })}</p>
      {data.orders.length === 0 ? (
        <div className="text-sm text-slate-400 py-4 text-center">{t("reports.deposit.none")}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-500 text-xs uppercase tracking-wide border-b border-slate-200">
              <tr>
                <th className="py-2 px-3 text-left font-semibold">{t("reports.deposit.order")}</th>
                <th className="py-2 px-3 text-left font-semibold">{t("reports.fin.customer")}</th>
                <th className="py-2 px-3 text-right font-semibold">{t("reports.deposit.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((o) => (
                <tr key={o.id} className="border-b border-slate-100">
                  <td className="py-2 px-3 font-medium">{o.orderNo}</td>
                  <td className="py-2 px-3">{o.customerName}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(o.depositAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-400 mt-3">{t("reports.deposit.basisNote")}</p>
    </div>
  );
}

type CashData = {
  billed: number; collected: number; outstanding: number; collectionRate: number;
  paymentCount: number;
  byMethod: { method: string; amount: number; count: number }[];
};

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash", etransfer: "E-transfer", card: "Card", cheque: "Cheque", other: "Other",
};

/** Cash / collections — cash-basis complement to the accrual P&L. */
function CashCollections({ data }: { data: CashData }) {
  const { t } = useTranslation("dashboard");
  const stat = (label: string, value: string, tone?: string) => (
    <div className="rounded-xl bg-slate-50 p-4">
      <div className={`text-xl font-extrabold tabular-nums ${tone ?? "text-[var(--on-surface)]"}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </div>
  );
  return (
    <ChartCard title={t("reports.cash.title")}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stat(t("reports.cash.billed"), formatCurrency(data.billed))}
        {stat(t("reports.cash.collected"), formatCurrency(data.collected), "text-emerald-600")}
        {stat(t("reports.cash.outstanding"), formatCurrency(data.outstanding), "text-amber-600")}
        {stat(t("reports.cash.collectionRate"), `${data.collectionRate}%`)}
      </div>
      {data.byMethod.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-500 text-xs uppercase tracking-wide border-b border-slate-200">
              <tr>
                <th className="py-2 px-3 text-left font-semibold">{t("reports.cash.method")}</th>
                <th className="py-2 px-3 text-right font-semibold">{t("reports.cash.payments")}</th>
                <th className="py-2 px-3 text-right font-semibold">{t("reports.cash.amount")}</th>
              </tr>
            </thead>
            <tbody>
              {data.byMethod.map((m) => (
                <tr key={m.method} className="border-b border-slate-100">
                  <td className="py-2 px-3">{METHOD_LABEL[m.method] ?? m.method}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-slate-500">{m.count}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-medium">{formatCurrency(m.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-400 mt-3">{t("reports.cash.basisNote")}</p>
    </ChartCard>
  );
}

type Tab = "overview" | "financial" | "dispatch" | "equipment" | "customer" | "financing";

export default function Reports() {
  const { t } = useTranslation("dashboard");
  // industryRevenue card + industry labels live in the admin namespace
  // (shared with the customer-classification screens), not dashboard.
  const { t: tAdmin } = useTranslation("admin");
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  // Overview filter (date / warehouse / category / customer) — mirrors Finance.
  const isOverview = activeTab === "overview";
  const [overviewFilter, setOverviewFilter] = useState<FinanceFilterState>(DEFAULT_FINANCE_FILTER);
  const patchOverviewFilter = (patch: Partial<FinanceFilterState>) => setOverviewFilter((prev) => ({ ...prev, ...patch }));
  const overviewInput = useMemo(() => resolveFinanceFilter(overviewFilter), [overviewFilter]);

  // Overview (always loaded), now filtered. Utilization lives on the Equipment
  // tab only (windowed + by-category); it was removed from Overview as misleading.
  const { data: summary } = trpc.reports.summaryStats.useQuery(overviewInput);
  const { data: revenueByMonth } = trpc.reports.revenueByMonth.useQuery(overviewInput);
  const { data: statusFunnel } = trpc.reports.orderStatusFunnel.useQuery(overviewInput);
  const { data: revenueByCategory } = trpc.reports.revenueByCategory.useQuery(overviewInput);

  // Financial (lazy) — filtered by the FinanceFilterBar state
  const isFinancial = activeTab === "financial";
  const [financeFilter, setFinanceFilter] = useState<FinanceFilterState>(DEFAULT_FINANCE_FILTER);
  const patchFinanceFilter = (patch: Partial<FinanceFilterState>) => setFinanceFilter((prev) => ({ ...prev, ...patch }));
  const financeInput = useMemo(() => resolveFinanceFilter(financeFilter), [financeFilter]);

  // Filter-bar option sources (loaded for the Overview and Financial tabs)
  const { data: warehouseList } = trpc.warehouses.list.useQuery(undefined, { enabled: isFinancial || isOverview });
  const { data: categoryList } = trpc.equipmentCategories.list.useQuery(undefined, { enabled: isFinancial || isOverview });
  const { data: customerList } = trpc.customers.list.useQuery(
    { sortBy: "totalRevenue", sortDir: "desc", limit: 500 },
    { enabled: isFinancial || isOverview },
  );
  const { data: modelList } = trpc.equipmentModels.list.useQuery(undefined, { enabled: isFinancial || isOverview });

  const { data: incomeStatement } = trpc.reports.incomeStatement.useQuery(financeInput, { enabled: isFinancial });
  const { data: taxRemittance } = trpc.reports.taxRemittance.useQuery(financeInput, { enabled: isFinancial });
  const { data: depositLiability } = trpc.reports.depositLiability.useQuery(undefined, { enabled: isFinancial });
  const { data: cashCollections } = trpc.reports.cashCollections.useQuery(financeInput, { enabled: isFinancial });
  const { data: paymentStatus } = trpc.reports.paymentStatus.useQuery(financeInput, { enabled: isFinancial });
  const { data: accountsReceivable } = trpc.reports.accountsReceivable.useQuery(financeInput, { enabled: isFinancial });
  const { data: arAging } = trpc.reports.arAging.useQuery(financeInput, { enabled: isFinancial });
  const { data: heldPrepayments } = trpc.reports.heldPrepayments.useQuery(financeInput, { enabled: isFinancial });
  const { data: revenueDetailed } = trpc.reports.revenueByMonthDetailed.useQuery(financeInput, { enabled: isFinancial });

  // Dispatch (lazy)
  const { data: dispatchAnalytics } = trpc.reports.dispatchAnalytics.useQuery(undefined, { enabled: activeTab === "dispatch" });
  const { data: driverPerformance } = trpc.reports.driverPerformance.useQuery(undefined, { enabled: activeTab === "dispatch" });

  // Equipment (lazy)
  const isEquipment = activeTab === "equipment";
  const isFinancing = activeTab === "financing";
  const { data: fleetROI } = trpc.reports.fleetROI.useQuery(undefined, { enabled: isEquipment });
  const { data: conditionTrend } = trpc.reports.fleetConditionTrend.useQuery(undefined, { enabled: isEquipment });

  // Utilization window: default = season opening (first order of the year) → today; manually adjustable.
  const { data: seasonStart } = trpc.reports.seasonStart.useQuery(undefined, { enabled: isEquipment || isFinancing });
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [utilStart, setUtilStart] = useState("");
  const [utilEnd, setUtilEnd] = useState("");
  useEffect(() => {
    if (isEquipment && seasonStart && utilStart === "" && utilEnd === "") {
      setUtilStart((seasonStart.date ?? `${new Date().getFullYear()}-01-01T00:00:00.000Z`).slice(0, 10));
      setUtilEnd(todayIso);
    }
  }, [isEquipment, seasonStart, utilStart, utilEnd, todayIso]);
  const utilInput = useMemo(() => ({
    startDate: utilStart ? new Date(utilStart).toISOString() : undefined,
    endDate: utilEnd ? new Date(`${utilEnd}T23:59:59`).toISOString() : undefined,
  }), [utilStart, utilEnd]);
  const { data: equipUtilData } = trpc.reports.utilizationByFleet.useQuery(utilInput, { enabled: isEquipment });
  const equipUtilTop = (equipUtilData?.assets ?? [])
    .slice()
    .sort((a, b) => b.utilizationPct - a.utilizationPct)
    .slice(0, 10)
    .map((a) => ({ id: a.fleetId, name: `${a.brand} ${a.model}`, utilization: a.utilizationPct }));

  // Utilization exclusions: assets present in the fleet list but not actually
  // rentable — managed here, persisted in rental_settings, dropped from the stats.
  const utils = trpc.useUtils();
  const [exclOpen, setExclOpen] = useState(false);
  const [exclSearch, setExclSearch] = useState("");
  const [exclDraft, setExclDraft] = useState<Set<number> | null>(null);
  const { data: manageUtil } = trpc.reports.utilizationByFleet.useQuery(
    { ...utilInput, includeExcluded: true },
    { enabled: isEquipment && exclOpen },
  );
  useEffect(() => {
    if (exclOpen && manageUtil && exclDraft === null) {
      setExclDraft(new Set(manageUtil.excludedFleetIds ?? []));
    }
  }, [exclOpen, manageUtil, exclDraft]);
  const saveExclusions = trpc.rentalSettings.update.useMutation({
    onSuccess: () => {
      toast.success(t("reports.util.exclSaved"));
      utils.reports.utilizationByFleet.invalidate();
      setExclOpen(false);
      setExclDraft(null);
    },
    onError: (e) => toast.error(serverErrorText(e)),
  });

  // Customer (lazy)
  const { data: customerAnalytics } = trpc.reports.customerAnalytics.useQuery(undefined, { enabled: activeTab === "customer" });
  const { data: industryRevenue } = trpc.reports.industryRevenue.useQuery(undefined, { enabled: activeTab === "customer" });

  // Financing (lazy) — idle window defaults to season opening → today, manually adjustable.
  const [finStart, setFinStart] = useState("");
  const [finEnd, setFinEnd] = useState("");
  useEffect(() => {
    if (isFinancing && seasonStart && finStart === "" && finEnd === "") {
      setFinStart((seasonStart.date ?? `${new Date().getFullYear()}-01-01T00:00:00.000Z`).slice(0, 10));
      setFinEnd(todayIso);
    }
  }, [isFinancing, seasonStart, finStart, finEnd, todayIso]);
  const finInput = useMemo(() => ({
    startDate: finStart ? new Date(finStart).toISOString() : undefined,
    endDate: finEnd ? new Date(`${finEnd}T23:59:59`).toISOString() : undefined,
  }), [finStart, finEnd]);
  const { data: financing } = trpc.reports.financingPlan.useQuery(finInput, { enabled: isFinancing });
  const { data: revStartMonth } = trpc.reports.revenueByStartMonth.useQuery(undefined, { enabled: isFinancing });
  // Coverage baseline: which scenario+term's monthly payment to overlay on the revenue chart.
  const [coverageTerm, setCoverageTerm] = useState<number | null>(null);
  useEffect(() => {
    if (financing && coverageTerm === null && financing.termsMonths.length > 0) {
      setCoverageTerm(financing.termsMonths[financing.termsMonths.length - 1]); // longest term = lowest monthly
    }
  }, [financing, coverageTerm]);

  const revenueChartData = (revenueByMonth || []).map((d) => ({ ...d, monthLabel: formatMonthLabel(d.month) }));
  const funnelData = (statusFunnel || []).map((d) => ({ ...d, fill: STATUS_COLORS[d.status] || COLORS.gray, label: d.status.charAt(0).toUpperCase() + d.status.slice(1) }));

  const tabs: { key: Tab; label: string; icon: LucideIcon }[] = [
    { key: "overview", label: t("reports.tabOverview"), icon: TrendingUp },
    { key: "financial", label: t("reports.tabFinancial"), icon: DollarSign },
    { key: "dispatch", label: t("reports.tabDispatch"), icon: Truck },
    { key: "equipment", label: t("reports.tabEquipment"), icon: Wrench },
    { key: "financing", label: t("reports.tabFinancing"), icon: Calculator },
    { key: "customer", label: t("reports.tabCustomer"), icon: Users },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("reports.title")}</h1>
            <p className="text-sm text-slate-500 mt-1">{t("reports.subtitle")}</p>
          </div>
          <ExportToolbar
            allData={summary ? [
              { metric: "Net Revenue", value: summary.totalRevenue },
              { metric: "Total Rentals", value: summary.totalRentals },
              { metric: "Avg Order Value", value: summary.avgOrderValue },
              { metric: "Active Rentals", value: summary.activeRentals },
              { metric: "Utilization Rate", value: `${summary.utilizationRate}%` },
            ] : []}
            pageData={summary ? [
              { metric: "Net Revenue", value: summary.totalRevenue },
              { metric: "Total Rentals", value: summary.totalRentals },
              { metric: "Avg Order Value", value: summary.avgOrderValue },
              { metric: "Active Rentals", value: summary.activeRentals },
              { metric: "Utilization Rate", value: `${summary.utilizationRate}%` },
            ] : []}
            selectedData={[]}
            columns={[{ key: "metric", label: "Metric" }, { key: "value", label: "Value" }]}
            fileName="report-summary"
            title={t("reports.title")}
          />
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition ${
                  activeTab === tab.key ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
              >
                <Icon size={16} /> {tab.label}
              </button>
            );
          })}
        </div>

        {/* ── Overview Tab ── */}
        {activeTab === "overview" && (
          <>
            <FinanceFilterBar
              state={overviewFilter}
              onChange={patchOverviewFilter}
              warehouses={(warehouseList ?? []).filter((w) => w.isActive)}
              categories={categoryList ?? []}
              customers={customerList ?? []}
              models={modelList ?? []}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <StatCard label={t("reports.totalRevenue")} value={formatCurrency(summary?.totalRevenue ?? 0)} icon={DollarSign} color="text-green-600" bg="bg-green-50" />
              <StatCard label={t("reports.totalRentals")} value={summary?.totalRentals ?? 0} icon={FileText} color="text-blue-600" bg="bg-blue-50" />
              <StatCard label={t("reports.avgOrderValue")} value={formatCurrency(summary?.avgOrderValue ?? 0)} icon={TrendingUp} color="text-amber-600" bg="bg-amber-50" />
              <StatCard label={t("reports.activeRentals")} value={summary?.activeRentals ?? 0} icon={Activity} color="text-[var(--primary)]" bg="bg-[var(--primary)]/10" />
              <StatCard label={t("reports.utilizationRate")} value={`${summary?.utilizationRate ?? 0}%`} icon={Gauge} color="text-purple-600" bg="bg-purple-50" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ChartCard title={t("reports.revenueTrend")}>
                {revenueChartData.length === 0 ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noRevenueData")}</div> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={revenueChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis dataKey="monthLabel" tick={{ fontSize: 12, fill: "#6B7280" }} />
                      <YAxis tick={{ fontSize: 12, fill: "#6B7280" }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(value) => [formatCurrency(Number(value ?? 0)), t("reports.revenue")]} contentStyle={tooltipStyle} />
                      <Line type="monotone" dataKey="revenue" stroke={COLORS.red} strokeWidth={2.5} dot={{ r: 4, fill: COLORS.red }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              <ChartCard title={t("reports.orderFunnel")}>
                {funnelData.length === 0 ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noOrderData")}</div> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={funnelData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#6B7280" }} />
                      <YAxis tick={{ fontSize: 12, fill: "#6B7280" }} allowDecimals={false} />
                      <Tooltip formatter={(value) => [value ?? 0, t("reports.orders")]} contentStyle={tooltipStyle} />
                      <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                        {funnelData.map((entry, idx) => <Cell key={idx} fill={entry.fill} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>

            <div className="grid grid-cols-1 gap-6">
              <ChartCard title={t("reports.revenueByCategory")}>
                {(revenueByCategory || []).length === 0 ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noCategoryData")}</div> : (
                  <ResponsiveContainer width="100%" height={350}>
                    <PieChart>
                      <Pie data={revenueByCategory} dataKey="revenue" nameKey="category" cx="50%" cy="50%" outerRadius={120} innerRadius={60} paddingAngle={2}
                        label={({ name, percent }: PieLabelRenderProps) => `${name} ${(((percent as number) || 0) * 100).toFixed(0)}%`} labelLine={{ stroke: "#9CA3AF" }}>
                        {(revenueByCategory || []).map((_, idx) => <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(value) => [formatCurrency(Number(value ?? 0)), t("reports.revenue")]} contentStyle={tooltipStyle} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>
          </>
        )}

        {/* ── Financial Tab ── */}
        {activeTab === "financial" && (
          <>
            <FinanceFilterBar
              state={financeFilter}
              onChange={patchFinanceFilter}
              warehouses={(warehouseList ?? []).filter((w) => w.isActive)}
              categories={categoryList ?? []}
              customers={customerList ?? []}
              models={modelList ?? []}
            />

            {/* Formal income statement (P&L) — replaces the flat composition grid:
                revenue streams summed to Total Revenue, with tax + deposits shown
                as liability memo lines, plus a prior-period comparison column. */}
            {incomeStatement && <IncomeStatement data={incomeStatement} />}

            {/* Cash / collections — cash-basis complement (real payment ledger). */}
            {cashCollections && <CashCollections data={cashCollections} />}

            {/* HST/GST remittance — filing-ready tax collected by province. */}
            {taxRemittance && <TaxRemittance data={taxRemittance} />}

            {/* Deposit liability — security deposits held on open rentals. */}
            {depositLiability && <DepositLiability data={depositLiability} />}

            {/* Held prepayments — cash received but not yet applied to rent.
                A liability, deliberately excluded from paid/AR/aging; flagged so
                ops can convert it to rent rather than mistake it for settled. */}
            {heldPrepayments && heldPrepayments.count > 0 && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl p-4">
                <h3 className="text-sm font-bold text-amber-800 font-headline">
                  {t("reports.held.title", "Held prepayments (received, not applied to rent)")}
                  {" — "}{formatCurrency(heldPrepayments.total)}
                </h3>
                <p className="text-xs text-amber-700 mt-1 mb-3">
                  {t("reports.held.subtitle", { count: heldPrepayments.count, defaultValue: "{{count}} order(s) have prepayments not yet converted to rent. These are NOT counted as paid." })}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-amber-700 border-b border-amber-200">
                        <th className="py-2 px-3 text-left font-semibold">{t("reports.held.customer", "Customer")}</th>
                        <th className="py-2 px-3 text-left font-semibold">{t("reports.held.status", "Status")}</th>
                        <th className="py-2 px-3 text-right font-semibold">{t("reports.held.amount", "Held")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {heldPrepayments.orders.map((o) => (
                        <tr key={o.id} className="border-b border-amber-100">
                          <td className="py-2 px-3">{o.customerName}</td>
                          <td className="py-2 px-3 capitalize">{o.status}</td>
                          <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(o.held)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Revenue by month stacked */}
              <ChartCard title={t("reports.fin.monthlyBreakdown")}>
                {(revenueDetailed || []).length === 0 ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noRevenueData")}</div> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={(revenueDetailed || []).map((d) => ({ ...d, monthLabel: formatMonthLabel(d.month) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis dataKey="monthLabel" tick={{ fontSize: 11, fill: "#6B7280" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(value) => formatCurrency(Number(value ?? 0))} contentStyle={tooltipStyle} />
                      <Legend />
                      <Bar dataKey="rentalFee" name={t("reports.fin.rentalFee")} stackId="a" fill={COLORS.red} />
                      <Bar dataKey="freightCost" name={t("reports.fin.freight")} stackId="a" fill={COLORS.blue} />
                      <Bar dataKey="insuranceCost" name={t("reports.fin.insurance")} stackId="a" fill={COLORS.green} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              {/* Payment status */}
              <ChartCard title={t("reports.fin.paymentStatus")}>
                {(paymentStatus || []).length === 0 ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noData")}</div> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={paymentStatus} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={100} innerRadius={50}
                        label={({ name, percent }: PieLabelRenderProps) => `${name} ${(((percent as number) || 0) * 100).toFixed(0)}%`}>
                        {(paymentStatus || []).map((_, idx) => <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>

            {/* A/R aging */}
            {arAging && arAging.buckets.length > 0 && (
              <ChartCard title={`${t("reports.fin.arAging")} — ${formatCurrency(arAging.totalOutstanding)}`}>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {arAging.buckets.map((b) => {
                    const tone =
                      b.bucket === "0-30" ? "bg-emerald-50 border-emerald-200 text-emerald-900" :
                      b.bucket === "31-60" ? "bg-amber-50 border-amber-200 text-amber-900" :
                      b.bucket === "61-90" ? "bg-orange-50 border-orange-200 text-orange-900" :
                      "bg-red-50 border-red-200 text-red-900";
                    return (
                      <div key={b.bucket} className={`rounded-lg border p-3 ${tone}`}>
                        <div className="text-xs uppercase tracking-wide opacity-70">{t("reports.fin.arBucket", { bucket: b.bucket })}</div>
                        <div className="text-xl font-bold mt-0.5">{formatCurrency(b.totalOwing)}</div>
                        <div className="text-xs opacity-70">{t("reports.fin.arInvoiceCount", { count: b.invoiceCount })}</div>
                      </div>
                    );
                  })}
                </div>
              </ChartCard>
            )}

            {/* Accounts receivable */}
            {accountsReceivable && accountsReceivable.orders.length > 0 && (
              <ChartCard title={`${t("reports.fin.accountsReceivable")} — ${formatCurrency(accountsReceivable.total)}`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-2 px-3">ID</th>
                        <th className="py-2 px-3">{t("reports.fin.customer")}</th>
                        <th className="py-2 px-3">{t("reports.fin.status")}</th>
                        <th className="py-2 px-3">{t("reports.fin.payment")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.fin.billed")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.fin.owing")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accountsReceivable.orders.map((o) => (
                        <tr key={o.id} className="border-b border-slate-100">
                          <td className="py-2 px-3 font-medium">#{o.id}</td>
                          <td className="py-2 px-3">{o.customerName}</td>
                          <td className="py-2 px-3 capitalize">{o.status}</td>
                          <td className="py-2 px-3 capitalize">{o.paymentStatus}</td>
                          <td className="py-2 px-3 text-right text-slate-500 tabular-nums">{formatCurrency(o.totalAmount)}</td>
                          <td className="py-2 px-3 text-right font-medium tabular-nums">{formatCurrency(o.owing)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-slate-400 mt-3">{t("reports.fin.arBasisNote")}</p>
              </ChartCard>
            )}
          </>
        )}

        {/* ── Dispatch Tab ── */}
        {activeTab === "dispatch" && (
          <>
            {dispatchAnalytics && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <StatCard label={t("reports.disp.totalDispatches")} value={dispatchAnalytics.summary.total} icon={Truck} color="text-blue-600" bg="bg-blue-50" />
                <StatCard label={t("reports.disp.avgDeliveryDistance")} value={`${dispatchAnalytics.summary.avgDeliveryDistanceKm} km`} icon={Activity} color="text-green-600" bg="bg-green-50" />
                <StatCard label={t("reports.disp.totalCost")} value={formatCurrency(dispatchAnalytics.summary.totalCost)} icon={DollarSign} color="text-amber-600" bg="bg-amber-50" />
                <StatCard label={t("reports.disp.avgCost")} value={formatCurrency(dispatchAnalytics.summary.avgCost)} icon={TrendingUp} color="text-purple-600" bg="bg-purple-50" />
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Monthly dispatch volume */}
              <ChartCard title={t("reports.disp.monthlyVolume")}>
                {!dispatchAnalytics?.byMonth?.length ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noData")}</div> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={dispatchAnalytics.byMonth.map((d) => ({ ...d, monthLabel: formatMonthLabel(d.month) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis dataKey="monthLabel" tick={{ fontSize: 11, fill: "#6B7280" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend />
                      <Bar dataKey="deliveries" name={t("reports.disp.deliveries")} stackId="a" fill={COLORS.blue} />
                      <Bar dataKey="pickups" name={t("reports.disp.pickups")} stackId="a" fill={COLORS.green} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              {/* Status distribution */}
              <ChartCard title={t("reports.disp.statusDistribution")}>
                {!dispatchAnalytics?.byStatus?.length ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noData")}</div> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={dispatchAnalytics.byStatus} dataKey="count" nameKey="status" cx="50%" cy="50%" outerRadius={100} innerRadius={50}
                        label={({ name, percent }: PieLabelRenderProps) => `${name} ${(((percent as number) || 0) * 100).toFixed(0)}%`}>
                        {dispatchAnalytics.byStatus.map((_, idx) => <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>

            {/* Driver performance table */}
            {(driverPerformance || []).length > 0 && (
              <ChartCard title={t("reports.disp.driverPerformance")}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-2 px-3">{t("reports.disp.driver")}</th>
                        <th className="py-2 px-3 text-center">{t("reports.disp.total")}</th>
                        <th className="py-2 px-3 text-center">{t("reports.disp.completed")}</th>
                        <th className="py-2 px-3 text-center">{t("reports.disp.cancelled")}</th>
                        <th className="py-2 px-3 text-center">{t("reports.disp.avgTime")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(driverPerformance || []).map((d) => (
                        <tr key={d.id} className="border-b border-slate-100">
                          <td className="py-2 px-3 font-medium">{d.name}</td>
                          <td className="py-2 px-3 text-center">{d.total}</td>
                          <td className="py-2 px-3 text-center text-green-600">{d.completed}</td>
                          <td className="py-2 px-3 text-center text-red-500">{d.cancelled}</td>
                          <td className="py-2 px-3 text-center">{d.avgHoursToComplete}h</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ChartCard>
            )}
          </>
        )}

        {/* ── Equipment Tab ── */}
        {activeTab === "equipment" && (
          <>
            {/* Utilization exclusion manager — drop non-rentable assets from the stats */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-[var(--on-surface)] font-headline">{t("reports.util.exclTitle")}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{t("reports.util.exclHint")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => { setExclOpen((o) => !o); if (exclOpen) setExclDraft(null); }}
                  className="h-9 shrink-0 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 transition"
                >
                  {exclOpen ? t("reports.util.close") : t("reports.util.exclManage")}
                </button>
              </div>
              {exclOpen && (
                <div className="mt-4">
                  <input
                    value={exclSearch}
                    onChange={(e) => setExclSearch(e.target.value)}
                    placeholder={t("reports.util.exclSearch")}
                    className="h-9 w-full sm:max-w-xs rounded-lg border border-slate-200 bg-[var(--surface-container-lowest)] px-3 text-sm focus:border-[var(--primary)] focus:outline-none"
                  />
                  <div className="max-h-80 overflow-y-auto mt-3 border border-slate-100 rounded-lg divide-y divide-slate-100">
                    {(manageUtil?.assets ?? [])
                      .filter((a) => {
                        const q = exclSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (a.assetNumber ?? "").toLowerCase().includes(q) || `${a.brand} ${a.model}`.toLowerCase().includes(q);
                      })
                      .map((a) => {
                        const checked = exclDraft?.has(a.fleetId) ?? false;
                        return (
                          <label key={a.fleetId} className="flex items-center gap-3 py-2 px-3 hover:bg-slate-50 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setExclDraft((prev) => {
                                  const n = new Set(prev ?? []);
                                  if (n.has(a.fleetId)) n.delete(a.fleetId); else n.add(a.fleetId);
                                  return n;
                                })
                              }
                            />
                            <span className="font-mono text-xs text-slate-500 w-24 shrink-0">{a.assetNumber ?? `#${a.fleetId}`}</span>
                            <span className="text-sm text-[var(--on-surface)]">{a.brand} {a.model}</span>
                            {a.inMaintenance && (
                              <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{t("reports.util.maintenance")}</span>
                            )}
                            <span className="ml-auto text-xs text-slate-400">{a.utilizationPct}%</span>
                          </label>
                        );
                      })}
                    {manageUtil && (manageUtil.assets ?? []).length === 0 && (
                      <div className="py-6 text-center text-sm text-slate-400">{t("reports.noUtilData")}</div>
                    )}
                  </div>
                  <div className="flex items-center justify-end gap-3 mt-3">
                    <span className="text-xs text-slate-500">{t("reports.util.exclCount", { count: exclDraft?.size ?? 0 })}</span>
                    <button
                      type="button"
                      disabled={saveExclusions.isPending}
                      onClick={() => saveExclusions.mutate({ key: "utilization_excluded_fleet_ids", value: JSON.stringify([...(exclDraft ?? [])]) })}
                      className="h-9 rounded-lg bg-[var(--primary)] px-4 text-sm font-medium text-white hover:opacity-90 transition disabled:opacity-50"
                    >
                      {t("reports.util.save")}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Utilization chart — date window defaults to season opening → today */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ChartCard title={t("reports.equipmentUtil")}>
                <div className="flex flex-wrap items-end gap-3 mb-4">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-slate-500">{t("reports.util.from")}</span>
                    <input type="date" value={utilStart} max={utilEnd || undefined} onChange={(e) => setUtilStart(e.target.value)}
                      className="h-9 rounded-lg border border-slate-200 bg-[var(--surface-container-lowest)] px-2 text-sm focus:border-[var(--primary)] focus:outline-none" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-slate-500">{t("reports.util.to")}</span>
                    <input type="date" value={utilEnd} min={utilStart || undefined} onChange={(e) => setUtilEnd(e.target.value)}
                      className="h-9 rounded-lg border border-slate-200 bg-[var(--surface-container-lowest)] px-2 text-sm focus:border-[var(--primary)] focus:outline-none" />
                  </label>
                  <button type="button"
                    onClick={() => { setUtilStart((seasonStart?.date ?? `${new Date().getFullYear()}-01-01`).slice(0, 10)); setUtilEnd(todayIso); }}
                    className="h-9 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 transition">
                    {t("reports.util.season")}
                  </button>
                  {equipUtilData && <span className="text-xs text-slate-400 self-center ml-auto">{t("reports.util.avg", { pct: equipUtilData.averageUtilizationPct })}</span>}
                </div>
                {equipUtilTop.length === 0 ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noUtilData")}</div> : (
                  <ResponsiveContainer width="100%" height={350}>
                    <BarChart data={equipUtilTop} layout="vertical" margin={{ left: 20, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 12, fill: "#6B7280" }} tickFormatter={(v) => `${v}%`} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "#6B7280" }} width={150} />
                      <Tooltip formatter={(value) => [`${value ?? 0}%`, t("reports.utilization")]} contentStyle={tooltipStyle} />
                      <Bar dataKey="utilization" radius={[0, 4, 4, 0]}>
                        {equipUtilTop.map((_, idx) => <Cell key={idx} fill={idx < 3 ? COLORS.red : idx < 6 ? COLORS.redLight : COLORS.redLighter} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              {/* Condition trend */}
              <ChartCard title={t("reports.equip.conditionTrend")}>
                {(conditionTrend || []).length === 0 ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noData")}</div> : (
                  <ResponsiveContainer width="100%" height={350}>
                    <BarChart data={(conditionTrend || []).map((d) => ({ ...d, monthLabel: formatMonthLabel(d.month) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis dataKey="monthLabel" tick={{ fontSize: 11, fill: "#6B7280" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Legend />
                      <Bar dataKey="excellent" name={t("reports.equip.excellent")} stackId="a" fill={COLORS.green} />
                      <Bar dataKey="good" name={t("reports.equip.good")} stackId="a" fill={COLORS.blue} />
                      <Bar dataKey="fair" name={t("reports.equip.fair")} stackId="a" fill={COLORS.amber} />
                      <Bar dataKey="poor" name={t("reports.equip.poor")} stackId="a" fill={COLORS.red} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>

            {/* Utilization by pricing category — high = candidate to add more units */}
            <ChartCard title={t("reports.util.byCategory")}>
              <p className="text-xs text-slate-400 mb-3 -mt-1">{t("reports.util.byCategoryHint")}</p>
              {(equipUtilData?.byCategory ?? []).length === 0 ? (
                <div className="h-40 flex items-center justify-center text-slate-400 text-sm">{t("reports.noUtilData")}</div>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(220, (equipUtilData?.byCategory?.length ?? 0) * 34)}>
                  <BarChart
                    data={(equipUtilData?.byCategory ?? []).map((c) => ({ name: `${c.category} (${c.assetCount})`, utilization: c.utilizationPct }))}
                    layout="vertical"
                    margin={{ left: 20, right: 20 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 12, fill: "#6B7280" }} tickFormatter={(v) => `${v}%`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "#6B7280" }} width={200} />
                    <Tooltip formatter={(value) => [`${value ?? 0}%`, t("reports.utilization")]} contentStyle={tooltipStyle} />
                    <Bar dataKey="utilization" radius={[0, 4, 4, 0]}>
                      {(equipUtilData?.byCategory ?? []).map((c, idx) => (
                        <Cell key={idx} fill={c.utilizationPct >= 70 ? COLORS.red : c.utilizationPct >= 40 ? COLORS.amber : COLORS.green} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* Asset economics table */}
            {(fleetROI || []).length > 0 && (
              <ChartCard title={t("reports.equip.fleetROI")}>
                <p className="text-xs text-slate-400 mb-3 -mt-1">{t("reports.equip.economicsHint")}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-2 px-3">{t("reports.equip.equipment")}</th>
                        <th className="py-2 px-3 hidden md:table-cell">{t("reports.equip.category")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.equip.cost")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.equip.revenue")}</th>
                        <th className="py-2 px-3 text-center hidden sm:table-cell">{t("reports.equip.rentals")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.equip.payback")}</th>
                        <th className="py-2 px-3 text-right hidden lg:table-cell">{t("reports.equip.bookValue")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.equip.annualRoi")}</th>
                        <th className="py-2 px-3 text-right hidden lg:table-cell">{t("reports.equip.maintenance")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(fleetROI || []).map((item) => (
                        <tr key={item.id} className="border-b border-slate-100">
                          <td className="py-2 px-3 font-medium">{item.name} {item.assetNumber && <span className="text-xs text-slate-400">#{item.assetNumber}</span>}</td>
                          <td className="py-2 px-3 hidden md:table-cell text-slate-500">{item.category || "-"}</td>
                          <td className="py-2 px-3 text-right">{item.purchaseCost > 0 ? formatCurrency(item.purchaseCost) : "-"}</td>
                          <td className="py-2 px-3 text-right font-medium text-green-600">{formatCurrency(item.revenue)}</td>
                          <td className="py-2 px-3 text-center hidden sm:table-cell text-slate-500">{item.rentalCount}</td>
                          <td className="py-2 px-3 text-right">
                            {item.paybackPct !== null ? (
                              <span className={item.isPaidBack ? "text-green-600 font-bold" : "text-slate-600"}>
                                {item.paybackPct}%{item.isPaidBack && <span className="ml-1 text-[10px] font-semibold uppercase">{t("reports.equip.paidBack")}</span>}
                              </span>
                            ) : "-"}
                          </td>
                          <td className="py-2 px-3 text-right hidden lg:table-cell text-slate-600">{item.bookValue !== null ? formatCurrency(item.bookValue) : "-"}</td>
                          <td className="py-2 px-3 text-right">
                            {item.annualRoiPct !== null ? (
                              <span className={item.annualRoiPct >= 0 ? "text-green-600 font-medium" : "text-red-600 font-medium"}>{item.annualRoiPct}%</span>
                            ) : "-"}
                          </td>
                          <td className="py-2 px-3 text-right hidden lg:table-cell text-slate-400" title={t("reports.equip.maintenancePending")}>—</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ChartCard>
            )}
          </>
        )}

        {/* ── Financing Tab ── */}
        {activeTab === "financing" && (
          <>
            {/* Window picker + export */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <h3 className="text-sm font-bold text-[var(--on-surface)] font-headline">{t("reports.financing.title")}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{t("reports.financing.hint")}</p>
                </div>
                <label className="flex flex-col gap-1 ml-auto">
                  <span className="text-xs font-medium text-slate-500">{t("reports.util.from")}</span>
                  <input type="date" value={finStart} max={finEnd || undefined} onChange={(e) => setFinStart(e.target.value)}
                    className="h-9 rounded-lg border border-slate-200 bg-[var(--surface-container-lowest)] px-2 text-sm focus:border-[var(--primary)] focus:outline-none" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-500">{t("reports.util.to")}</span>
                  <input type="date" value={finEnd} min={finStart || undefined} onChange={(e) => setFinEnd(e.target.value)}
                    className="h-9 rounded-lg border border-slate-200 bg-[var(--surface-container-lowest)] px-2 text-sm focus:border-[var(--primary)] focus:outline-none" />
                </label>
                <button type="button"
                  onClick={() => { setFinStart((seasonStart?.date ?? `${new Date().getFullYear()}-01-01`).slice(0, 10)); setFinEnd(todayIso); }}
                  className="h-9 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50 transition">
                  {t("reports.util.season")}
                </button>
                <ExportToolbar
                  allData={(financing?.valuation ?? []).map((v) => ({ model: v.model, qty: v.qty, unitPrice: v.unitPrice, subtotal: v.subtotal }))}
                  pageData={(financing?.valuation ?? []).map((v) => ({ model: v.model, qty: v.qty, unitPrice: v.unitPrice, subtotal: v.subtotal }))}
                  selectedData={[]}
                  columns={[
                    { key: "model", label: t("reports.financing.colModel") },
                    { key: "qty", label: t("reports.financing.colQty") },
                    { key: "unitPrice", label: t("reports.financing.colUnitPrice") },
                    { key: "subtotal", label: t("reports.financing.colSubtotal") },
                  ]}
                  fileName="financing-valuation"
                  title={t("reports.financing.title")}
                />
              </div>
            </div>

            {/* KPI row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard label={t("reports.financing.grandTotal")} value={formatCurrency(financing?.grandTotal ?? 0)} icon={DollarSign} color="text-green-600" bg="bg-green-50" />
              <StatCard label={t("reports.financing.tier1Total")} value={formatCurrency(financing?.tierTotals.tier1 ?? 0)} icon={Gauge} color="text-[var(--primary)]" bg="bg-[var(--primary)]/10" />
              <StatCard label={t("reports.financing.tier2Total")} value={formatCurrency(financing?.tierTotals.tier2 ?? 0)} icon={Gauge} color="text-amber-600" bg="bg-amber-50" />
            </div>

            {/* 0%-interest monthly-payment scenarios */}
            <ChartCard title={t("reports.financing.scenarioTitle")}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                      <th className="py-2 px-3">{t("reports.financing.scnPlan")}</th>
                      <th className="py-2 px-3 text-right">{t("reports.financing.colQty")}</th>
                      <th className="py-2 px-3 text-right">{t("reports.financing.colTotalValue")}</th>
                      {(financing?.termsMonths ?? []).map((m) => (
                        <th key={m} className="py-2 px-3 text-right">{t("reports.financing.monthlyN", { n: m })}</th>
                      ))}
                      {(financing?.termsMonths ?? []).map((m) => (
                        <th key={`s${m}`} className="py-2 px-3 text-right">{t("reports.financing.saveN", { n: m })}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(financing?.scenarios ?? []).map((scn) => (
                      <tr key={scn.key} className="border-b border-slate-100">
                        <td className="py-2 px-3 font-medium text-[var(--on-surface)]">{t(`reports.financing.scn.${scn.key}`)}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{scn.unitCount}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(scn.totalValue)}</td>
                        {scn.terms.map((tm) => (
                          <td key={tm.months} className="py-2 px-3 text-right tabular-nums font-semibold">{formatCurrency(tm.monthly)}</td>
                        ))}
                        {scn.terms.map((tm) => (
                          <td key={`s${tm.months}`} className="py-2 px-3 text-right tabular-nums text-emerald-600">
                            {tm.savingVsCurrent > 0 ? formatCurrency(tm.savingVsCurrent) : "—"}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-400 mt-3">{t("reports.financing.scenarioNote")}</p>
            </ChartCard>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Valuation by model */}
              <ChartCard title={t("reports.financing.valuationTitle")}>
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-[var(--surface-container-lowest)]">
                      <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                        <th className="py-2 px-3">{t("reports.financing.colModel")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.financing.colQty")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.financing.colUnitPrice")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.financing.colSubtotal")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(financing?.valuation ?? []).map((v) => (
                        <tr key={v.model} className="border-b border-slate-100">
                          <td className="py-1.5 px-3 text-[var(--on-surface)]">{v.model}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums">{v.qty}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums">{formatCurrency(v.unitPrice)}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums">{formatCurrency(v.subtotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-300 font-bold">
                        <td className="py-2 px-3">{t("reports.financing.total")}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{(financing?.valuation ?? []).reduce((s, v) => s + v.qty, 0)}</td>
                        <td className="py-2 px-3"></td>
                        <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(financing?.grandTotal ?? 0)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </ChartCard>

              {/* Revenue vs monthly-payment coverage */}
              <ChartCard title={t("reports.financing.coverageTitle")}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-medium text-slate-500">{t("reports.financing.coverageBaseline")}</span>
                  <select
                    value={coverageTerm ?? ""}
                    onChange={(e) => setCoverageTerm(Number(e.target.value))}
                    className="h-8 rounded-lg border border-slate-200 bg-[var(--surface-container-lowest)] px-2 text-sm focus:border-[var(--primary)] focus:outline-none"
                  >
                    {(financing?.termsMonths ?? []).map((m) => (
                      <option key={m} value={m}>{t("reports.financing.monthlyN", { n: m })}</option>
                    ))}
                  </select>
                </div>
                {(() => {
                  const baseline = financing?.scenarios.find((s) => s.key === "current")?.terms.find((tm) => tm.months === coverageTerm)?.monthly ?? 0;
                  const data = (revStartMonth ?? []).map((d) => ({ ...d, monthLabel: formatMonthLabel(d.month) }));
                  return data.length === 0 ? (
                    <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noRevenueData")}</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                        <XAxis dataKey="monthLabel" tick={{ fontSize: 12, fill: "#6B7280" }} />
                        <YAxis tick={{ fontSize: 12, fill: "#6B7280" }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                        <Tooltip formatter={(value, name) => [formatCurrency(Number(value ?? 0)), name]} contentStyle={tooltipStyle} />
                        <Legend />
                        <Bar dataKey="rentalFee" stackId="rev" name={t("reports.financing.netRental")} fill={COLORS.green} radius={[0, 0, 0, 0]} />
                        <Bar dataKey="insuranceCost" stackId="rev" name={t("reports.financing.insurance")} fill={COLORS.blue} radius={[4, 4, 0, 0]} />
                        <ReferenceLine y={baseline} stroke={COLORS.red} strokeWidth={2} strokeDasharray="5 4"
                          label={{ value: t("reports.financing.monthlyPayment"), position: "insideTopRight", fontSize: 11, fill: COLORS.red }} />
                      </BarChart>
                    </ResponsiveContainer>
                  );
                })()}
                <p className="text-xs text-slate-400 mt-3">{t("reports.financing.coverageNote")}</p>
              </ChartCard>
            </div>

            {/* Idle-tier detail per unit */}
            <ChartCard title={t("reports.financing.idleTitle")}>
              <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[var(--surface-container-lowest)]">
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                      <th className="py-2 px-3">{t("reports.financing.colModel")}</th>
                      <th className="py-2 px-3">{t("reports.financing.colCode")}</th>
                      <th className="py-2 px-3 text-right">{t("reports.financing.colRentedDays")}</th>
                      <th className="py-2 px-3 text-right">{t("reports.financing.colRentalCount")}</th>
                      <th className="py-2 px-3 text-right">{t("reports.financing.colUnitPrice")}</th>
                      <th className="py-2 px-3">{t("reports.financing.colTier")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(financing?.units ?? []).slice().sort((a, b) => a.rentedDays - b.rentedDays).map((u) => {
                      const tierStyle = u.tier === "tier1"
                        ? "text-red-700 bg-red-50 border-red-200"
                        : u.tier === "tier2" ? "text-amber-700 bg-amber-50 border-amber-200"
                        : "text-emerald-700 bg-emerald-50 border-emerald-200";
                      return (
                        <tr key={u.fleetId} className="border-b border-slate-100">
                          <td className="py-1.5 px-3 text-[var(--on-surface)]">{u.model}</td>
                          <td className="py-1.5 px-3 font-mono text-xs text-slate-500">
                            {u.assetNumber ?? `#${u.fleetId}`}
                            {u.currentStatus === "maintenance" && (
                              <span className="ml-2 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{t("reports.util.maintenance")}</span>
                            )}
                          </td>
                          <td className="py-1.5 px-3 text-right tabular-nums">{u.rentedDays}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums">{u.rentalCount}</td>
                          <td className="py-1.5 px-3 text-right tabular-nums">{u.purchaseCost != null ? formatCurrency(u.purchaseCost) : "—"}</td>
                          <td className="py-1.5 px-3">
                            <span className={`text-[10px] font-medium border rounded px-1.5 py-0.5 ${tierStyle}`}>{t(`reports.financing.tier.${u.tier}`)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-slate-400 mt-3">{t("reports.financing.idleNote")}</p>
            </ChartCard>
          </>
        )}

        {/* ── Customer Tab ── */}
        {activeTab === "customer" && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Customer growth */}
              <ChartCard title={t("reports.cust.growth")}>
                {!customerAnalytics?.growth?.length ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noData")}</div> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={customerAnalytics.growth.map((d) => ({ ...d, monthLabel: formatMonthLabel(d.month) }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                      <XAxis dataKey="monthLabel" tick={{ fontSize: 11, fill: "#6B7280" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} />
                      <Bar dataKey="newCustomers" name={t("reports.cust.newCustomers")} fill={COLORS.blue} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>

              {/* Revenue by category (reuse) */}
              <ChartCard title={t("reports.revenueByCategory")}>
                {(revenueByCategory || []).length === 0 ? <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noCategoryData")}</div> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={revenueByCategory} dataKey="revenue" nameKey="category" cx="50%" cy="50%" outerRadius={100} innerRadius={50}>
                        {(revenueByCategory || []).map((_, idx) => <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(value) => [formatCurrency(Number(value ?? 0)), t("reports.revenue")]} contentStyle={tooltipStyle} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </ChartCard>
            </div>

            {/* Top customers table */}
            {customerAnalytics?.topCustomers && customerAnalytics.topCustomers.length > 0 && (
              <ChartCard title={t("reports.cust.topCustomers")}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-slate-500 border-b border-slate-200">
                      <tr>
                        <th className="py-2 px-3">{t("reports.cust.name")}</th>
                        <th className="py-2 px-3 hidden md:table-cell">{t("reports.cust.company")}</th>
                        <th className="py-2 px-3 text-center">{t("reports.cust.rentals")}</th>
                        <th className="py-2 px-3 text-right">{t("reports.cust.revenue")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customerAnalytics.topCustomers.map((c) => (
                        <tr key={c.id} className="border-b border-slate-100">
                          <td className="py-2 px-3 font-medium">{c.name}</td>
                          <td className="py-2 px-3 hidden md:table-cell text-slate-500">{c.company || "-"}</td>
                          <td className="py-2 px-3 text-center">{c.rentalCount}</td>
                          <td className="py-2 px-3 text-right font-medium text-green-600">{formatCurrency(c.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </ChartCard>
            )}

            {/* Revenue by industry */}
            <ChartCard title={tAdmin("reports.industryRevenue.title")}>
              <p className="text-xs text-slate-400 -mt-2 mb-4">{tAdmin("reports.industryRevenue.subtitle")}</p>
              {!industryRevenue?.length ? (
                <div className="h-72 flex items-center justify-center text-slate-400 text-sm">{t("reports.noData")}</div>
              ) : (
                <div className="space-y-3">
                  {(() => {
                    const maxRevenue = Math.max(...industryRevenue.map((r) => r.revenue), 1);
                    return industryRevenue.map((row) => (
                      <div key={row.industry}>
                        <div className="flex items-center justify-between text-sm mb-1 gap-3">
                          <span className="font-medium text-[var(--on-surface)]">
                            {row.industry === "unclassified" ? tAdmin("reports.industryRevenue.unclassified") : tAdmin(industryI18nKey(row.industry as CustomerIndustry))}
                          </span>
                          <span className="flex items-center gap-3 shrink-0 text-slate-500">
                            <span className="flex items-center gap-1 text-xs"><Users size={12} />{row.customerCount}</span>
                            <span className="font-semibold text-[var(--on-surface)]">{formatCurrency(row.revenue)}</span>
                          </span>
                        </div>
                        <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                          <div className="bg-[var(--primary)] h-full rounded-full transition-all" style={{ width: `${(row.revenue / maxRevenue) * 100}%` }} />
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              )}
            </ChartCard>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
