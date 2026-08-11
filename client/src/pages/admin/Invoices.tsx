import { useState, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import DataTable, { Column } from "@/components/DataTable";
import BatchActionBar from "@/components/BatchActionBar";
import ExportToolbar from "@/components/ExportToolbar";
import { trpc } from "@/lib/trpc";
import ProvinceSelect from "@/components/ProvinceSelect";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { exportCsv } from "@/lib/csvExport";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { useFormatCalendarDate, useAppTimezone, formatCalendarDate, formatCalendarDateISO } from "@/lib/dateUtils";
import {
  Plus,
  Trash2,
  X,
  DollarSign,
  AlertCircle,
  FileText,
  Send,
  Eye,
  CreditCard,
  PlusCircle,
  FileDown,
  Clock,
  Wallet,
  MailCheck,
} from "lucide-react";
import { PAYMENT_METHODS, type PaymentMethod } from "@shared/paymentMethod";
import { invalidatePaymentCaches } from "@/lib/paymentCache";
import { useLocation, useSearch } from "wouter";
import { getPositiveSearchParam } from "@/lib/adminSearchNavigation";
import { serverErrorText } from "@/lib/serverError";
import { canUseModulePermission } from "@/lib/modulePermissions";
import { translateDynamic } from "@/lib/i18nHelpers";

type TabFilter = "all" | "draft" | "sent" | "unpaid" | "paid" | "partial" | "overdue";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  partial: "bg-yellow-100 text-yellow-700",
  overdue: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-500",
  credited: "bg-purple-100 text-purple-700",
};

const _INVOICE_TYPE_VALUES = ["rental", "fuel_surcharge", "damage", "delivery", "credit_note", "manual"] as const;

type InvoiceType = (typeof _INVOICE_TYPE_VALUES)[number];

const emptyPaymentForm = {
  amount: "",
  paymentMethod: "e_transfer" as PaymentMethod,
  paymentDate: formatCalendarDateISO(new Date()),
  reference: "",
  notes: "",
};

const emptyRentalForm = {
  rentalId: "",
  dueInDays: "30",
};

interface LineItem {
  description: string;
  quantity: string;
  unitPrice: string;
}

const emptyManualForm = {
  customerId: "",
  type: "manual" as InvoiceType,
  taxProvince: "ON",
  notes: "",
  lineItems: [{ description: "", quantity: "1", unitPrice: "" }] as LineItem[],
  dueInDays: "30",
};

