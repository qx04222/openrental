import { useState } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import DataTable, { Column } from "@/components/DataTable";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { X, Eye, FileDown, Trash2 } from "lucide-react";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";
import { canUseModulePermission } from "@/lib/modulePermissions";
import { translateDynamic } from "@/lib/i18nHelpers";

type TabFilter = "all" | "draft" | "sent" | "accepted" | "rejected" | "expired";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-500",
  sent: "bg-blue-100 text-blue-800",
  accepted: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  expired: "bg-amber-100 text-amber-800",
  cancelled: "bg-slate-100 text-slate-500",
};

export default function Quotations() {
  const { t } = useTranslation("quotation");
  const fmtDate = useFormatCalendarDate();
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const can = (module: Parameters<typeof canUseModulePermission>[1], action: Parameters<typeof canUseModulePermission>[2]) =>
    canUseModulePermission(myPerms, module, action);

  const [tabFilter, setTabFilter] = useState<TabFilter>("all");
  const [detailId, setDetailId] = useState<number | null>(null);

  const utils = trpc.useUtils();
  const { data: rows = [], isLoading } = trpc.quotations.list.useQuery(
    tabFilter === "all" ? undefined : { status: tabFilter }
  );

  const deleteMut = trpc.quotations.delete.useMutation({
    onSuccess: () => { toast.success(t("deleted")); utils.quotations.list.invalidate(); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const generatePDF = trpc.quotations.generatePDF.useMutation({
    onSuccess: (data) => { window.open(data.url, "_blank"); },
    onError: (err) => { toast.error(serverErrorText(err)); },
  });

  const tabs: { key: TabFilter; label: string }[] = [
    { key: "all", label: t("all") },
    { key: "draft", label: t("draft") },
    { key: "sent", label: t("sent") },
    { key: "accepted", label: t("accepted") },
    { key: "rejected", label: t("rejected") },
    { key: "expired", label: t("expired") },
  ];

  type Row = (typeof rows)[number];

  const columns: Column<Row>[] = [
    {
      key: "quotationNumber",
      label: t("number"),
      render: (row) => row.quotation.quotationNumber,
      sortable: true,
    },
    {
      key: "customer",
      label: t("customer"),
      render: (row) => row.customer?.name || row.rental?.customerName || "—",
    },
    {
      key: "rental",
      label: t("rental"),
      render: (row) => row.rental?.rentalNumber || (row.quotation.rentalId ? `#${row.quotation.rentalId}` : "—"),
    },
    {
      key: "total",
      label: t("total"),
      render: (row) => formatCurrency(Number(row.quotation.totalAmount)),
    },
    {
      key: "status",
      label: t("status"),
      render: (row) => (
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[row.quotation.status] || ""}`}>
          {translateDynamic(t, `status_${row.quotation.status}`)}
        </span>
      ),
    },
    {
      key: "issueDate",
      label: t("issueDate"),
      render: (row) => row.quotation.issueDate ? fmtDate(row.quotation.issueDate) : "—",
    },
    {
      key: "validUntil",
      label: t("validUntil"),
      render: (row) => row.quotation.validUntil ? fmtDate(row.quotation.validUntil) : "—",
      hideOnMobile: true,
    },
    {
      key: "actions",
      label: "",
      searchable: false,
      render: (row) => (
        <div className="flex gap-1">
          <button
            className="tap-target p-1.5 rounded hover:bg-slate-100"
            onClick={(e) => { e.stopPropagation(); setDetailId(row.quotation.id); }}
            title={t("viewDetails")}
          >
            <Eye className="w-4 h-4" />
          </button>
          <button
            className="tap-target p-1.5 rounded hover:bg-slate-100"
            onClick={(e) => { e.stopPropagation(); generatePDF.mutate({ id: row.quotation.id }); }}
            title={t("downloadPDF")}
          >
            <FileDown className="w-4 h-4" />
          </button>
          {can("invoices", "delete") && (
            <button
              className="tap-target p-1.5 rounded hover:bg-red-50 text-red-500"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(t("deleteConfirm"))) deleteMut.mutate({ id: row.quotation.id });
              }}
              title={t("delete")}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t("title")}</h1>
        </div>

        {/* Tab filters */}
        <div className="flex gap-2 border-b pb-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg transition ${
                tabFilter === tab.key ? "bg-[var(--primary)]/10 text-[var(--primary)] font-bold" : "text-slate-500 hover:bg-slate-100"
              }`}
              onClick={() => setTabFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <DataTable
          columns={columns}
          data={rows}
          isLoading={isLoading}
          onRowClick={(row) => setDetailId(row.quotation.id)}
          rowKey={(row) => row.quotation.id}
        />

        {/* Detail Dialog */}
        {detailId && (
          <QuotationDetailDialog
            id={detailId}
            onClose={() => setDetailId(null)}
            onDownloadPDF={() => generatePDF.mutate({ id: detailId })}
          />
        )}
      </div>
    </DashboardLayout>
  );
}

function QuotationDetailDialog({
  id,
  onClose,
  onDownloadPDF,
}: {
  id: number;
  onClose: () => void;
  onDownloadPDF: () => void;
}) {
  const { t } = useTranslation("quotation");
  const fmtDate = useFormatCalendarDate();
  useEscapeKey(true, onClose);

  const { data, isLoading } = trpc.quotations.getById.useQuery({ id });
  const utils = trpc.useUtils();
  const updateStatus = trpc.quotations.updateStatus.useMutation({
    onSuccess: () => {
      toast.success(t("statusUpdated"));
      utils.quotations.list.invalidate();
      utils.quotations.getById.invalidate({ id });
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const acceptQuotation = trpc.quotations.acceptQuotation.useMutation({
    onSuccess: (res) => {
      toast.success(t("acceptedConverted", "Quotation accepted — order locked"));
      if (res.transition && res.transition.failures.length > 0) {
        toast.warning(t("convertGaps", { kinds: res.transition.failures.map((f) => f.kind).join(", "), defaultValue: "Order approved but some objects are missing: {{kinds}}" }));
      }
      utils.quotations.list.invalidate();
      utils.quotations.getById.invalidate({ id });
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center">
        <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-8">{t("loading")}</div>
      </div>
    );
  }

  if (!data) return null;

  const { quotation, customer, rental, lineItems } = data;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-bold">{t("detail", { number: quotation.quotationNumber })}</h2>
          <div className="flex items-center gap-2">
            <button onClick={onDownloadPDF} className="p-2 rounded hover:bg-slate-100" title={t("downloadPDF")}>
              <FileDown className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 rounded hover:bg-slate-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* Status + Meta */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-slate-500">{t("status")}:</span>{" "}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[quotation.status] || ""}`}>
                {translateDynamic(t, `status_${quotation.status}`)}
              </span>
            </div>
            <div>
              <span className="text-slate-500">{t("rental")}:</span>{" "}
              {rental?.rentalNumber || (quotation.rentalId ? `#${quotation.rentalId}` : "—")}
            </div>
            <div>
              <span className="text-slate-500">{t("issueDate")}:</span>{" "}
              {quotation.issueDate ? fmtDate(quotation.issueDate) : "—"}
            </div>
            <div>
              <span className="text-slate-500">{t("validUntil")}:</span>{" "}
              {quotation.validUntil ? fmtDate(quotation.validUntil) : "—"}
            </div>
          </div>

          {/* Customer */}
          {customer && (
            <div className="text-sm">
              <h3 className="font-semibold mb-1">{t("customer")}</h3>
              <p>{customer.name}</p>
              {customer.company && <p className="text-slate-500">{customer.company}</p>}
              {customer.email && <p className="text-slate-500">{customer.email}</p>}
            </div>
          )}

          {/* Line Items */}
          <div>
            <h3 className="font-semibold text-sm mb-2">{t("lineItems")}</h3>
            {/* Mobile: stacked rows */}
            <div className="md:hidden divide-y divide-slate-100 border-b">
              {lineItems.map((item) => (
                <div key={item.id} className="py-2 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-900">{item.description}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{parseFloat(item.quantity)} × {formatCurrency(Number(item.unitPrice))}</div>
                  </div>
                  <div className="text-sm tabular-nums text-slate-900 shrink-0">{formatCurrency(Number(item.amount))}</div>
                </div>
              ))}
            </div>
            {/* Desktop: full 4-col table */}
            <table className="hidden md:table w-full text-sm">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="py-1">{t("description")}</th>
                  <th className="py-1 text-center">{t("qty")}</th>
                  <th className="py-1 text-right">{t("unitPrice")}</th>
                  <th className="py-1 text-right">{t("amount")}</th>
                </tr>
              </thead>
              <tbody>
                {lineItems.map((item) => (
                  <tr key={item.id} className="border-b">
                    <td className="py-1">{item.description}</td>
                    <td className="py-1 text-center">{parseFloat(item.quantity)}</td>
                    <td className="py-1 text-right">{formatCurrency(Number(item.unitPrice))}</td>
                    <td className="py-1 text-right">{formatCurrency(Number(item.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="text-sm space-y-1 text-right">
            <div>{t("subtotal")}: {formatCurrency(Number(quotation.subtotal))}</div>
            {Number(quotation.taxAmount) > 0 && (
              <div>{t("tax")}: {formatCurrency(Number(quotation.taxAmount))}</div>
            )}
            <div className="font-bold text-base">{t("total")}: {formatCurrency(Number(quotation.totalAmount))}</div>
          </div>

          {/* Status Actions */}
          <div className="flex gap-2 pt-2 border-t">
            {quotation.status === "draft" && (
              <button
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                onClick={() => updateStatus.mutate({ id: quotation.id, status: "sent" })}
              >
                {t("markSent")}
              </button>
            )}
            {(quotation.status === "draft" || quotation.status === "sent") && (
              <>
                <button
                  className="px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:bg-slate-300"
                  disabled={acceptQuotation.isPending}
                  onClick={() => acceptQuotation.mutate({ id: quotation.id })}
                >
                  {t("acceptConvert", "Accept & create order")}
                </button>
                <button
                  className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                  onClick={() => updateStatus.mutate({ id: quotation.id, status: "rejected" })}
                >
                  {t("markRejected")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
