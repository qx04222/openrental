import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import PortalLayout from "./PortalLayout";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { Package, Calendar, MapPin, X, Clock, FileText, PenLine, CreditCard } from "lucide-react";
import { useLocation } from "wouter";
import { ONLINE_PAYMENTS_ENABLED } from "@/lib/paymentsConfig";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";

type StatusFilter = "all" | "active" | "completed" | "pending";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-blue-100 text-blue-700",
  rejected: "bg-red-100 text-red-700",
  active: "bg-green-100 text-green-700",
  completed: "bg-slate-100 text-slate-600",
  cancelled: "bg-slate-100 text-slate-500",
  overdue: "bg-orange-100 text-orange-700",
};

export default function PortalOrders() {
  const { t } = useTranslation("portal");
  const [, setLocation] = useLocation();
  const fmtDate = useFormatCalendarDate();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [selectedRentalId, setSelectedRentalId] = useState<number | null>(null);
  const [requestedEndDate, setRequestedEndDate] = useState("");
  const [reason, setReason] = useState("");

  const closeModal = useCallback(() => setExtensionOpen(false), []);
  useEscapeKey(extensionOpen, closeModal);

  const statusParam = filter === "all" ? undefined : filter;
  const { data: orders, isLoading } = trpc.customerPortal.orders.useQuery(
    statusParam ? { status: statusParam } : undefined
  );
  const utils = trpc.useUtils();

  const startCheckout = trpc.payments.startRentalCheckout.useMutation({
    onSuccess: (res) => {
      if (res.live && res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
      } else {
        toast.info(t("orders.payNotEnabled"));
      }
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const extensionMut = trpc.customerPortal.requestExtension.useMutation({
    onSuccess: () => {
      toast.success(t("orders.extensionDialog.success"));
      setExtensionOpen(false);
      setRequestedEndDate("");
      setReason("");
      utils.customerPortal.orders.invalidate();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const handleRequestExtension = (rentalId: number) => {
    setSelectedRentalId(rentalId);
    setRequestedEndDate("");
    setReason("");
    setExtensionOpen(true);
  };

  const handleSubmitExtension = () => {
    if (!selectedRentalId || !requestedEndDate || !reason.trim()) return;
    extensionMut.mutate({
      rentalRequestId: selectedRentalId,
      requestedEndDate,
      reason: reason.trim(),
    });
  };

  const filters: { key: StatusFilter; label: string }[] = [
    { key: "all", label: t("orders.filterAll") },
    { key: "active", label: t("orders.filterActive") },
    { key: "pending", label: t("orders.filterPending") },
    { key: "completed", label: t("orders.filterCompleted") },
  ];

  return (
    <PortalLayout>
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-slate-900">{t("orders.title")}</h1>

        {/* Filters */}
        <div className="flex gap-2 flex-wrap">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
                filter === f.key
                  ? "bg-[var(--primary)] text-white"
                  : "bg-[var(--surface-container-lowest)] border border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Orders List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="spinner" />
          </div>
        ) : !orders || orders.length === 0 ? (
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-12 text-center">
            <Package className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500">{t("orders.noOrders")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {orders.map((order: Record<string, unknown>) => {
              const id = order.id as number;
              const status = (order.status as string) || "pending";
              // The `orders` procedure returns raw rental_requests rows, so the
              // real columns are equipmentDescription / totalAmount / start|endDate
              // (Date objects via superjson) — not equipmentName / totalCost.
              const equipmentName = (order.equipmentDescription as string) || "-";
              const startDate = order.startDate ? fmtDate(order.startDate as string | Date) : "";
              const endDate = order.endDate ? fmtDate(order.endDate as string | Date) : "";
              const deliveryAddress = (order.deliveryAddress as string) || "";
              const totalCost = Number(order.totalAmount ?? 0) || 0;
              const isActive = status === "active" || status === "approved";
              const contractUrl = (order.contractUrl as string | null) || null;
              const contractSignedAt = (order.contractSignedAt as string | null) || null;
              const canSign = status === "approved" && !contractSignedAt;
              const paymentStatus = (order.paymentStatus as string | undefined) || "pending";
              const hasBalance = ["approved", "active"].includes(status) && paymentStatus !== "paid" && totalCost > 0;
              // Only show a clickable Pay Now when online payment is actually wired
              // (Stripe). Until then, never render a button that just no-ops — show a
              // "contact the office" note instead. Single source of truth: paymentsConfig.
              const canPay = ONLINE_PAYMENTS_ENABLED && hasBalance;

              return (
                <div key={id} className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-2 flex-1">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setLocation(`/portal/orders/${id}`)}
                          className="font-semibold text-slate-900 hover:text-[var(--primary)] hover:underline"
                        >
                          {(order.rentalNumber as string) || `${t("orders.rentalId")}${id}`}
                        </button>
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-slate-100 text-slate-600"}`}>
                          {t(`orders.status_${status}`, status)}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-4 text-sm text-slate-500">
                        <span className="flex items-center gap-1">
                          <Package size={14} />
                          {equipmentName}
                        </span>
                        {startDate && (
                          <span className="flex items-center gap-1">
                            <Calendar size={14} />
                            {startDate} - {endDate || "..."}
                          </span>
                        )}
                        {deliveryAddress && (
                          <span className="flex items-center gap-1">
                            <MapPin size={14} />
                            {deliveryAddress}
                          </span>
                        )}
                      </div>
                      {totalCost > 0 && (
                        <p className="text-sm font-medium text-slate-900">
                          {t("orders.totalCost")}: {formatCurrency(totalCost)}
                        </p>
                      )}
                      {/* Online payment not yet available — direct the customer to the office. */}
                      {!ONLINE_PAYMENTS_ENABLED && hasBalance && (
                        <p className="text-xs text-slate-500">
                          {t("orders.payContactOffice", "To pay, please contact our office.")}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                      {canPay && (
                        <button
                          onClick={() => startCheckout.mutate({ rentalRequestId: id })}
                          disabled={startCheckout.isPending}
                          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 rounded-lg transition whitespace-nowrap"
                        >
                          <CreditCard size={16} />
                          {t("orders.payNow")}
                        </button>
                      )}
                      {canSign && (
                        <button
                          onClick={() => setLocation(`/portal/sign/${id}`)}
                          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] rounded-lg transition whitespace-nowrap"
                        >
                          <PenLine size={16} />
                          {t("orders.signContract")}
                        </button>
                      )}
                      {contractUrl && (
                        <a
                          href={contractUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg transition whitespace-nowrap"
                        >
                          <FileText size={16} />
                          {t("orders.viewContract")}
                        </a>
                      )}
                      {isActive && (
                        <button
                          onClick={() => handleRequestExtension(id)}
                          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-[var(--primary)] border border-[#2563EB]/30 rounded-lg hover:bg-[var(--primary)]/5 transition whitespace-nowrap"
                        >
                          <Clock size={16} />
                          {t("orders.requestExtension")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Extension Request Dialog */}
      {extensionOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setExtensionOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("orders.extensionDialog.title")}</h2>
              <button onClick={() => setExtensionOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close">
                <X size={20} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t("orders.extensionDialog.newEndDate")}
                </label>
                <input
                  type="date"
                  value={requestedEndDate}
                  onChange={(e) => setRequestedEndDate(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)] outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t("orders.extensionDialog.reason")}
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t("orders.extensionDialog.reasonPlaceholder")}
                  rows={3}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)] outline-none resize-none"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setExtensionOpen(false)} className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition">
                {t("orders.extensionDialog.cancel")}
              </button>
              <button
                onClick={handleSubmitExtension}
                disabled={!requestedEndDate || !reason.trim() || extensionMut.isPending}
                className="px-4 py-2 text-sm font-medium text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] disabled:bg-slate-300 disabled:cursor-not-allowed rounded-lg transition"
              >
                {extensionMut.isPending ? t("orders.extensionDialog.submitting") : t("orders.extensionDialog.submit")}
              </button>
            </div>
          </div>
        </div>
      )}
    </PortalLayout>
  );
}
