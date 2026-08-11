import { useState } from "react";
import { CalendarClock, CheckCircle2, Clock3, ShieldAlert, Truck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { formatCurrency } from "@/lib/pricing";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { isHistoricalCutoffWithinBounds } from "@shared/rollingRental";
import { serverErrorText } from "@/lib/serverError";

function localDateTimeValue(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function RollingRentalOperations({
  rentalId,
  status,
  endDate,
  isCreditOrder,
}: {
  rentalId: number;
  status: string;
  endDate: Date | string;
  isCreditOrder: boolean;
}) {
  const { t } = useTranslation("rental");
  const enabled = useFeatureFlag("rolling_renewal_operations");
  const visible = enabled && !isCreditOrder && ["active", "overdue"].includes(status);
  const utils = trpc.useUtils();
  const [readyOpen, setReadyOpen] = useState(false);
  const [customerReadyAt, setCustomerReadyAt] = useState(() => localDateTimeValue());
  const [scheduledPickupAt, setScheduledPickupAt] = useState("");
  const [responsibility, setResponsibility] = useState<"company" | "customer">("company");
  const [responsibilityReason, setResponsibilityReason] = useState("");
  const [previewAt, setPreviewAt] = useState<Date | null>(null);
  // Catch-up cutoff for a historical (overdue → rolling) settlement. Defaults to
  // now but is editable: staff must be able to bill only through the date the
  // customer actually returned the unit, not "today" when they happen to click.
  const [historicalCutoff, setHistoricalCutoff] = useState(() => localDateTimeValue());

  const summary = trpc.rollingRentals.summary.useQuery(
    { rentalId },
    { enabled: visible, refetchOnWindowFocus: true },
  );
  const preview = trpc.rollingRentals.classificationPreview.useQuery(
    { rentalId, confirmedAt: previewAt ?? undefined },
    { enabled: visible && Boolean(previewAt), retry: false },
  );

  const refresh = async () => {
    await Promise.all([
      utils.rollingRentals.summary.invalidate({ rentalId }),
      utils.rentalAssetProgress.byRental.invalidate({ rentalId }),
      utils.rentals.getById.invalidate({ id: rentalId }),
      utils.rentals.list.invalidate(),
      utils.dashboard.stats.invalidate(),
      utils.invoices.list.invalidate({ rentalId }),
    ]);
  };

  const start = trpc.rollingRentals.start.useMutation({
    onSuccess: async () => { await refresh(); toast.success(t("rolling.started")); },
    onError: (error) => toast.error(serverErrorText(error)),
  });
  const markReady = trpc.rollingRentals.customerReady.useMutation({
    onSuccess: async () => {
      await refresh();
      setReadyOpen(false);
      toast.success(t("rolling.readyRecorded"));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });
  const changeResponsibility = trpc.rollingRentals.setResponsibility.useMutation({
    onSuccess: async () => {
      await refresh();
      setResponsibilityReason("");
      toast.success(t("rolling.responsibilityRecorded"));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });
  const confirmClassification = trpc.rollingRentals.classificationConfirm.useMutation({
    onSuccess: async () => {
      await refresh();
      setPreviewAt(null);
      toast.success(t("rolling.classified"));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });

  if (!visible) return null;

  const term = summary.data?.term;
  const operations = summary.data?.operations ?? [];
  const pickedUpCount = operations.filter((operation) => operation.pickedUpAt).length;
  const historical = status === "overdue" || new Date(endDate).getTime() < Date.now();
  const historicalEnd = new Date(endDate);
  const historicalCutoffDate = new Date(historicalCutoff);
  const historicalCutoffValid = !Number.isNaN(historicalCutoffDate.getTime())
    && isHistoricalCutoffWithinBounds(historicalEnd, historicalCutoffDate);
  const historicalMin = localDateTimeValue(new Date(historicalEnd.getTime() + 60_000));
  const termStatusLabel = term?.status === "active"
    ? t("rolling.status.active")
    : term?.status === "ending"
      ? t("rolling.status.ending")
      : t("rolling.status.ended");

  return (
    <section className="overflow-hidden rounded-2xl border border-blue-200 bg-[linear-gradient(135deg,rgba(239,246,255,0.96),rgba(255,255,255,0.96))] shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-blue-100 px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.16em] text-blue-700"><CalendarClock size={14} />{t("rolling.title")}</div>
          <p className="mt-1 text-xs text-slate-500">{t("rolling.hint")}</p>
        </div>
        {term && <span className="rounded-full border border-blue-200 bg-white px-2.5 py-1 text-[11px] font-bold text-blue-800">{termStatusLabel}</span>}
      </div>

      {!term && (
        <div className="p-4">
          {historical ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                <span>{t("rolling.historicalWarning")}</span>
              </div>
              <label className="block text-xs font-semibold text-slate-600">{t("rolling.historicalCutoffLabel")}
                <input
                  type="datetime-local"
                  value={historicalCutoff}
                  min={historicalMin}
                  max={localDateTimeValue()}
                  onChange={(event) => { setHistoricalCutoff(event.target.value); setPreviewAt(null); }}
                  className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 font-normal sm:w-72"
                />
              </label>
              {!historicalCutoffValid && <p className="text-xs font-medium text-red-700">{t("rolling.historicalCutoffInvalid")}</p>}
              {!previewAt && <button onClick={() => historicalCutoffValid && setPreviewAt(historicalCutoffDate)} disabled={!historicalCutoffValid} className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-50">{t("rolling.previewHistorical")}</button>}
              {preview.isFetching && <p className="text-xs text-slate-500">{t("rolling.calculating")}</p>}
              {preview.error && <p className="text-xs font-medium text-red-700">{preview.error.message}</p>}
              {preview.data && previewAt && (
                <div className="rounded-xl border border-amber-200 bg-white p-3">
                  <div className="flex items-end justify-between gap-3">
                    <div><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{t("rolling.catchupAmount")}</p><p className="text-2xl font-black text-slate-950">{formatCurrency(preview.data.totalAmount)}</p></div>
                    <button onClick={() => confirmClassification.mutate({ rentalId, confirmedAt: previewAt, previewHash: preview.data.previewHash })} disabled={confirmClassification.isPending} className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t("rolling.confirmHistorical")}</button>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500">{t("rolling.previewBreakdown", { rental: formatCurrency(preview.data.rentalFee), insurance: formatCurrency(preview.data.insuranceCost), tax: formatCurrency(preview.data.taxAmount) })}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-xs text-slate-600">{t("rolling.startHint")}</p>
              <button onClick={() => start.mutate({ rentalId, confirmedAt: new Date() })} disabled={start.isPending} className="shrink-0 rounded-lg bg-blue-700 px-4 py-2 text-xs font-bold text-white hover:bg-blue-800 disabled:opacity-50">{t("rolling.start")}</button>
            </div>
          )}
        </div>
      )}

      {term && (
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <div className="rounded-xl border border-blue-100 bg-white p-2.5"><p className="text-[10px] font-bold uppercase text-slate-400">{t("rolling.originalEnd")}</p><p className="mt-1 text-xs font-bold text-slate-800">{new Date(endDate).toLocaleDateString()}</p><p className="mt-0.5 text-[10px] font-semibold text-blue-700">{t("rolling.returnUnknown")}</p></div>
            <div className="rounded-xl border border-blue-100 bg-white p-2.5"><p className="text-[10px] font-bold uppercase text-slate-400">{t("rolling.billedThrough")}</p><p className="mt-1 text-xs font-bold text-slate-800">{new Date(term.billedThroughDate).toLocaleDateString()}</p></div>
            <div className="rounded-xl border border-blue-100 bg-white p-2.5"><p className="text-[10px] font-bold uppercase text-slate-400">{t("rolling.nextSettlement")}</p><p className="mt-1 text-xs font-bold text-slate-800">{new Date(term.nextSettlementDate).toLocaleDateString()}</p></div>
            <div className="rounded-xl border border-blue-100 bg-white p-2.5"><p className="text-[10px] font-bold uppercase text-slate-400">{t("rolling.unitsPickedUp")}</p><p className="mt-1 text-xs font-bold text-slate-800">{pickedUpCount}/{operations.length || "—"}</p></div>
            <div className="rounded-xl border border-blue-100 bg-white p-2.5"><p className="text-[10px] font-bold uppercase text-slate-400">{t("rolling.billingCutoff")}</p><p className="mt-1 text-xs font-bold text-slate-800">{term.billingStopAt ? new Date(term.billingStopAt).toLocaleString() : t("rolling.continues")}</p></div>
          </div>

          {term.status === "active" && !readyOpen && (
            <button onClick={() => setReadyOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-2 text-xs font-bold text-white hover:bg-blue-800"><Truck size={14} />{t("rolling.customerReady")}</button>
          )}
          {term.status === "active" && readyOpen && (
            <div className="rounded-xl border border-blue-200 bg-white p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-600">{t("rolling.customerReadyAt")}<input type="datetime-local" value={customerReadyAt} onChange={(event) => setCustomerReadyAt(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 font-normal" /></label>
                <label className="text-xs font-semibold text-slate-600">{t("rolling.scheduledPickupAt")}<input type="datetime-local" value={scheduledPickupAt} onChange={(event) => setScheduledPickupAt(event.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 font-normal" /></label>
              </div>
              <p className="mt-2 text-[11px] text-blue-700">{t("rolling.companyDefault")}</p>
              <div className="mt-3 flex justify-end gap-2"><button onClick={() => setReadyOpen(false)} className="rounded-lg px-3 py-2 text-xs font-semibold text-slate-500">{t("management.cancel")}</button><button onClick={() => markReady.mutate({ rentalId, customerReadyAt: new Date(customerReadyAt), scheduledPickupAt: scheduledPickupAt ? new Date(scheduledPickupAt) : null })} disabled={!customerReadyAt || markReady.isPending} className="rounded-lg bg-blue-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t("rolling.confirmReady")}</button></div>
            </div>
          )}

          {term.status === "ending" && operations.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-800"><Clock3 size={14} />{t("rolling.delayResponsibility")}</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[150px_1fr_auto]">
                <select value={responsibility} onChange={(event) => setResponsibility(event.target.value as "company" | "customer")} className="rounded-lg border border-slate-200 px-3 py-2 text-xs"><option value="company">{t("rolling.company")}</option><option value="customer">{t("rolling.customer")}</option></select>
                <input value={responsibilityReason} onChange={(event) => setResponsibilityReason(event.target.value)} maxLength={500} placeholder={t("rolling.reason")} className="rounded-lg border border-slate-200 px-3 py-2 text-xs" />
                <button onClick={() => changeResponsibility.mutate({ rentalId, responsibility, reason: responsibilityReason.trim() })} disabled={responsibilityReason.trim().length < 5 || changeResponsibility.isPending} className="inline-flex items-center justify-center gap-1 rounded-lg bg-slate-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"><CheckCircle2 size={13} />{t("rolling.saveResponsibility")}</button>
              </div>
              <p className="mt-2 text-[11px] text-slate-500">{responsibility === "company" ? t("rolling.companyBillingRule") : t("rolling.customerBillingRule")}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
