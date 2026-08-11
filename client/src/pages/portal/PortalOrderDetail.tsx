import { useRoute, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import PortalLayout from "./PortalLayout";
import { toast } from "sonner";
import { ArrowLeft, FileText, PenLine, CreditCard, Box, Wrench, CheckCircle2, Circle } from "lucide-react";
import { formatCurrency } from "@/lib/pricing";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { ONLINE_PAYMENTS_ENABLED } from "@/lib/paymentsConfig";
import { serverErrorText } from "@/lib/serverError";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-blue-100 text-blue-700",
  rejected: "bg-red-100 text-red-700",
  active: "bg-green-100 text-green-700",
  completed: "bg-slate-100 text-slate-600",
  cancelled: "bg-slate-100 text-slate-500",
  overdue: "bg-orange-100 text-orange-700",
};

// The fixed order milestones we visualize. Each is "done" if at least one
// timeline event matches its predicate.
const MILESTONES = [
  { key: "submitted", label: "submitted", match: (_status: string) => true },
  { key: "approved", label: "approved", match: (status: string) => ["approved", "active", "completed"].includes(status) },
  { key: "signed", label: "signed", match: (_status: string, signedAt: string | null) => !!signedAt },
  { key: "delivered", label: "delivered", match: (status: string) => ["active", "completed"].includes(status) },
  { key: "completed", label: "completed", match: (status: string) => status === "completed" },
] as const;

