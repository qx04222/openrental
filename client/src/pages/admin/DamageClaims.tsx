import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import DataTable, { Column } from "@/components/DataTable";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { EXTRA_CHARGE_REASONS, EXTRA_CHARGE_LABELS } from "@shared/extraCharges";
import {
  Plus,
  X,
  RefreshCw,
  FileText,
  Wrench,
} from "lucide-react";
import { serverErrorText } from "@/lib/serverError";

type TabFilter = "all" | "pending" | "estimated" | "customer_notified" | "accepted" | "invoiced" | "disputed";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  estimated: "bg-blue-100 text-blue-700",
  customer_notified: "bg-indigo-100 text-indigo-700",
  accepted: "bg-green-100 text-green-700",
  invoiced: "bg-purple-100 text-purple-700",
  disputed: "bg-red-100 text-red-700",
};

const _CLAIM_STATUS_VALUES = ["pending", "estimated", "customer_notified", "accepted", "invoiced", "disputed"] as const;

type ClaimStatus = (typeof _CLAIM_STATUS_VALUES)[number];

const emptyCreateForm = {
  rentalId: "",
  chargeType: "damage" as string,
  description: "",
  amount: "",
};

const emptyStatusForm = {
  status: "pending" as ClaimStatus,
  approvedAmount: "",
  customerResponse: "",
};