export default function Invoices() {
  const { t } = useTranslation("admin");
  const batchEnabled = useFeatureFlag("batch_operations");
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const can = (module: Parameters<typeof canUseModulePermission>[1], action: Parameters<typeof canUseModulePermission>[2]) =>
    canUseModulePermission(myPerms, module, action);

  const PAYMENT_METHOD_OPTIONS = PAYMENT_METHODS.map((m) => ({ value: m.value, label: t(m.i18nKey) }));

  const INVOICE_TYPES = [
    { value: "rental" as InvoiceType, label: t("invoices.typeRental") },
    { value: "fuel_surcharge" as InvoiceType, label: t("invoices.typeFuelSurcharge") },
    { value: "damage" as InvoiceType, label: t("invoices.typeDamage") },
    { value: "delivery" as InvoiceType, label: t("invoices.typeDelivery") },
    { value: "credit_note" as InvoiceType, label: t("invoices.typeCreditNote") },
    { value: "manual" as InvoiceType, label: t("invoices.typeManual") },
  ];

  // Translate an invoice type enum for display. The table/detail/export used to
  // render the raw enum (`rental` → "rental") on the Chinese UI; reuse the same
  // labels as the type dropdown so they stay in sync.
  const invoiceTypeLabel = (tp: string) =>
    INVOICE_TYPES.find((o) => o.value === tp)?.label ?? tp.replace(/_/g, " ");

  const utils = trpc.useUtils();
  const search = useSearch();
  const [, navigate] = useLocation();
  const linkedInvoiceId = getPositiveSearchParam(search, "invoiceId");

  // ─── Data fetching ──────────────────────────────────────────
  const [tab, setTab] = useState<TabFilter>("all");
  // Date + customer filters (complement the status tabs and free-text search).
  const [filterCustomerId, setFilterCustomerId] = useState<string>("");
  const [dateField, setDateField] = useState<"issue" | "due">("issue");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const hasFilters = !!(filterCustomerId || dateFrom || dateTo);
  const { data: invoiceData, isLoading } = trpc.invoices.list.useQuery({
    status: tab === "all" ? undefined : tab,
    customerId: filterCustomerId ? Number(filterCustomerId) : undefined,
    dateField,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });
  const { data: summary } = trpc.invoices.summary.useQuery();
  const { data: customers } = trpc.customers.list.useQuery();

  // ─── Mutations ──────────────────────────────────────────────
  const recordPaymentMut = trpc.invoices.recordPayment.useMutation({
    onSuccess: () => {
      // Settles the order's shared ledger → refresh invoice AND rental views.
      invalidatePaymentCaches(utils);
      setPaymentOpen(false);
      toast.success(t("invoices.paymentRecordedSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const generateFromRentalMut = trpc.invoices.generateFromRental.useMutation({
    onSuccess: (_result) => {
      utils.invoices.list.invalidate();
      utils.invoices.summary.invalidate();
      setRentalOpen(false);
      toast.success(t("invoices.createSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const createManualMut = trpc.invoices.createManual.useMutation({
    onSuccess: (_result) => {
      utils.invoices.list.invalidate();
      utils.invoices.summary.invalidate();
      setManualOpen(false);
      toast.success(t("invoices.createSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateStatusMut = trpc.invoices.updateStatus.useMutation({
    onSuccess: () => {
      utils.invoices.list.invalidate();
      utils.invoices.summary.invalidate();
      toast.success(t("invoices.statusUpdatedSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deleteMut = trpc.invoices.delete.useMutation({
    onSuccess: () => {
      utils.invoices.list.invalidate();
      utils.invoices.summary.invalidate();
      toast.success(t("invoices.deleteSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deleteManyMut = trpc.invoices.deleteMany.useMutation({
    onSuccess: (data) => {
      utils.invoices.list.invalidate();
      utils.invoices.summary.invalidate();
      setSelectedKeys(new Set());
      toast.success(t("invoices.deleteManySuccess", { count: data.deleted }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const batchSendMut = trpc.invoices.batchSend.useMutation({
    onSuccess: (result) => {
      utils.invoices.list.invalidate();
      utils.invoices.summary.invalidate();
      setSelectedKeys(new Set());
      const msg = result.failedIds.length > 0
        ? `${result.successIds.length} sent, ${result.failedIds.length} skipped`
        : `${result.successIds.length} invoices sent`;
      toast.success(msg);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const generateInvoicePDF = trpc.invoices.generatePDF.useMutation({
    onSuccess: (result) => { window.open(result.url, "_blank"); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Dialog state ──────────────────────────────────────────
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentInvoiceId, setPaymentInvoiceId] = useState<number | null>(null);
  const [paymentForm, setPaymentForm] = useState(emptyPaymentForm);

  const [rentalOpen, setRentalOpen] = useState(false);
  const [rentalForm, setRentalForm] = useState(emptyRentalForm);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState(emptyManualForm);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  useEffect(() => {
    if (!linkedInvoiceId) return;
    setDetailId(linkedInvoiceId);
    setDetailOpen(true);
  }, [linkedInvoiceId]);
  const { data: detailData } = trpc.invoices.getById.useQuery(
    { id: detailId! },
    { enabled: detailOpen && detailId !== null }
  );

  const closePayment = useCallback(() => setPaymentOpen(false), []);
  const closeRental = useCallback(() => setRentalOpen(false), []);
  const closeManual = useCallback(() => setManualOpen(false), []);
  const closeDetail = useCallback(() => {
    setDetailOpen(false);
    if (linkedInvoiceId) navigate("/admin/invoices");
  }, [linkedInvoiceId, navigate]);
  useEscapeKey(paymentOpen, closePayment);
  useEscapeKey(rentalOpen, closeRental);
  useEscapeKey(manualOpen, closeManual);
  useEscapeKey(detailOpen, closeDetail);

  // ─── Handlers ──────────────────────────────────────────────
  const openRecordPayment = (invoiceId: number) => {
    setPaymentInvoiceId(invoiceId);
    setPaymentForm(emptyPaymentForm);
    setPaymentOpen(true);
  };

  // Taking a payment is the moment credit on file matters — the customer may
  // already have money with us and not need to pay at all. Applying it is P3;
  // for now the office at least gets told it is there instead of finding out
  // afterwards.
  const paymentCustomerId = useMemo(() => {
    if (!paymentInvoiceId) return null;
    const row = (invoiceData || []).find((r) => r.invoices.id === paymentInvoiceId);
    return row?.invoices.customerId ?? null;
  }, [paymentInvoiceId, invoiceData]);
  const { data: payerCredit } = trpc.customerCredit.byCustomer.useQuery(
    { customerId: paymentCustomerId! },
    { enabled: paymentCustomerId != null && paymentOpen },
  );
  const paymentInvoiceBalance = useMemo(() => {
    const row = (invoiceData || []).find((r) => r.invoices.id === paymentInvoiceId);
    return parseFloat(row?.invoices.balanceDue || "0");
  }, [paymentInvoiceId, invoiceData]);
  // Never offer more than the invoice needs, nor more than the customer has.
  const applicableCredit = Math.min(payerCredit?.balance ?? 0, paymentInvoiceBalance);
  const applyCreditMut = trpc.customerCredit.applyToInvoice.useMutation({
    onSuccess: (res) => {
      utils.invoices.list.invalidate();
      utils.invoices.summary.invalidate();
      utils.invoices.getById.invalidate();
      utils.customerCredit.byCustomer.invalidate();
      utils.customerCredit.overview.invalidate();
      setPaymentOpen(false);
      toast.success(t("invoices.creditApplied", { balance: res.balance.toFixed(2) }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const handleRecordPayment = () => {
    if (!paymentInvoiceId) return;
    const amount = parseFloat(paymentForm.amount);
    if (!amount || amount <= 0) return toast.error(t("invoices.validAmountRequired"));
    recordPaymentMut.mutate({
      invoiceId: paymentInvoiceId,
      amount,
      paymentMethod: paymentForm.paymentMethod,
      paymentDate: paymentForm.paymentDate,
      reference: paymentForm.reference || undefined,
      notes: paymentForm.notes || undefined,
    });
  };

  const openGenerateFromRental = () => {
    setRentalForm(emptyRentalForm);
    setRentalOpen(true);
  };

  const handleGenerateFromRental = () => {
    const rentalId = parseInt(rentalForm.rentalId, 10);
    if (!rentalId || isNaN(rentalId)) return toast.error(t("invoices.validRentalIdRequired"));
    const dueInDays = parseInt(rentalForm.dueInDays, 10);
    generateFromRentalMut.mutate({
      rentalId,
      dueInDays: dueInDays && !isNaN(dueInDays) ? dueInDays : undefined,
    });
  };

  const openCreateManual = () => {
    setManualForm({ ...emptyManualForm, lineItems: [{ description: "", quantity: "1", unitPrice: "" }] });
    setManualOpen(true);
  };

  const addLineItem = () => {
    setManualForm({
      ...manualForm,
      lineItems: [...manualForm.lineItems, { description: "", quantity: "1", unitPrice: "" }],
    });
  };

  const removeLineItem = (idx: number) => {
    if (manualForm.lineItems.length <= 1) return;
    setManualForm({
      ...manualForm,
      lineItems: manualForm.lineItems.filter((_, i) => i !== idx),
    });
  };

  const updateLineItem = (idx: number, field: keyof LineItem, value: string) => {
    const items = [...manualForm.lineItems];
    items[idx] = { ...items[idx], [field]: value };
    setManualForm({ ...manualForm, lineItems: items });
  };

  const handleCreateManual = () => {
    const customerId = parseInt(manualForm.customerId, 10);
    if (!customerId || isNaN(customerId)) return toast.error(t("invoices.selectCustomer"));
    const lineItems = manualForm.lineItems
      .filter((li) => li.description && li.unitPrice)
      .map((li) => ({
        description: li.description,
        quantity: parseFloat(li.quantity) || 1,
        unitPrice: parseFloat(li.unitPrice) || 0,
      }));
    if (lineItems.length === 0) return toast.error(t("invoices.lineItemRequired"));
    const dueInDays = parseInt(manualForm.dueInDays, 10);
    createManualMut.mutate({
      customerId,
      type: manualForm.type,
      taxProvince: manualForm.taxProvince || undefined,
      notes: manualForm.notes || undefined,
      lineItems,
      dueInDays: dueInDays && !isNaN(dueInDays) ? dueInDays : undefined,
    });
  };

  const openDetail = (id: number) => {
    setDetailId(id);
    setDetailOpen(true);
  };

  // ─── Helpers ──────────────────────────────────────────────
  const fmtDate = useFormatCalendarDate();
  const tz = useAppTimezone();

  const fmtNum = (v: string | number | null | undefined) => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return n != null && !isNaN(n) ? formatCurrency(n) : "-";
  };

  // ─── Table data ──────────────────────────────────────────
  type InvoiceRow = NonNullable<typeof invoiceData>[number];

  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set());
  const [filteredData, setFilteredData] = useState<InvoiceRow[]>([]);
  const [pageTableData, setPageTableData] = useState<InvoiceRow[]>([]);

  const handleDataReady = useCallback((info: { filtered: InvoiceRow[]; pageData: InvoiceRow[] }) => {
    setFilteredData(info.filtered);
    setPageTableData(info.pageData);
  }, []);

  const columns: Column<InvoiceRow>[] = [
    {
      key: "invoices.invoiceNumber",
      label: t("invoices.columnInvoiceNo"),
      render: (row) => (
        <button
          onClick={() => openDetail(row.invoices.id)}
          className="text-slate-900 font-medium hover:text-[var(--primary)] hover:underline text-left"
        >
          {row.invoices.invoiceNumber}
        </button>
      ),
    },
    {
      key: "customers.name",
      label: t("invoices.columnCustomer"),
      render: (row) => row.customers?.name || "-",
      hideOnMobile: true,
    },
    {
      key: "invoices.type",
      label: t("invoices.columnType"),
      render: (row) => (
        <span className="capitalize text-sm">{invoiceTypeLabel(row.invoices.type)}</span>
      ),
      hideOnMobile: true,
    },
    {
      key: "invoices.issueDate",
      label: t("invoices.columnIssueDate"),
      render: (row) => <span className="text-sm text-slate-500">{fmtDate(row.invoices.issueDate)}</span>,
      hideOnMobile: true,
    },
    {
      key: "invoices.dueDate",
      label: t("invoices.columnDueDate"),
      render: (row) => <span className="text-sm text-slate-500">{fmtDate(row.invoices.dueDate)}</span>,
      hideOnMobile: true,
    },
    {
      key: "invoices.totalAmount",
      label: t("invoices.columnTotal"),
      render: (row) => <span className="text-sm font-medium text-slate-900">{fmtNum(row.invoices.totalAmount)}</span>,
    },
    {
      key: "invoices.amountPaid",
      label: t("invoices.columnAllocated"),
      render: (row) => (
        <div className="text-sm text-slate-700">
          <span>{fmtNum(row.invoices.invoiceAllocated)}</span>
          {row.invoices.orderCreditBalance > 0 && (
            <span className="ml-1 text-xs text-purple-700">+{fmtNum(row.invoices.orderCreditBalance)} {t("invoices.creditShort")}</span>
          )}
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: "invoices.balanceDue",
      label: t("invoices.columnBalance"),
      render: (row) => {
        const bal = parseFloat(row.invoices.balanceDue as string) || 0;
        return (
          <span className={`text-sm font-medium ${bal > 0 ? "text-red-600" : "text-green-600"}`}>
            {fmtNum(row.invoices.balanceDue)}
          </span>
        );
      },
      hideOnMobile: true,
    },
    {
      key: "invoices.status",
      label: t("invoices.columnStatus"),
      render: (row) => {
        const status = row.invoices.status;
        const emailSentAt = (row.invoices as { emailSentAt?: string | Date | null }).emailSentAt;
        return (
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-slate-100 text-slate-700"}`}
              title={status === "sent" ? t("invoices.statusSentHint") : undefined}
            >
              {translateDynamic(t, `invoices.status${status.charAt(0).toUpperCase() + status.slice(1)}`, { defaultValue: status })}
            </span>
            {emailSentAt && (
              <span
                className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700"
                title={t("invoices.badgeEmailSentTooltip", { time: fmtDate(emailSentAt) })}
              >
                <MailCheck size={11} /> {t("invoices.badgeEmailSent")}
              </span>
            )}
            {(row.invoices as { needsPaymentReminder?: boolean }).needsPaymentReminder && (
              <span
                className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700"
                title={t("invoices.badgeNeedsPaymentTooltip")}
              >
                <Clock size={11} /> {t("invoices.badgeNeedsPayment")}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "_actions",
      label: t("invoices.columnActions"),
      sortable: false,
      searchable: false,
      render: (row) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => openDetail(row.invoices.id)}
            className="text-slate-500 hover:text-slate-900"
            aria-label={t("invoices.viewDetailsTooltip")}
            title={t("invoices.viewDetailsTooltip")}
          >
            <Eye size={16} />
          </button>
          {row.invoices.status !== "paid" && row.invoices.status !== "cancelled" && (
            <button
              onClick={() => openRecordPayment(row.invoices.id)}
              className="text-slate-500 hover:text-green-600"
              aria-label={t("invoices.recordPaymentTooltip")}
              title={t("invoices.recordPaymentTooltip")}
            >
              <CreditCard size={16} />
            </button>
          )}
          {row.invoices.status === "draft" && (
            <button
              onClick={() => updateStatusMut.mutate({ id: row.invoices.id, status: "sent" })}
              className="text-slate-500 hover:text-blue-600"
              aria-label={t("invoices.markAsSentTooltip")}
              title={t("invoices.markAsSentTooltip")}
            >
              <Send size={16} />
            </button>
          )}
          {can('invoices', 'delete') && row.invoices.status !== "paid" && (
            <button
              onClick={() => {
                if (confirm(t("invoices.deleteConfirm"))) deleteMut.mutate({ id: row.invoices.id });
              }}
              className="text-slate-400 hover:text-[var(--primary)]"
              aria-label={t("invoices.deleteConfirm")}
              title={t("invoices.deleteConfirm")}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // ─── Tab config ──────────────────────────────────────────
  const tabs: { key: TabFilter; label: string }[] = [
    { key: "all", label: t("invoices.tabAll") },
    { key: "draft", label: t("invoices.tabDraft") },
    { key: "sent", label: t("invoices.tabSent") },
    { key: "unpaid", label: t("invoices.tabUnpaid") },
    { key: "partial", label: t("invoices.tabPartial") },
    { key: "paid", label: t("invoices.tabPaid") },
    { key: "overdue", label: t("invoices.tabOverdue") },
  ];

  // ─── Line items subtotal for manual form ────────────────
  const manualSubtotal = manualForm.lineItems.reduce((sum, li) => {
    const qty = parseFloat(li.quantity) || 0;
    const price = parseFloat(li.unitPrice) || 0;
    return sum + qty * price;
  }, 0);

  const exportColumns = [
    { key: "invoiceNo", label: t("invoices.columnInvoiceNo") },
    { key: "customer", label: t("invoices.columnCustomer") },
    { key: "type", label: t("invoices.columnType") },
    { key: "total", label: t("invoices.columnTotal") },
    { key: "status", label: t("invoices.columnStatus") },
    { key: "dueDate", label: t("invoices.columnDueDate") },
  ];

  const mapInvoiceForExport = (row: InvoiceRow) => ({
    invoiceNo: row.invoices.invoiceNumber,
    customer: row.customers?.name || "",
    type: invoiceTypeLabel(row.invoices.type),
    total: row.invoices.totalAmount,
    status: row.invoices.status,
    dueDate: row.invoices.dueDate ? formatCalendarDate(row.invoices.dueDate, tz) : "",
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("invoices.pageTitle")}</h1>
          <div className="flex items-center gap-2">
            <ExportToolbar
              allData={filteredData.map(mapInvoiceForExport)}
              pageData={pageTableData.map(mapInvoiceForExport)}
              selectedData={Array.from(selectedKeys).map(k => {
                const r = (invoiceData || []).find((_, i) => i === k);
                return r ? mapInvoiceForExport(r) : null;
              }).filter(Boolean) as Record<string, unknown>[]}
              columns={exportColumns}
              fileName="invoices"
              title={t("invoices.pageTitle")}
            />
            {can('invoices', 'create') && (
              <>
                <button onClick={openGenerateFromRental} className="btn-secondary flex items-center gap-2">
                  <FileText size={18} /> {t("invoices.fromRentalButton")}
                </button>
                <button onClick={openCreateManual} className="btn-primary flex items-center gap-2">
                  <Plus size={18} /> {t("invoices.createButton")}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Summary Cards — min-w-0 + tabular-nums + truncate so large currency
            amounts never overflow the (now narrower) cards. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 flex items-center gap-3 min-w-0">
            <div className="shrink-0 p-2.5 rounded-lg bg-blue-50 text-blue-500">
              <DollarSign size={22} />
            </div>
            <div className="min-w-0">
              <div className="text-2xl font-extrabold tracking-tight text-[var(--on-surface)] tabular-nums truncate" title={formatCurrency(summary?.totalOutstanding || 0)}>{formatCurrency(summary?.totalOutstanding || 0)}</div>
              <div className="text-sm text-slate-500 truncate">{t("invoices.summaryOutstanding")}</div>
            </div>
          </div>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 flex items-center gap-3 min-w-0">
            <div className="shrink-0 p-2.5 rounded-lg bg-red-50 text-red-500">
              <AlertCircle size={22} />
            </div>
            <div className="min-w-0">
              <div className="text-2xl font-extrabold tracking-tight text-[var(--on-surface)] tabular-nums truncate" title={formatCurrency(summary?.totalOverdue || 0)}>{formatCurrency(summary?.totalOverdue || 0)}</div>
              <div className="text-sm text-slate-500 truncate">{t("invoices.summaryOverdue")}</div>
            </div>
          </div>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 flex items-center gap-3 min-w-0">
            <div className="shrink-0 p-2.5 rounded-lg bg-slate-100 text-slate-500">
              <FileText size={22} />
            </div>
            <div className="min-w-0">
              <div className="text-2xl font-extrabold tracking-tight text-[var(--on-surface)] tabular-nums truncate">{summary?.draftCount || 0}</div>
              <div className="text-sm text-slate-500 truncate">{t("invoices.summaryDraftCount")}</div>
            </div>
          </div>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 flex items-center gap-3 min-w-0">
            <div className="shrink-0 p-2.5 rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
              <AlertCircle size={22} />
            </div>
            <div className="min-w-0">
              <div className="text-2xl font-extrabold tracking-tight text-[var(--on-surface)] tabular-nums truncate">{summary?.overdueCount || 0}</div>
              <div className="text-sm text-slate-500 truncate">{t("invoices.summaryOverdueCount")}</div>
            </div>
          </div>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 flex items-center gap-3 min-w-0">
            <div className="shrink-0 p-2.5 rounded-lg bg-amber-50 text-amber-600">
              <Clock size={22} />
            </div>
            <div className="min-w-0">
              <div className="text-2xl font-extrabold tracking-tight text-[var(--on-surface)] tabular-nums truncate">{summary?.reminderCount || 0}</div>
              <div className="text-sm text-slate-500 truncate">{t("invoices.summaryReminderCount")}</div>
            </div>
          </div>
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

        {/* Customer + date-range filters */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 min-w-[180px]">
            <label htmlFor="flt-customer" className="text-xs text-slate-500 font-medium">{t("invoices.filterCustomer")}</label>
            <select
              id="flt-customer"
              value={filterCustomerId}
              onChange={(e) => setFilterCustomerId(e.target.value)}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
            >
              <option value="">{t("invoices.filterAllCustomers")}</option>
              {(customers || []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="flt-datefield" className="text-xs text-slate-500 font-medium">{t("invoices.filterDateField")}</label>
            <select
              id="flt-datefield"
              value={dateField}
              onChange={(e) => setDateField(e.target.value as "issue" | "due")}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
            >
              <option value="issue">{t("invoices.columnIssueDate")}</option>
              <option value="due">{t("invoices.columnDueDate")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="flt-from" className="text-xs text-slate-500 font-medium">{t("invoices.filterDateFrom")}</label>
            <input id="flt-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="flt-to" className="text-xs text-slate-500 font-medium">{t("invoices.filterDateTo")}</label>
            <input id="flt-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
          </div>
          {hasFilters && (
            <button
              type="button"
              onClick={() => { setFilterCustomerId(""); setDateFrom(""); setDateTo(""); }}
              className="px-3 py-2 text-sm text-slate-600 hover:text-[var(--primary)] underline"
            >
              {t("invoices.filterClear")}
            </button>
          )}
        </div>

        {/* Batch delete bar */}
        {selectedKeys.size > 0 && can("invoices", "delete") && (
          <div className="flex items-center gap-3 px-4 py-2 bg-red-50 rounded-lg border border-red-200">
            <span className="text-sm font-medium text-red-700">
              {t("invoices.selectedCount", { count: selectedKeys.size })}
            </span>
            <button
              className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700"
              onClick={() => {
                if (confirm(t("invoices.deleteManyConfirm", { count: selectedKeys.size }))) {
                  deleteManyMut.mutate({ ids: Array.from(selectedKeys).map(Number) });
                }
              }}
            >
              <Trash2 className="inline w-3.5 h-3.5 mr-1" />
              {t("invoices.deleteSelected", { count: selectedKeys.size })}
            </button>
          </div>
        )}

        {/* Table */}
        <div>
          <DataTable
            data={invoiceData || []}
            columns={columns}
            isLoading={isLoading}
            emptyMessage={t("invoices.noInvoicesFound")}
            searchPlaceholder={t("invoices.searchPlaceholder")}
            selectable
            selectedKeys={selectedKeys}
            onSelectionChange={setSelectedKeys}
            onDataReady={handleDataReady}
            rowKey={(row) => row.invoices.id}
            // Money owed on top. Paid invoices carry a 0 balance and sink to the
            // bottom on their own, so the first screen is always the work list.
            defaultSortKey="invoices.balanceDue"
            defaultSortDir="desc"
          />
          {batchEnabled && (
            <BatchActionBar
              selectedCount={selectedKeys.size}
              onClear={() => setSelectedKeys(new Set())}
            >
              <button
                type="button"
                onClick={() => {
                  const ids = Array.from(selectedKeys).map(Number);
                  batchSendMut.mutate({ ids });
                }}
                disabled={batchSendMut.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Send size={14} aria-hidden="true" />
                {t("invoices.batchSendAll")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const rows = (invoiceData || [])
                    .filter((row) => selectedKeys.has(row.invoices.id))
                    .map((row) => ({
                      invoiceNumber: row.invoices.invoiceNumber,
                      customer: row.customers?.name ?? "",
                      type: row.invoices.type,
                      status: row.invoices.status,
                      issueDate: row.invoices.issueDate ? formatCalendarDate(row.invoices.issueDate, tz) : "",
                      dueDate: row.invoices.dueDate ? formatCalendarDate(row.invoices.dueDate, tz) : "",
                      total: row.invoices.totalAmount ?? "",
                      paid: row.invoices.amountPaid ?? "",
                      balance: row.invoices.balanceDue ?? "",
                    }));
                  exportCsv("invoices-export.csv", rows);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-600 text-white hover:bg-slate-700 transition-colors"
              >
                <FileDown size={14} aria-hidden="true" />
                {t("invoices.batchExportCsv")}
              </button>
            </BatchActionBar>
          )}
        </div>
      </div>

      {/* ─── Record Payment Dialog ─────────────────────────── */}
      {paymentOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setPaymentOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("invoices.recordPaymentDialogTitle")}</h2>
              <button onClick={() => setPaymentOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              {(payerCredit?.balance ?? 0) > 0 && (
                <div className="text-sm bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <Wallet size={16} className="shrink-0" />
                    <span>{t("invoices.payerHasCredit", { amount: (payerCredit!.balance).toFixed(2) })}</span>
                  </div>
                  {applicableCredit > 0.005 && (
                    <button
                      type="button"
                      disabled={applyCreditMut.isPending}
                      onClick={() => applyCreditMut.mutate({ invoiceId: paymentInvoiceId!, amount: applicableCredit })}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                    >
                      {t("invoices.applyCredit", { amount: applicableCredit.toFixed(2) })}
                    </button>
                  )}
                </div>
              )}
              <div>
                <label htmlFor="pay-amount" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formAmount")} <span className="text-[var(--primary)]">*</span></label>
                <input id="pay-amount" type="number" step="0.01" min="0" placeholder="0.00" value={paymentForm.amount} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label htmlFor="pay-method" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formPaymentMethod")} <span className="text-[var(--primary)]">*</span></label>
                <select id="pay-method" value={paymentForm.paymentMethod} onChange={(e) => setPaymentForm({ ...paymentForm, paymentMethod: e.target.value as PaymentMethod })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                  {PAYMENT_METHOD_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="pay-date" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formPaymentDate")} <span className="text-[var(--primary)]">*</span></label>
                <input id="pay-date" type="date" value={paymentForm.paymentDate} onChange={(e) => setPaymentForm({ ...paymentForm, paymentDate: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label htmlFor="pay-ref" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formReference")}</label>
                <input id="pay-ref" placeholder={t("invoices.optionalPlaceholder")} value={paymentForm.reference} onChange={(e) => setPaymentForm({ ...paymentForm, reference: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label htmlFor="pay-notes" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formNotes")}</label>
                <textarea id="pay-notes" placeholder={t("invoices.optionalPlaceholder")} value={paymentForm.notes} onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })} rows={2} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setPaymentOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleRecordPayment} disabled={recordPaymentMut.isPending} className="btn-primary">{t("invoices.recordPaymentButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Generate from Rental Dialog ───────────────────── */}
      {rentalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setRentalOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("invoices.generateFromRentalDialogTitle")}</h2>
              <button onClick={() => setRentalOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label htmlFor="rental-id" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formRentalId")} <span className="text-[var(--primary)]">*</span></label>
                <input id="rental-id" type="number" placeholder={t("invoices.rentalIdPlaceholder")} value={rentalForm.rentalId} onChange={(e) => setRentalForm({ ...rentalForm, rentalId: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label htmlFor="rental-due" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formDueInDays")}</label>
                <input id="rental-due" type="number" placeholder="30" value={rentalForm.dueInDays} onChange={(e) => setRentalForm({ ...rentalForm, dueInDays: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setRentalOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleGenerateFromRental} disabled={generateFromRentalMut.isPending} className="btn-primary">{t("invoices.generateInvoiceButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Create Manual Invoice Dialog ──────────────────── */}
      {manualOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setManualOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("invoices.createManualDialogTitle")}</h2>
              <button onClick={() => setManualOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="manual-customer" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formCustomer")} <span className="text-[var(--primary)]">*</span></label>
                  <select id="manual-customer" value={manualForm.customerId} onChange={(e) => setManualForm({ ...manualForm, customerId: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    <option value="">{t("invoices.selectCustomerPlaceholder")}</option>
                    {(customers || []).map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="manual-type" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formInvoiceType")}</label>
                  <select id="manual-type" value={manualForm.type} onChange={(e) => setManualForm({ ...manualForm, type: e.target.value as InvoiceType })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    {INVOICE_TYPES.map((it) => (
                      <option key={it.value} value={it.value}>{it.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="manual-province" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formTaxProvince")}</label>
                  <ProvinceSelect id="manual-province" value={manualForm.taxProvince} onChange={(v) => setManualForm({ ...manualForm, taxProvince: v })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label htmlFor="manual-due" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formDueInDays")}</label>
                  <input id="manual-due" type="number" placeholder="30" value={manualForm.dueInDays} onChange={(e) => setManualForm({ ...manualForm, dueInDays: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>

              {/* Line Items */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-slate-700">{t("invoices.lineItemsLabel")} <span className="text-[var(--primary)]">*</span></label>
                  <button type="button" onClick={addLineItem} className="text-sm text-[var(--primary)] hover:text-[#A01E15] flex items-center gap-1">
                    <PlusCircle size={14} /> {t("invoices.addLineItemButton")}
                  </button>
                </div>
                <div className="space-y-2">
                  {manualForm.lineItems.map((li, idx) => (
                    <div key={idx} className="flex flex-col gap-2 pb-3 border-b border-slate-200/60 last:border-b-0 sm:grid sm:grid-cols-[1fr_80px_100px_32px] sm:gap-2 sm:items-end sm:pb-0 sm:border-b-0">
                      <div>
                        {idx === 0 && <span className="hidden sm:block text-xs text-slate-500 mb-1">{t("invoices.lineItemDescription")}</span>}
                        <input placeholder={t("invoices.lineItemDescription")} value={li.description} onChange={(e) => updateLineItem(idx, "description", e.target.value)} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                      </div>
                      <div>
                        {idx === 0 && <span className="hidden sm:block text-xs text-slate-500 mb-1">{t("invoices.lineItemQuantity")}</span>}
                        <input type="number" min="0.01" step="0.01" placeholder="1" value={li.quantity} onChange={(e) => updateLineItem(idx, "quantity", e.target.value)} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                      </div>
                      <div>
                        {idx === 0 && <span className="hidden sm:block text-xs text-slate-500 mb-1">{t("invoices.lineItemUnitPrice")}</span>}
                        <input type="number" step="0.01" placeholder="0.00" value={li.unitPrice} onChange={(e) => updateLineItem(idx, "unitPrice", e.target.value)} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                      </div>
                      <div>
                        {idx === 0 && <span className="hidden sm:block text-xs text-slate-500 mb-1">&nbsp;</span>}
                        <button
                          type="button"
                          onClick={() => removeLineItem(idx)}
                          disabled={manualForm.lineItems.length <= 1}
                          className="tap-target p-2 text-slate-400 hover:text-[var(--primary)] disabled:opacity-30"
                          aria-label="Remove line item"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-right mt-2 text-sm text-slate-600">
                  {t("invoices.subtotalLabel")} <span className="font-medium text-slate-900">{formatCurrency(manualSubtotal)}</span>
                </div>
              </div>

              <div>
                <label htmlFor="manual-notes" className="block text-sm font-medium text-slate-700 mb-1">{t("invoices.formNotes")}</label>
                <textarea id="manual-notes" placeholder={t("invoices.optionalPlaceholder")} value={manualForm.notes} onChange={(e) => setManualForm({ ...manualForm, notes: e.target.value })} rows={2} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setManualOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleCreateManual} disabled={createManualMut.isPending} className="btn-primary">{t("invoices.createManualButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Invoice Detail Dialog ─────────────────────────── */}
      {detailOpen && detailData && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={closeDetail}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("invoices.columnInvoiceNo")} {detailData.invoices.invoiceNumber}</h2>
              <button onClick={closeDetail} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>

            {/* Invoice Info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-slate-500">{t("invoices.detailCustomer")}</span>{" "}
                <span className="font-medium text-slate-900">{detailData.customers?.name || "-"}</span>
              </div>
              <div>
                <span className="text-slate-500">{t("invoices.detailStatus")}</span>{" "}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[detailData.invoices.status] || "bg-slate-100 text-slate-700"}`}
                  title={detailData.invoices.status === "sent" ? t("invoices.statusSentHint") : undefined}
                >
                  {translateDynamic(t, `invoices.status${detailData.invoices.status.charAt(0).toUpperCase() + detailData.invoices.status.slice(1)}`, { defaultValue: detailData.invoices.status })}
                </span>
                {(detailData.invoices as { emailSentAt?: string | Date | null }).emailSentAt && (
                  <span
                    className="ml-1.5 inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700"
                    title={t("invoices.badgeEmailSentTooltip", { time: fmtDate((detailData.invoices as { emailSentAt?: string | Date | null }).emailSentAt!) })}
                  >
                    <MailCheck size={11} /> {t("invoices.badgeEmailSent")}
                  </span>
                )}
              </div>
              <div>
                <span className="text-slate-500">{t("invoices.detailType")}</span>{" "}
                <span className="capitalize">{invoiceTypeLabel(detailData.invoices.type)}</span>
              </div>
              <div>
                <span className="text-slate-500">{t("invoices.detailIssueDate")}</span> {fmtDate(detailData.invoices.issueDate)}
              </div>
              <div>
                <span className="text-slate-500">{t("invoices.detailDueDate")}</span> {fmtDate(detailData.invoices.dueDate)}
              </div>
              <div>
                <span className="text-slate-500">{t("invoices.detailRentalId")}</span> {detailData.rental?.rentalNumber || detailData.invoices.rentalId || "-"}
              </div>
            </div>

            {/* Line Items */}
            {detailData.lineItems && detailData.lineItems.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-900 mb-2">{t("invoices.detailLineItemsHeading")}</h3>
                {/* Mobile: stacked rows (description + qty×price subtitle / amount) */}
                <div className="md:hidden divide-y divide-slate-100 border-b border-slate-200">
                  {detailData.lineItems.map((li) => (
                    <div key={li.id} className="py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-slate-900">{li.description}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{li.quantity} × {fmtNum(li.unitPrice)}</div>
                      </div>
                      <div className="text-sm tabular-nums text-slate-900 shrink-0">{fmtNum(li.amount)}</div>
                    </div>
                  ))}
                </div>
                {/* Desktop: full 4-col table */}
                <table className="hidden md:table w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-slate-500">
                      <th className="pb-2">{t("invoices.lineItemDescription")}</th>
                      <th className="pb-2 text-right">{t("invoices.lineItemQuantity")}</th>
                      <th className="pb-2 text-right">{t("invoices.lineItemUnitPrice")}</th>
                      <th className="pb-2 text-right">{t("invoices.lineItemAmount")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailData.lineItems.map((li) => (
                      <tr key={li.id} className="border-b border-slate-100">
                        <td className="py-1.5">{li.description}</td>
                        <td className="py-1.5 text-right">{li.quantity}</td>
                        <td className="py-1.5 text-right">{fmtNum(li.unitPrice)}</td>
                        <td className="py-1.5 text-right">{fmtNum(li.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Totals */}
            <div className="border-t border-slate-200 pt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">{t("invoices.detailSubtotal")}</span>
                <span>{fmtNum(detailData.invoices.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t("invoices.detailTax")}</span>
                <span>{fmtNum(detailData.invoices.taxAmount)}</span>
              </div>
              <div className="flex justify-between font-bold text-slate-900">
                <span>{t("invoices.detailTotal")}</span>
                <span>{fmtNum(detailData.invoices.totalAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">{t("invoices.detailInvoiceAllocated")}</span>
                <span className="text-green-600">{fmtNum(detailData.invoices.invoiceAllocated)}</span>
              </div>
              <div className="flex justify-between font-bold">
                <span className="text-slate-500">{t("invoices.detailBalanceDue")}</span>
                <span className="text-red-600">{fmtNum(detailData.invoices.balanceDue)}</span>
              </div>
              {detailData.invoices.orderCreditBalance > 0 && (
                <div className="flex justify-between font-bold text-purple-700">
                  <span>{t("invoices.detailOrderCreditBalance")}</span>
                  <span>{fmtNum(detailData.invoices.orderCreditBalance)}</span>
                </div>
              )}
            </div>

            {/* Payments */}
            {detailData.payments && detailData.payments.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-900 mb-2">{t("invoices.paymentHistoryHeading")}</h3>
                <div className="space-y-2">
                  {detailData.payments.map((p) => (
                    <div key={p.payments.id} className="flex items-center justify-between text-sm bg-slate-50 rounded-lg px-3 py-2">
                      <div>
                        <span className="font-medium">{fmtNum(p.payments.amount)}</span>
                        <span className="text-slate-500 ml-2 capitalize">{p.payments.paymentMethod.replace(/_/g, " ")}</span>
                        {p.payments.reference && <span className="text-slate-400 ml-2">#{p.payments.reference}</span>}
                      </div>
                      <span className="text-slate-400 text-xs">{fmtDate(p.payments.paymentDate)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Notes */}
            {detailData.invoices.notes && (
              <div>
                <h3 className="text-sm font-semibold text-slate-900 mb-1">{t("invoices.detailNotesHeading")}</h3>
                <p className="text-sm text-slate-600">{detailData.invoices.notes}</p>
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button onClick={closeDetail} className="btn-secondary">{t("invoices.closeButton")}</button>
              <button
                onClick={() => generateInvoicePDF.mutate({ invoiceId: detailData.invoices.id })}
                disabled={generateInvoicePDF.isPending}
                className="flex items-center gap-2 px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition"
              >
                <FileDown size={16} />
                {generateInvoicePDF.isPending ? "..." : "PDF"}
              </button>
              {detailData.invoices.status !== "paid" && detailData.invoices.status !== "cancelled" && (
                <button
                  onClick={() => {
                    setDetailOpen(false);
                    openRecordPayment(detailData.invoices.id);
                  }}
                  className="btn-primary flex items-center gap-2"
                >
                  <CreditCard size={16} /> {t("invoices.recordPaymentButton")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
