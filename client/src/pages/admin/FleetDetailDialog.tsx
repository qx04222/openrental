import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { ClipboardCheck, ChevronDown, ChevronUp, ExternalLink, AlertCircle, CheckCircle2 } from "lucide-react";
import { conditionColors, inspectionTypeBadges } from "@/lib/statusColors";
import PhotoLightbox from "@/components/PhotoLightbox";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { formatCurrency } from "@/lib/pricing";

interface FleetDetailDialogProps {
  fleetId: number;
  fleetLabel: string; // "Brand Model" for the title
  onClose: () => void;
}

export default function FleetDetailDialog({ fleetId, fleetLabel, onClose }: FleetDetailDialogProps) {
  const { t } = useTranslation(["fleet", "common", "inspection"]);

  const photoLabels: { key: string; label: string }[] = [
    { key: "photoFront", label: t("photo.front", { ns: "common" }) },
    { key: "photoBack", label: t("photo.back", { ns: "common" }) },
    { key: "photoLeft", label: t("photo.left", { ns: "common" }) },
    { key: "photoRight", label: t("photo.right", { ns: "common" }) },
    { key: "photoAdditional", label: t("photo.additional", { ns: "common" }) },
  ];
  const { data: inspections, isLoading } = trpc.inspections.getByFleetId.useQuery({ fleetId });
  const { data: usageList } = trpc.rentalFleet.usageStats.useQuery({ fleetIds: [fleetId] });
  const usage = usageList?.[0];
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [lightboxPhotos, setLightboxPhotos] = useState<{ src: string; label: string }[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const fmtDate = useFormatCalendarDate();
  const fmtDateTime = (d: string | Date | null | undefined) =>
    d ? new Date(d).toLocaleString() : "-";

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-stretch md:items-center md:justify-center md:p-4">
        <div className="fixed inset-0 bg-black/60" onClick={onClose} />
        <div className="relative bg-[var(--surface-container-lowest)] md:rounded-xl shadow-sm max-w-3xl w-full h-full md:h-auto md:max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="sticky top-0 bg-white border-b border-slate-200 px-4 md:px-6 py-3 md:py-4 flex justify-between items-center z-10">
            <div>
              <h2 className="text-lg font-bold text-slate-900">{fleetLabel}</h2>
              <div className="flex items-center gap-3">
                <p className="text-sm text-slate-500">{t("inspectionHistory")}</p>
                <Link
                  href={`/admin/rental-fleet/${fleetId}/inspections`}
                  className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1"
                  onClick={onClose}
                >
                  {t("fleetHistory.viewFull")} <ExternalLink size={10} />
                </Link>
              </div>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl" aria-label="Close">&times;</button>
          </div>

          {/* Payback hero — top of dialog. When purchaseCost set, show a
              progress bar; when not, show a CTA so the user knows ROI
              tracking is just one field away. */}
          <div className="px-4 md:px-6 pt-4">
            {usage && usage.paybackProgress != null ? (
              (() => {
                const pct = Math.min(usage.paybackProgress * 100, 999);
                const paidBack = usage.isPaidBack;
                const surplus = usage.lifetimeRevenue - (usage.purchaseCost ?? 0);
                return (
                  <div className={`rounded-xl p-4 ${paidBack ? "bg-emerald-50 border border-emerald-200" : "bg-blue-50 border border-blue-200"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {paidBack ? <CheckCircle2 size={18} className="text-emerald-600" /> : null}
                        <span className={`text-sm font-bold ${paidBack ? "text-emerald-900" : "text-blue-900"}`}>
                          {paidBack ? t("payback.paidBack") : t("payback.progressFmt", { pct: pct.toFixed(0) })}
                        </span>
                      </div>
                      <span className={`text-xs ${paidBack ? "text-emerald-700" : "text-blue-700"}`}>
                        {t("payback.amountFmt", {
                          earned: formatCurrency(usage.lifetimeRevenue),
                          cost: formatCurrency(usage.purchaseCost ?? 0),
                        })}
                      </span>
                    </div>
                    <div className="w-full bg-white/60 h-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${paidBack ? "bg-emerald-500" : "bg-blue-500"}`}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    <div className={`text-xs mt-2 ${paidBack ? "text-emerald-700" : "text-blue-700"}`}>
                      {paidBack
                        ? t("payback.surplusFmt", { amount: formatCurrency(surplus) })
                        : t("payback.remainingFmt", { amount: formatCurrency(usage.paybackRemaining ?? 0) })}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="rounded-xl p-4 bg-amber-50 border border-amber-200 flex items-start gap-3">
                <AlertCircle size={18} className="text-amber-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-amber-900">{t("payback.noCostTitle")}</div>
                  <div className="text-xs text-amber-700 mt-0.5">{t("payback.noCostBody")}</div>
                </div>
              </div>
            )}
          </div>

          {/* Usage stats — calendar days / engine hours / last used / avg daily */}
          <div className="px-4 md:px-6 pt-4">
            <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">{t("section.usage")}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{t("usage.totalRentedDays")}</div>
                <div className="text-xl font-bold text-slate-900 mt-1">
                  {usage ? `${usage.totalRentedDays} ${t("usage.daysShort")}` : t("usage.noData")}
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{t("usage.totalOperatingHours")}</div>
                <div className="text-xl font-bold text-slate-900 mt-1">
                  {usage?.hasHoursData ? `${usage.totalOperatingHours} ${t("usage.hoursShort")}` : t("usage.noData")}
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{t("usage.lastUsedDate")}</div>
                <div className="text-sm font-bold text-slate-900 mt-1">
                  {usage?.lastUsedDate ? fmtDate(usage.lastUsedDate) : t("usage.never")}
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{t("usage.avgDailyHours")}</div>
                <div className="text-xl font-bold text-slate-900 mt-1">
                  {usage?.hasHoursData && usage.totalRentedDays > 0
                    ? `${(usage.totalOperatingHours / usage.totalRentedDays).toFixed(1)} ${t("usage.hoursShort")}`
                    : t("usage.noData")}
                </div>
              </div>
            </div>
          </div>

          {/* Revenue / unit economics */}
          <div className="px-4 md:px-6 pt-4">
            <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2">{t("section.revenue")}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{t("usage.lifetimeRevenue")}</div>
                <div className="text-xl font-bold text-slate-900 mt-1">
                  {usage ? formatCurrency(usage.lifetimeRevenue) : t("usage.noData")}
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{t("usage.revenuePerDay")}</div>
                <div className="text-xl font-bold text-slate-900 mt-1">
                  {usage?.revenuePerDay != null ? formatCurrency(Math.round(usage.revenuePerDay)) : t("usage.noData")}
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{t("usage.revenuePerHour")}</div>
                <div className="text-xl font-bold text-slate-900 mt-1">
                  {usage?.revenuePerHour != null ? formatCurrency(Math.round(usage.revenuePerHour)) : t("usage.noData")}
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <div className="text-[11px] text-slate-500 uppercase tracking-wide">{t("usage.rentalCount")}</div>
                <div className="text-xl font-bold text-slate-900 mt-1">
                  {usage ? usage.rentalCount : t("usage.noData")}
                </div>
              </div>
            </div>
          </div>

          <div className="p-4 md:p-6">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="spinner" />
                <span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span>
              </div>
            ) : !inspections || inspections.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <ClipboardCheck size={48} className="mx-auto mb-3 opacity-30" />
                <p>{t("noInspections")}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Summary bar */}
                <div className="flex items-center gap-4 text-sm text-slate-500 mb-4">
                  <span>{inspections.length} {t("totalInspections")}</span>
                  <span>·</span>
                  <span>{inspections.filter((i) => i.inspections.type === "dispatch").length} {t("dispatches")}</span>
                  <span>{inspections.filter((i) => i.inspections.type === "return").length} {t("returns")}</span>
                  <span>{inspections.filter((i) => i.inspections.type === "general").length} {t("generals")}</span>
                </div>

                {/* Timeline */}
                {inspections.map((item) => {
                  const insp = item.inspections;
                  const isExpanded = expandedId === insp.id;

                  const photos = photoLabels
                    .filter(({ key }) => insp[key as keyof typeof insp])
                    .map(({ key, label }) => ({
                      src: insp[key as keyof typeof insp] as string,
                      label,
                    }));

                  if (insp.customerSignature) {
                    photos.push({ src: insp.customerSignature, label: t("photo.signature", { ns: "common" }) });
                  }

                  return (
                    <div key={insp.id} className="border border-slate-200 rounded-lg overflow-hidden">
                      {/* Row header -- always visible */}
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : insp.id)}
                        className="w-full flex items-center gap-3 p-4 text-left hover:bg-slate-50 transition-colors"
                      >
                        {/* Timeline dot */}
                        <div className={`w-3 h-3 rounded-full flex-shrink-0 ${
                          insp.type === "dispatch" ? "bg-blue-500" : insp.type === "return" ? "bg-purple-500" : "bg-slate-400"
                        }`} />

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${inspectionTypeBadges[insp.type] || ""}`}>
                              {t(insp.type, { ns: "inspection" })}
                            </span>
                            <span className={`text-sm font-medium capitalize ${conditionColors[insp.overallCondition || ""] || "text-slate-400"}`}>
                              {insp.overallCondition ? t(`condition.${insp.overallCondition}`, { ns: "common" }) : "-"}
                            </span>
                            {insp.damageSeverity && insp.damageSeverity !== "none" && (
                              <span className="px-1.5 py-0.5 bg-red-50 text-red-600 rounded text-xs">
                                {t(`damage.${insp.damageSeverity}` as keyof typeof import("@/i18n/locales/en/common.json"), { ns: "common" })}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-400 mt-1">
                            {fmtDate(insp.createdAt)}
                            {insp.inspectorName && ` · ${insp.inspectorName}`}
                            {item.rental_requests?.id && ` · ${t("rentalNumber", { id: item.rental_requests.rentalNumber || item.rental_requests.id, ns: "common" })}`}
                            {item.rental_requests?.customerName && ` (${item.rental_requests.customerName})`}
                          </div>
                        </div>

                        {isExpanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                      </button>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <div className="border-t border-slate-200 p-4 bg-slate-50 space-y-4">
                          {/* Readings */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="bg-white rounded-lg p-2">
                              <div className="text-xs text-slate-400">{t("engineHours")}</div>
                              <div className="text-sm font-semibold text-slate-900">{insp.engineHours ?? "-"}</div>
                            </div>
                            <div className="bg-white rounded-lg p-2">
                              <div className="text-xs text-slate-400">{t("fuel")}</div>
                              <div className="text-sm font-semibold text-slate-900">{insp.fuelLevel != null ? `${insp.fuelLevel}%` : "-"}</div>
                            </div>
                            <div className="bg-white rounded-lg p-2">
                              <div className="text-xs text-slate-400">{t("mileage")}</div>
                              <div className="text-sm font-semibold text-slate-900">{insp.odometerReading ?? "-"}</div>
                            </div>
                            <div className="bg-white rounded-lg p-2">
                              <div className="text-xs text-slate-400">{t("location")}</div>
                              <div className="text-xs font-medium text-slate-900 truncate">{insp.locationAddress || "-"}</div>
                            </div>
                          </div>

                          {/* Damage notes */}
                          {insp.damageNotes && (
                            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
                              {insp.damageNotes}
                            </div>
                          )}

                          {insp.notes && <p className="text-sm text-slate-600">{insp.notes}</p>}

                          {/* Photos */}
                          {photos.length > 0 && (
                            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                              {photos.map((photo, idx) => (
                                <button
                                  key={idx}
                                  onClick={() => { setLightboxPhotos(photos); setLightboxIndex(idx); }}
                                  className="group"
                                >
                                  <img src={photo.src} alt={photo.label} className="w-full h-20 object-cover rounded-lg border border-slate-200 group-hover:ring-2 group-hover:ring-[var(--primary)] transition" />
                                  <span className="text-xs text-slate-400 mt-0.5 block">{photo.label}</span>
                                </button>
                              ))}
                            </div>
                          )}

                          {/* Meta */}
                          <div className="text-xs text-slate-400 space-y-0.5">
                            <div>{t("createdLabel", { ns: "common" })} {fmtDateTime(insp.createdAt)}</div>
                            {insp.customerSignedAt && <div>{t("signedLabel", { ns: "common" })} {fmtDateTime(insp.customerSignedAt)}</div>}
                            {insp.latitude && insp.longitude && <div>{t("gpsLabel", { ns: "common" })} {insp.latitude}, {insp.longitude}</div>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Photo Lightbox */}
      {lightboxPhotos && (
        <PhotoLightbox
          photos={lightboxPhotos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxPhotos(null)}
        />
      )}
    </>
  );
}