export default function PortalOrderDetail() {
  const { t } = useTranslation(["portal", "rental"]);
  const fmtDate = useFormatCalendarDate();
  const [, params] = useRoute("/portal/orders/:id");
  const [, setLocation] = useLocation();
  const orderId = params?.id ? Number(params.id) : 0;

  const { data: order, isLoading } = trpc.customerPortal.orderDetail.useQuery(
    { id: orderId },
    { enabled: orderId > 0 },
  );

  const startCheckout = trpc.payments.startRentalCheckout.useMutation({
    onSuccess: (res) => {
      if (res.live && res.checkoutUrl) window.location.href = res.checkoutUrl;
      else toast.info(t("orders.payNotEnabled"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const startInvoiceCheckout = trpc.payments.startInvoiceCheckout.useMutation({
    onSuccess: (res) => {
      if (res.live && res.checkoutUrl) window.location.href = res.checkoutUrl;
      else toast.info(t("orders.payNotEnabled"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  if (isLoading) {
    return <PortalLayout><div className="flex items-center justify-center py-12"><div className="spinner" /></div></PortalLayout>;
  }

  if (!order) {
    return (
      <PortalLayout>
        <div className="text-center py-12">
          <p className="text-slate-500 mb-4">{t("orderDetail.notFound")}</p>
          <button onClick={() => setLocation("/portal/orders")} className="btn-primary">{t("orderDetail.back")}</button>
        </div>
      </PortalLayout>
    );
  }

  const status = order.status as string;
  const totalCost = parseFloat(order.totalAmount || "0");
  const canSign = status === "approved" && !order.contractSignedAt;
  const paymentStatus = (order as { paymentStatus?: string }).paymentStatus || "pending";
  const hasBalance = ["approved", "active"].includes(status) && paymentStatus !== "paid" && totalCost > 0;
  const canPay = ONLINE_PAYMENTS_ENABLED && hasBalance;
  const items = (order.items || []) as Array<{ line: { id: number; itemType: string; quantity: number; lineSubtotal: string | null }; fleetBrand: string | null; fleetModel: string | null; fleetCategory: string | null; modelBrand: string | null; modelModel: string | null; modelCategory: string | null }>;
  const invoices = (order.invoices || []) as Array<{ id: number; invoiceNumber: string | null; status: string; totalAmount: string; balanceDue: string; pdfUrl: string | null; issueDate: Date | null; dueDate: Date | null }>;

  return (
    <PortalLayout>
      <div className="max-w-3xl mx-auto space-y-5">
        <button onClick={() => setLocation("/portal/orders")} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
          <ArrowLeft size={14} /> {t("orderDetail.back")}
        </button>

        {/* Header */}
        <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h1 className="text-xl font-bold text-slate-900">{order.rentalNumber || `#${order.id}`}</h1>
              <p className="text-xs text-slate-500 mt-1">
                {fmtDate(order.startDate)} — {fmtDate(order.endDate)}
              </p>
            </div>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-slate-100"}`}>
              {t(`orders.status_${status}`, status)}
            </span>
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
            {canPay && (
              <button
                onClick={() => startCheckout.mutate({ rentalRequestId: order.id })}
                disabled={startCheckout.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 rounded-lg"
              >
                <CreditCard size={14} /> {t("orders.payNow")}
              </button>
            )}
            {canSign && (
              <button
                onClick={() => setLocation(`/portal/sign/${order.id}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] rounded-lg"
              >
                <PenLine size={14} /> {t("orders.signContract")}
              </button>
            )}
            {order.contractUrl && (
              <a
                href={order.contractUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-lg"
              >
                <FileText size={14} /> {t("orders.viewContract")}
              </a>
            )}
          </div>
          {/* Online payment not yet available — direct the customer to the office. */}
          {!ONLINE_PAYMENTS_ENABLED && hasBalance && (
            <p className="text-xs text-slate-500 mt-3">
              {t("orders.payContactOffice", "To pay, please contact our office.")}
            </p>
          )}
        </div>

        {/* Timeline */}
        <section className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">{t("orderDetail.timeline")}</h2>
          <ol className="space-y-3">
            {MILESTONES.map((m) => {
              const done = m.match(status, order.contractSignedAt as string | null);
              return (
                <li key={m.key} className="flex items-center gap-3 text-sm">
                  {done ? (
                    <CheckCircle2 size={18} className="text-green-600 shrink-0" />
                  ) : (
                    <Circle size={18} className="text-slate-300 shrink-0" />
                  )}
                  <span className={done ? "text-slate-900" : "text-slate-400"}>
                    {t(`orderDetail.milestone_${m.key}`)}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        {/* Line items */}
        <section className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">
            {t("orderDetail.items", { count: items.length })}
          </h2>
          {items.length === 0 ? (
            <p className="text-sm text-slate-400">{t("orderDetail.itemsEmpty")}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((row) => {
                const isAttach = row.line.itemType === "attachment";
                const brand = row.fleetBrand || row.modelBrand || "-";
                const model = row.fleetModel || row.modelModel || "";
                const category = row.fleetCategory || row.modelCategory || "";
                return (
                  <li key={row.line.id} className="py-3 flex items-baseline gap-2">
                    {isAttach ? <Wrench size={14} className="text-amber-600 shrink-0" /> : <Box size={14} className="text-slate-400 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{brand} {model}</div>
                      <div className="text-xs text-slate-500 truncate">{category}</div>
                    </div>
                    {row.line.quantity > 1 && <span className="text-xs text-slate-500">× {row.line.quantity}</span>}
                    {row.line.lineSubtotal && (
                      <span className="text-sm text-slate-700">{formatCurrency(parseFloat(row.line.lineSubtotal))}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Pricing */}
        <section className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5 space-y-1.5 text-sm">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">{t("orderDetail.pricing")}</h2>
          <div className="flex justify-between text-slate-600"><span>{t("orderDetail.rentalFee")}</span><span>{formatCurrency(parseFloat(order.rentalFee || "0"))}</span></div>
          <div className="flex justify-between text-slate-600"><span>{t("orderDetail.freight")}</span><span>{formatCurrency(parseFloat(order.freightCost || "0"))}</span></div>
          {parseFloat(order.insuranceCost || "0") > 0 && (
            <div className="flex justify-between text-slate-600"><span>{t("orderDetail.insurance")}</span><span>{formatCurrency(parseFloat(order.insuranceCost || "0"))}</span></div>
          )}
          <div className="flex justify-between text-slate-600"><span>{order.taxBreakdown || t("orderDetail.tax")}</span><span>{formatCurrency(parseFloat(order.taxAmount || "0"))}</span></div>
          <div className="border-t border-slate-200 pt-2 mt-2 flex justify-between font-bold text-slate-900">
            <span>{t("orderDetail.total")}</span><span>{formatCurrency(totalCost)}</span>
          </div>
          {parseFloat(order.depositAmount || "0") > 0 && (
            <div className="flex justify-between text-xs text-slate-500 pt-1"><span>{t("orderDetail.deposit")}</span><span>{formatCurrency(parseFloat(order.depositAmount || "0"))}</span></div>
          )}
        </section>

        {/* Invoices */}
        {invoices.length > 0 && (
          <section className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">{t("orderDetail.invoices")}</h2>
            <ul className="divide-y divide-slate-100">
              {invoices.map((inv) => {
                const owing = parseFloat(inv.balanceDue || "0");
                return (
                  <li key={inv.id} className="py-3 flex items-center gap-3">
                    <FileText size={16} className="text-slate-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{inv.invoiceNumber || `#${inv.id}`}</div>
                      <div className="text-xs text-slate-500">
                        {t(`orderDetail.invoiceStatus_${inv.status}`, inv.status)} · {formatCurrency(parseFloat(inv.totalAmount))}
                        {owing > 0 && ` · ${t("orderDetail.invoiceOwing", { amt: formatCurrency(owing) })}`}
                      </div>
                    </div>
                    {owing > 0 && ONLINE_PAYMENTS_ENABLED && (
                      <button
                        onClick={() => startInvoiceCheckout.mutate({ invoiceId: inv.id })}
                        disabled={startInvoiceCheckout.isPending}
                        className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white rounded-lg"
                      >
                        {t("orders.payNow")}
                      </button>
                    )}
                    {inv.pdfUrl && (
                      <a href={inv.pdfUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-slate-500 hover:text-slate-900">PDF</a>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </PortalLayout>
  );
}