export default function DamageClaims() {
  const { t, i18n } = useTranslation("admin");
  const lang: "en" | "zh" = i18n.language?.startsWith("zh") ? "zh" : "en";

  const CLAIM_STATUSES = [
    { value: "pending" as ClaimStatus, label: t("claims.statusPending") },
    { value: "estimated" as ClaimStatus, label: t("claims.statusEstimated") },
    { value: "customer_notified" as ClaimStatus, label: t("claims.statusNotified") },
    { value: "accepted" as ClaimStatus, label: t("claims.statusAccepted") },
    { value: "invoiced" as ClaimStatus, label: t("claims.statusInvoiced") },
    { value: "disputed" as ClaimStatus, label: t("claims.statusDisputed") },
  ];

  const utils = trpc.useUtils();

  // ─── Data fetching ──────────────────────────────────────────
  const [tab, setTab] = useState<TabFilter>("all");
  const { data: claimData, isLoading } = trpc.damageClaims.list.useQuery(
    tab === "all" ? undefined : { status: tab }
  );

  // ─── Mutations ──────────────────────────────────────────────
  const createMut = trpc.damageClaims.create.useMutation({
    onSuccess: () => {
      utils.damageClaims.list.invalidate();
      setCreateOpen(false);
      toast.success(t("claims.createSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateStatusMut = trpc.damageClaims.updateStatus.useMutation({
    onSuccess: () => {
      utils.damageClaims.list.invalidate();
      setStatusOpen(false);
      toast.success(t("claims.updateStatusSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const generateInvoiceMut = trpc.damageClaims.generateInvoice.useMutation({
    onSuccess: (_result) => {
      utils.damageClaims.list.invalidate();
      toast.success(t("claims.generateInvoiceSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const createWorkOrder = trpc.workOrders.create.useMutation({
    onSuccess: (wo) => toast.success(t("claims.woCreated", { number: wo.workOrderNumber })),
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Dialog state ──────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  // Order picker (search by rental number / financial order # / customer)
  const [orderSearch, setOrderSearch] = useState("");
  const [orderLabel, setOrderLabel] = useState("");
  const { data: orderMatches } = trpc.rentals.searchForCharge.useQuery(
    { query: orderSearch.trim() },
    { enabled: orderSearch.trim().length >= 2 },
  );

  const [statusOpen, setStatusOpen] = useState(false);
  const [statusClaimId, setStatusClaimId] = useState<number | null>(null);
  const [statusForm, setStatusForm] = useState(emptyStatusForm);

  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeStatus = useCallback(() => setStatusOpen(false), []);
  useEscapeKey(createOpen, closeCreate);
  useEscapeKey(statusOpen, closeStatus);

  // ─── Handlers ──────────────────────────────────────────────
  const openCreate = () => {
    setCreateForm(emptyCreateForm);
    setOrderSearch("");
    setOrderLabel("");
    setCreateOpen(true);
  };

  const handleCreate = () => {
    const rentalId = parseInt(createForm.rentalId, 10);
    if (!rentalId || isNaN(rentalId)) return toast.error(t("claims.validRentalIdRequired"));
    if (!createForm.description.trim()) return toast.error(t("claims.descriptionRequired"));
    const amt = parseFloat(createForm.amount);
    const val = amt && !isNaN(amt) ? amt : undefined;
    createMut.mutate({
      rentalId,
      chargeType: createForm.chargeType as "damage" | "fuel" | "cleaning" | "overtime" | "transport" | "other",
      description: createForm.description,
      // Damage → repair estimate (claim lifecycle); others → direct amount.
      ...(createForm.chargeType === "damage" ? { repairEstimate: val } : { amount: val }),
    });
  };

  const openUpdateStatus = (claimId: number, currentStatus: string) => {
    setStatusClaimId(claimId);
    setStatusForm({ ...emptyStatusForm, status: currentStatus as ClaimStatus });
    setStatusOpen(true);
  };

  const handleUpdateStatus = () => {
    if (!statusClaimId) return;
    const approvedAmount = parseFloat(statusForm.approvedAmount);
    updateStatusMut.mutate({
      id: statusClaimId,
      status: statusForm.status,
      approvedAmount: approvedAmount && !isNaN(approvedAmount) ? approvedAmount : undefined,
      customerResponse: statusForm.customerResponse || undefined,
    });
  };

  // ─── Helpers ──────────────────────────────────────────────
  const fmtNum = (v: string | number | null | undefined) => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return n != null && !isNaN(n) ? formatCurrency(n) : "-";
  };

  // ─── Table data ──────────────────────────────────────────
  type ClaimRow = NonNullable<typeof claimData>[number];

  const columns: Column<ClaimRow>[] = [
    {
      key: "damage_claims.id",
      label: t("claims.columnId"),
      render: (row) => <span className="text-slate-900 font-medium">#{row.damage_claims.id}</span>,
    },
    {
      key: "damage_claims.rentalId",
      label: t("claims.columnRentalNo"),
      render: (row) => <span className="text-sm text-slate-700">{row.rental_requests?.rentalNumber || row.damage_claims.rentalId || "-"}</span>,
    },
    {
      key: "damage_claims.chargeType",
      label: t("claims.columnReason"),
      render: (row) => {
        const ct = (row.damage_claims.chargeType ?? "damage") as keyof typeof EXTRA_CHARGE_LABELS;
        return <span className="text-sm text-slate-700">{EXTRA_CHARGE_LABELS[ct]?.[lang] ?? ct}</span>;
      },
    },
    {
      key: "customers.name",
      label: t("claims.columnCustomer"),
      render: (row) => row.customers?.name || "-",
      hideOnMobile: true,
    },
    {
      key: "damage_claims.description",
      label: t("claims.columnDescription"),
      render: (row) => {
        const desc = row.damage_claims.description || "";
        return <span className="text-sm text-slate-700">{desc.length > 60 ? desc.substring(0, 60) + "..." : desc}</span>;
      },
      hideOnMobile: true,
    },
    {
      key: "damage_claims.repairEstimate",
      label: t("claims.columnRepairEstimate"),
      render: (row) => <span className="text-sm text-slate-900">{fmtNum(row.damage_claims.repairEstimate)}</span>,
      hideOnMobile: true,
    },
    {
      key: "damage_claims.approvedAmount",
      label: t("claims.columnApprovedAmount"),
      render: (row) => <span className="text-sm font-medium text-slate-900">{fmtNum(row.damage_claims.approvedAmount)}</span>,
      hideOnMobile: true,
    },
    {
      key: "damage_claims.status",
      label: t("claims.columnStatus"),
      render: (row) => {
        const status = row.damage_claims.status;
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-slate-100 text-slate-700"}`}>
            {status.replace(/_/g, " ")}
          </span>
        );
      },
    },
    {
      key: "_actions",
      label: t("claims.columnActions"),
      sortable: false,
      searchable: false,
      render: (row) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => openUpdateStatus(row.damage_claims.id, row.damage_claims.status)}
            className="text-slate-500 hover:text-blue-600"
            aria-label={t("claims.updateStatusTooltip")}
            title={t("claims.updateStatusTooltip")}
          >
            <RefreshCw size={16} />
          </button>
          {row.damage_claims.status === "accepted" && !row.damage_claims.invoiceId && (
            <button
              onClick={() => {
                if (confirm(t("claims.generateInvoiceConfirm"))) {
                  generateInvoiceMut.mutate({ id: row.damage_claims.id });
                }
              }}
              className="text-slate-500 hover:text-green-600"
              aria-label={t("claims.generateInvoiceTooltip")}
              title={t("claims.generateInvoiceTooltip")}
            >
              <FileText size={16} />
            </button>
          )}
          {row.damage_claims.chargeType === "damage" && (row.damage_claims.status === "accepted" || row.damage_claims.status === "invoiced") && (
            <button
              onClick={() => {
                if (confirm(t("claims.createWorkOrderConfirm"))) {
                  createWorkOrder.mutate({ damageClaimId: row.damage_claims.id, type: "repair", description: row.damage_claims.description });
                }
              }}
              className="text-slate-500 hover:text-amber-600"
              aria-label={t("claims.createWorkOrderTooltip")}
              title={t("claims.createWorkOrderTooltip")}
            >
              <Wrench size={16} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // ─── Tab config ──────────────────────────────────────────
  const tabs: { key: TabFilter; label: string }[] = [
    { key: "all", label: t("claims.tabAll") },
    { key: "pending", label: t("claims.tabPending") },
    { key: "estimated", label: t("claims.tabEstimated") },
    { key: "customer_notified", label: t("claims.tabNotified") },
    { key: "accepted", label: t("claims.tabAccepted") },
    { key: "invoiced", label: t("claims.tabInvoiced") },
    { key: "disputed", label: t("claims.tabDisputed") },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("claims.pageTitle")}</h1>
          <button onClick={openCreate} className="btn-primary flex items-center gap-2">
            <Plus size={18} /> {t("claims.createButton")}
          </button>
        </div>

        {/* Tab Filters */}
        <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === tb.key
                  ? "border-[var(--primary)] text-[var(--primary)]"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <DataTable
          data={claimData || []}
          columns={columns}
          isLoading={isLoading}
          emptyMessage={t("claims.noClaimsFound")}
          searchPlaceholder={t("claims.searchPlaceholder")}
        />
      </div>

      {/* ─── Create Dialog ─────────────────────────────────── */}
      {createOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setCreateOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("claims.createDialogTitle")}</h2>
              <button onClick={() => setCreateOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("claims.formOrder")} <span className="text-[var(--primary)]">*</span></label>
                {createForm.rentalId ? (
                  <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm">
                    <span className="font-medium text-emerald-800">{orderLabel}</span>
                    <button type="button" onClick={() => { setCreateForm({ ...createForm, rentalId: "" }); setOrderLabel(""); setOrderSearch(""); }} className="ml-auto text-xs text-slate-500 hover:underline">{t("claims.changeOrder")}</button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      value={orderSearch}
                      onChange={(e) => setOrderSearch(e.target.value)}
                      placeholder={t("claims.orderSearchPlaceholder")}
                      className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
                    />
                    {orderSearch.trim().length >= 2 && (orderMatches?.length ?? 0) > 0 && (
                      <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow max-h-56 overflow-y-auto">
                        {(orderMatches ?? []).map((o) => (
                          <li key={o.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setCreateForm({ ...createForm, rentalId: String(o.id) });
                                setOrderLabel(`${o.financialOrderNumber || o.rentalNumber || `#${o.id}`} — ${o.customerName ?? ""}`);
                              }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
                            >
                              <span className="font-medium">{o.financialOrderNumber || o.rentalNumber || `#${o.id}`}</span>
                              <span className="text-slate-500 ml-1">— {o.customerName}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("claims.formReason")} <span className="text-[var(--primary)]">*</span></label>
                <select value={createForm.chargeType} onChange={(e) => setCreateForm({ ...createForm, chargeType: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                  {EXTRA_CHARGE_REASONS.map((r) => (
                    <option key={r} value={r}>{EXTRA_CHARGE_LABELS[r][lang]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("claims.formDescription")} <span className="text-[var(--primary)]">*</span></label>
                <textarea value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} rows={3} placeholder={t("claims.descriptionPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{createForm.chargeType === "damage" ? t("claims.formRepairEstimate") : t("claims.formAmount")}</label>
                <input type="number" step="0.01" min="0" placeholder="0.00" value={createForm.amount} onChange={(e) => setCreateForm({ ...createForm, amount: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setCreateOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleCreate} disabled={createMut.isPending} className="btn-primary">{t("claims.createClaimButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Update Status Dialog ──────────────────────────── */}
      {statusOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setStatusOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("claims.updateStatusDialogTitle")}</h2>
              <button onClick={() => setStatusOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("claims.formStatus")} <span className="text-[var(--primary)]">*</span></label>
                <select value={statusForm.status} onChange={(e) => setStatusForm({ ...statusForm, status: e.target.value as ClaimStatus })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                  {CLAIM_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("claims.formApprovedAmount")}</label>
                <input type="number" step="0.01" min="0" placeholder="0.00" value={statusForm.approvedAmount} onChange={(e) => setStatusForm({ ...statusForm, approvedAmount: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("claims.formCustomerResponse")}</label>
                <textarea value={statusForm.customerResponse} onChange={(e) => setStatusForm({ ...statusForm, customerResponse: e.target.value })} rows={2} placeholder={t("claims.responseOptionalPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setStatusOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleUpdateStatus} disabled={updateStatusMut.isPending} className="btn-primary">{t("claims.updateStatusButton")}</button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
