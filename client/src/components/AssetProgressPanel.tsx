import { useEffect, useState } from "react";
import { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@server/routers/app.router";
import { trpc } from "@/lib/trpc";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { CalendarClock, Check, ChevronDown, ChevronUp, ClipboardCheck, History, MapPin, Navigation, Phone, Play, ShieldAlert, Truck } from "lucide-react";
import {
  areFieldOperationsBlocked,
  canConfirmPhysicalPickup,
  inspectionEvidenceTone,
  rollingOperationalTone,
  shouldShowNextSettlement,
  stageProgressIndex,
  type InspectionEvidence,
} from "@/lib/assetProgressPresentation";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type AssetProgressItem = RouterOutputs["rentalAssetProgress"]["byRental"][number];

type Props = {
  items: AssetProgressItem[];
  loading?: boolean;
  isSuperAdmin?: boolean;
  showConflictRentalLinks?: boolean;
  onStartReturn?: (item: AssetProgressItem) => void;
  onConfirmPickup?: (item: AssetProgressItem) => void;
  onInspect?: (item: AssetProgressItem, type: "dispatch" | "return") => void;
  onAdvanceTransport?: (item: AssetProgressItem, dispatchId: number, status: "in_transit" | "delivered" | "completed", driverNotes?: string) => void;
  onBypass?: (item: AssetProgressItem, type: "dispatch" | "return", reason: string) => Promise<void>;
};

const stageKeys = {
  entry_pending: "assetProgress.stage.entryPending",
  entry_ready: "assetProgress.stage.entryReady",
  in_rental: "assetProgress.stage.inRental",
  return_pending: "assetProgress.stage.returnPending",
  return_ready: "assetProgress.stage.returnReady",
  completed: "assetProgress.stage.completed",
} as const;

const evidenceClasses = {
  verified: "bg-emerald-50 text-emerald-800 border-emerald-200",
  bypassed: "bg-amber-50 text-amber-900 border-amber-300",
  attention: "bg-red-50 text-red-800 border-red-200",
  neutral: "bg-slate-100 text-slate-600 border-slate-200",
};

function EvidenceChip({ label, value }: { label: string; value: InspectionEvidence }) {
  const { t } = useTranslation("common");
  const tone = inspectionEvidenceTone(value);
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${evidenceClasses[tone]}`}>
      <div className="text-[10px] font-bold uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-0.5 flex items-center gap-1 text-xs font-semibold">
        {value === "completed" && <Check size={13} />}
        {value === "bypassed" && <ShieldAlert size={13} />}
        {t(`assetProgress.evidence.${value}`)}
      </div>
    </div>
  );
}

function AssetProgressCard({ item, isSuperAdmin, showConflictRentalLinks, onStartReturn, onConfirmPickup, onInspect, onAdvanceTransport, onBypass }: Omit<Props, "items" | "loading"> & { item: AssetProgressItem }) {
  const { t } = useTranslation("common");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [bypassType, setBypassType] = useState<"dispatch" | "return" | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { data: timeline, isLoading: timelineLoading } = trpc.rentalAssetProgress.timeline.useQuery(
    { rentalId: item.rentalRequestId, rentalFleetId: item.rentalFleetId },
    { enabled: timelineOpen, refetchOnWindowFocus: true },
  );
  const progress = stageProgressIndex(item.stage);
  const fieldOperationsBlocked = areFieldOperationsBlocked(item);
  const canStartReturn = item.stage === "in_rental" && !item.rollingStatus;
  const canConfirmPickup = canConfirmPhysicalPickup({
    operationalState: item.operationalState,
    pickedUpAt: item.pickedUpAt,
  });
  const operationalTone = rollingOperationalTone(item.operationalState);
  const showNextSettlement = shouldShowNextSettlement(item);
  const operationalClasses = {
    neutral: "border-slate-200 bg-slate-50 text-slate-700",
    info: "border-blue-200 bg-blue-50 text-blue-800",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    danger: "border-red-200 bg-red-50 text-red-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  }[operationalTone];
  const inspectionType = item.stage.startsWith("entry_") ? "dispatch" : item.stage.startsWith("return_") ? "return" : null;
  const inspectionValue = inspectionType === "dispatch" ? item.entryInspection : item.returnInspection;
  const activeTransport = item.stage.startsWith("entry_")
    ? { id: item.deliveryDispatchId, status: item.deliveryTransport, details: item.deliveryDispatchDetails }
    : item.stage.startsWith("return_")
      ? { id: item.pickupDispatchId, status: item.pickupTransport, details: item.pickupDispatchDetails }
      : null;
  const nextTransportStatus = activeTransport?.status === "assigned" ? "in_transit"
    : activeTransport?.status === "in_transit" ? "delivered"
      : activeTransport?.status === "delivered" ? "completed"
        : null;
  const [driverNotes, setDriverNotes] = useState(activeTransport?.details?.driverNotes ?? "");

  useEffect(() => {
    setDriverNotes(activeTransport?.details?.driverNotes ?? "");
  }, [activeTransport?.id, activeTransport?.details?.driverNotes]);

  const submitBypass = async () => {
    if (!bypassType || reason.trim().length < 5 || !onBypass) return;
    setSubmitting(true);
    try {
      await onBypass(item, bypassType, reason.trim());
      setBypassType(null);
      setReason("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
      <div className="border-l-4 border-[var(--primary)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-[var(--primary)]">{item.serialNumber || `#${item.rentalFleetId}`}</span>
              <span className="text-xs text-slate-400">{item.rentalNumber || `#${item.rentalRequestId}`}</span>
            </div>
            <h3 className="mt-1 truncate text-base font-extrabold tracking-tight text-slate-950">{item.equipmentLabel}</h3>
            <p className="mt-0.5 truncate text-xs text-slate-500">{item.customerName}</p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-950 px-3 py-1 text-[11px] font-bold text-white">
            {t(stageKeys[item.stage])}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-6 gap-1" aria-label={t("assetProgress.lifecycle")}>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className={`h-1.5 rounded-full ${index <= progress ? "bg-[var(--primary)]" : "bg-slate-200"}`} />
          ))}
        </div>

        {item.occupancyConflict && (
          <div className="mt-4 rounded-xl border border-red-300 bg-red-50 p-3 text-red-900" role="alert">
            <div className="flex items-center gap-2 text-sm font-black">
              <ShieldAlert size={16} /> {t("assetProgress.occupancyConflict")}
            </div>
            <p className="mt-1 text-xs">{t("assetProgress.occupancyConflictHint")}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold">
              {item.conflictingRentals.map((rental) => showConflictRentalLinks ? (
                <Link
                  key={rental.rentalId}
                  href={`/admin/rental-management?rentalId=${rental.rentalId}`}
                  className="rounded bg-white px-2 py-1 text-red-800 underline decoration-red-300 underline-offset-2"
                >
                  {rental.rentalNumber || `#${rental.rentalId}`}
                </Link>
              ) : (
                <span key={rental.rentalId}>{rental.rentalNumber || `#${rental.rentalId}`}</span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <EvidenceChip label={t("assetProgress.entryInspection")} value={item.entryInspection} />
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-slate-700">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{t("assetProgress.deliveryTransport")}</div>
            <div className="mt-0.5 flex items-center gap-1 text-xs font-semibold"><Truck size={13} />{t(`assetProgress.transport.${item.deliveryTransport}`)}</div>
          </div>
          <EvidenceChip label={t("assetProgress.returnInspection")} value={item.returnInspection} />
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-slate-700">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{t("assetProgress.pickupTransport")}</div>
            <div className="mt-0.5 flex items-center gap-1 text-xs font-semibold"><Truck size={13} />{t(`assetProgress.transport.${item.pickupTransport}`)}</div>
          </div>
        </div>

        {item.rollingStatus && (
          <div className={`mt-4 rounded-xl border p-3 text-xs ${operationalClasses}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="font-black uppercase tracking-[0.12em]">{t(`assetProgress.operational.${item.operationalState}`)}</span>
              <span className="font-mono font-bold">28 {t("assetProgress.days")}</span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
              {item.rollingBilledThroughDate && <span><strong>{t("assetProgress.billedThrough")}:</strong> {new Date(item.rollingBilledThroughDate).toLocaleDateString()}</span>}
              {showNextSettlement && item.nextSettlementDate && <span><strong>{t("assetProgress.nextSettlement")}:</strong> {new Date(item.nextSettlementDate).toLocaleDateString()}</span>}
              {item.customerReadyAt && <span><strong>{t("assetProgress.customerReady")}:</strong> {new Date(item.customerReadyAt).toLocaleString()}</span>}
              {item.scheduledPickupAt && <span><strong>{t("assetProgress.pickupScheduled")}:</strong> {new Date(item.scheduledPickupAt).toLocaleString()}</span>}
              {item.delayResponsibility !== "none" && <span><strong>{t("assetProgress.delayResponsibility")}:</strong> {t(`assetProgress.responsibility.${item.delayResponsibility}`)}</span>}
              {item.billingStopAt && <span><strong>{t("assetProgress.billingStopped")}:</strong> {new Date(item.billingStopAt).toLocaleString()}</span>}
              {item.pickedUpAt && <span><strong>{t("assetProgress.physicalPickup")}:</strong> {new Date(item.pickedUpAt).toLocaleString()}</span>}
            </div>
          </div>
        )}

        {activeTransport?.id && activeTransport.details && (
          <div className="mt-4 space-y-2 rounded-xl border border-blue-200 bg-blue-50/70 p-3 text-xs text-slate-700">
            {activeTransport.details.scheduledDate && (
              <div className="flex items-start gap-2"><CalendarClock size={14} className="mt-0.5 shrink-0 text-blue-700" /><span><strong>{t("assetProgress.scheduled")}:</strong> {new Date(activeTransport.details.scheduledDate).toLocaleString()}</span></div>
            )}
            {activeTransport.details.pickupAddress && (
              <div className="flex items-start gap-2"><MapPin size={14} className="mt-0.5 shrink-0 text-blue-700" /><span><strong>{t("assetProgress.pickupFrom")}:</strong> {activeTransport.details.pickupAddress}</span></div>
            )}
            {activeTransport.details.deliveryAddress && (
              <div className="flex items-start gap-2"><MapPin size={14} className="mt-0.5 shrink-0 text-[var(--primary)]" /><span><strong>{t("assetProgress.deliveryTo")}:</strong> {activeTransport.details.deliveryAddress}</span></div>
            )}
            {activeTransport.details.distance && (
              <div className="flex items-center gap-2"><Navigation size={14} className="shrink-0 text-slate-500" /><span><strong>{t("assetProgress.distance")}:</strong> {activeTransport.details.distance} km</span></div>
            )}
            {item.customerPhone && (
              <a href={`tel:${item.customerPhone}`} className="flex items-center gap-2 font-semibold text-blue-800 hover:underline"><Phone size={14} />{item.customerPhone}</a>
            )}
            {activeTransport.details.notes && <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-900"><strong>{t("assetProgress.dispatchNotes")}:</strong> {activeTransport.details.notes}</p>}
            {nextTransportStatus && onAdvanceTransport && !fieldOperationsBlocked && (
              <div>
                <label htmlFor={`driver-notes-${activeTransport.id}`} className="font-semibold text-slate-600">{t("assetProgress.driverNotes")}</label>
                <textarea
                  id={`driver-notes-${activeTransport.id}`}
                  value={driverNotes}
                  onChange={(event) => setDriverNotes(event.target.value)}
                  rows={2}
                  maxLength={5000}
                  placeholder={t("assetProgress.driverNotesPlaceholder")}
                  className="mt-1 w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm"
                />
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {inspectionType && inspectionValue === "pending" && onInspect && !fieldOperationsBlocked && (
            <button onClick={() => onInspect(item, inspectionType)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-800">
              <ClipboardCheck size={15} /> {inspectionType === "dispatch" ? t("assetProgress.doEntryInspection") : t("assetProgress.doReturnInspection")}
            </button>
          )}
          {canStartReturn && onStartReturn && !fieldOperationsBlocked && (
            <button onClick={() => onStartReturn(item)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-2 text-xs font-bold text-white hover:opacity-90">
              <Play size={15} /> {t("assetProgress.startReturn")}
            </button>
          )}
          {canConfirmPickup && onConfirmPickup && !fieldOperationsBlocked && (
            <button onClick={() => onConfirmPickup(item)} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-700">
              <Truck size={15} /> {t("assetProgress.confirmPhysicalPickup")}
            </button>
          )}
          {activeTransport?.id && nextTransportStatus && onAdvanceTransport && !fieldOperationsBlocked && (
            <button onClick={() => onAdvanceTransport(item, activeTransport.id!, nextTransportStatus, driverNotes.trim() || undefined)} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-700 px-3 py-2 text-xs font-bold text-white hover:bg-blue-800">
              <Truck size={15} /> {t(`assetProgress.advance.${nextTransportStatus}`)}
            </button>
          )}
          {isSuperAdmin && inspectionType && inspectionValue === "pending" && onBypass && (
            <button onClick={() => setBypassType(inspectionType)} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100">
              <ShieldAlert size={15} /> {t("assetProgress.bypass")}
            </button>
          )}
          <button onClick={() => setTimelineOpen((open) => !open)} className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100">
            <History size={14} /> {t("assetProgress.history")} {timelineOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>

        {timelineOpen && (
          <div className="mt-4 border-t border-dashed border-slate-200 pt-3">
            {timelineLoading ? <p className="text-xs text-slate-400">{t("loading")}</p> : timeline?.length ? (
              <ol className="space-y-2">
                {timeline.map((event) => (
                  <li key={event.id} className="grid grid-cols-[8px_1fr] gap-2 text-xs">
                    <span className="mt-1 h-2 w-2 rounded-full bg-[var(--primary)]" />
                    <div><span className="font-semibold text-slate-700">{t(`assetProgress.event.${event.eventType}`, { defaultValue: event.eventType })}</span><span className="ml-2 text-slate-400">{new Date(event.createdAt).toLocaleString()}</span>{event.reason && <p className="mt-0.5 text-amber-800">{event.reason}</p>}</div>
                  </li>
                ))}
              </ol>
            ) : <p className="text-xs text-slate-400">{t("assetProgress.noHistory")}</p>}
          </div>
        )}
      </div>

      {bypassType && (
        <div className="border-t border-amber-200 bg-amber-50 p-4">
          <p className="text-xs font-bold text-amber-950">{t("assetProgress.bypassWarning")}</p>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} placeholder={t("assetProgress.bypassReason")} className="mt-2 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm" />
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={() => { setBypassType(null); setReason(""); }} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600">{t("cancel")}</button>
            <button onClick={submitBypass} disabled={reason.trim().length < 5 || submitting} className="rounded-lg bg-amber-800 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">{submitting ? t("saving") : t("confirm")}</button>
          </div>
        </div>
      )}
    </article>
  );
}

export default function AssetProgressPanel({ items, loading, ...props }: Props) {
  const { t } = useTranslation("common");
  if (loading) return <div className="py-10 text-center text-sm text-slate-400">{t("loading")}</div>;
  if (items.length === 0) return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm text-slate-400">{t("assetProgress.empty")}</div>;
  return <div className="space-y-3">{items.map((item) => <AssetProgressCard key={`${item.rentalRequestId}:${item.rentalFleetId}`} item={item} {...props} />)}</div>;
}
