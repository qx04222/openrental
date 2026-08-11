import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useRoute } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import PhotoLightbox from "@/components/PhotoLightbox";
import { Link } from "wouter";
import { ArrowLeft, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { useFormatCalendarDate, useAppTimezone, formatCalendarDate } from "@/lib/dateUtils";

const conditionColors: Record<string, string> = {
  excellent: "bg-green-100 text-green-700",
  good: "bg-blue-100 text-blue-700",
  fair: "bg-yellow-100 text-yellow-700",
  poor: "bg-red-100 text-red-700",
};

const damageColors: Record<string, string> = {
  none: "text-slate-400",
  minor: "text-yellow-600",
  moderate: "text-orange-600",
  severe: "text-red-600",
};

export default function FleetInspectionHistory() {
  const { t } = useTranslation(["inspection", "common"]);
  const [, params] = useRoute("/admin/rental-fleet/:id/inspections");
  const fleetId = Number(params?.id);

  const { data: fleetData } = trpc.rentalFleet.getById.useQuery({ id: fleetId }, { enabled: !!fleetId });
  const fleet = fleetData?.rental_fleet;
  const { data: summary } = trpc.inspections.getFleetInspectionSummary.useQuery({ fleetId }, { enabled: !!fleetId });
  const { data: inspections, isLoading } = trpc.inspections.getByFleetId.useQuery({ fleetId }, { enabled: !!fleetId });

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [lightboxPhotos, setLightboxPhotos] = useState<{ src: string; label: string }[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const fmtDate = useFormatCalendarDate();
  const tz = useAppTimezone();

  const typeDot: Record<string, string> = {
    dispatch: "bg-blue-500",
    return: "bg-purple-500",
    general: "bg-slate-400",
  };

  const photoLabels = [
    { key: "photoFront" as const, label: t("front") },
    { key: "photoBack" as const, label: t("back") },
    { key: "photoLeft" as const, label: t("left") },
    { key: "photoRight" as const, label: t("right") },
    { key: "photoAdditional" as const, label: t("additional") },
  ];

  // Chart data from summary
  const trendData = (summary?.trendData || []).filter((d) => d.engineHours || d.odometerReading || d.fuelLevel).map((d) => ({
    date: formatCalendarDate(d.date, tz),
    engineHours: d.engineHours,
    odometer: d.odometerReading,
    fuel: d.fuelLevel,
  }));

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link href="/admin/rental-fleet" className="text-slate-400 hover:text-slate-600">
            <ArrowLeft size={20} />
          </Link>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">
              {fleet ? `${fleet.brand} ${fleet.model}` : t("fleetHistory.title")}
            </h1>
            <p className="text-sm text-slate-500">
              {fleet?.assetNumber && <span className="mr-3">#{fleet.assetNumber}</span>}
              {fleet?.serialNumber && <span className="mr-3">S/N: {fleet.serialNumber}</span>}
              {t("fleetHistory.subtitle")}
            </p>
          </div>
        </div>

        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 text-center">
              <div className="text-lg font-bold text-slate-900">{summary.total}</div>
              <div className="text-xs text-slate-500">{t("fleetHistory.totalInspections")}</div>
            </div>
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 text-center">
              <div className="text-lg font-bold text-blue-600">{summary.byType.dispatch}</div>
              <div className="text-xs text-slate-500">{t("dispatch")}</div>
            </div>
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 text-center">
              <div className="text-lg font-bold text-purple-600">{summary.byType.return}</div>
              <div className="text-xs text-slate-500">{t("return")}</div>
            </div>
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 text-center">
              <div className="text-lg font-bold text-slate-600">{summary.byType.general}</div>
              <div className="text-xs text-slate-500">{t("general")}</div>
            </div>
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 text-center">
              <div className="text-lg font-bold text-yellow-600">{summary.damageCount.minor}</div>
              <div className="text-xs text-slate-500">{t("fleetHistory.minorDamage")}</div>
            </div>
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 text-center">
              <div className="text-lg font-bold text-orange-600">{summary.damageCount.moderate}</div>
              <div className="text-xs text-slate-500">{t("fleetHistory.moderateDamage")}</div>
            </div>
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 text-center">
              <div className={`text-lg font-bold ${summary.damageCount.severe > 0 ? "text-red-600" : "text-slate-400"}`}>{summary.damageCount.severe}</div>
              <div className="text-xs text-slate-500">{t("fleetHistory.severeDamage")}</div>
            </div>
          </div>
        )}

        {/* Trend Chart */}
        {trendData.length >= 2 && (
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-6">
            <h2 className="text-sm font-semibold text-slate-500 uppercase mb-4">{t("fleetHistory.trendChart")}</h2>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E7E0D9" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} domain={[0, 100]} />
                <Tooltip />
                <Legend />
                {trendData.some((d) => d.engineHours) && (
                  <Line yAxisId="left" type="monotone" dataKey="engineHours" stroke="#2563EB" name={t("fleetHistory.engineHours")} dot={{ r: 3 }} connectNulls />
                )}
                {trendData.some((d) => d.odometer) && (
                  <Line yAxisId="left" type="monotone" dataKey="odometer" stroke="#3B82F6" name={t("fleetHistory.odometer")} dot={{ r: 3 }} connectNulls />
                )}
                {trendData.some((d) => d.fuel) && (
                  <Line yAxisId="right" type="monotone" dataKey="fuel" stroke="#10B981" name={t("fleetHistory.fuelLevel")} dot={{ r: 3 }} connectNulls />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Inspection Timeline */}
        <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm">
          <div className="px-6 py-4 border-b border-slate-200">
            <h2 className="text-lg font-semibold text-slate-900">{t("fleetHistory.allInspections")}</h2>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="spinner" />
              <span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span>
            </div>
          ) : (inspections || []).length === 0 ? (
            <div className="py-12 text-center text-slate-400">{t("fleetHistory.noInspections")}</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {(inspections || []).map((row) => {
                const insp = row.inspections;
                const rental = row.rental_requests;
                const isExpanded = expandedId === insp.id;

                return (
                  <div key={insp.id}>
                    {/* Row header */}
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : insp.id)}
                      className="w-full px-6 py-3 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      {isExpanded ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
                      <div className={`w-2 h-2 rounded-full ${typeDot[insp.type] || "bg-slate-400"}`} />
                      <span className="text-xs font-medium capitalize px-2 py-0.5 rounded bg-slate-100 text-slate-600">{insp.type}</span>
                      <span className={`text-xs px-2 py-0.5 rounded ${conditionColors[insp.overallCondition || "good"]}`}>{insp.overallCondition || "-"}</span>
                      {insp.damageSeverity && insp.damageSeverity !== "none" && (
                        <span className={`text-xs flex items-center gap-1 ${damageColors[insp.damageSeverity]}`}>
                          <AlertTriangle size={12} /> {insp.damageSeverity}
                        </span>
                      )}
                      <span className="text-xs text-slate-400 ml-auto">{fmtDate(insp.createdAt)}</span>
                      {insp.inspectorName && <span className="text-xs text-slate-400">{insp.inspectorName}</span>}
                      {rental?.customerName && <span className="text-xs text-slate-400">{rental.rentalNumber || `#${rental.id}`} {rental.customerName}</span>}
                    </button>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <div className="px-6 pb-4 pl-12 space-y-3">
                        {/* Readings */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                          <div><span className="text-slate-400 text-xs block">{t("fleetHistory.engineHours")}</span><span className="text-slate-900">{insp.engineHours ?? "-"}</span></div>
                          <div><span className="text-slate-400 text-xs block">{t("fleetHistory.fuelLevel")}</span><span className="text-slate-900">{insp.fuelLevel ? `${insp.fuelLevel}%` : "-"}</span></div>
                          <div><span className="text-slate-400 text-xs block">{t("fleetHistory.odometer")}</span><span className="text-slate-900">{insp.odometerReading ?? "-"}</span></div>
                          <div><span className="text-slate-400 text-xs block">{t("fleetHistory.location")}</span><span className="text-slate-900">{insp.locationAddress || "-"}</span></div>
                        </div>

                        {/* Damage */}
                        {insp.damageNotes && (
                          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                            <span className="text-xs font-medium text-yellow-700">{t("fleetHistory.damageNotes")}</span>
                            <p className="text-sm text-slate-700 mt-1">{insp.damageNotes}</p>
                          </div>
                        )}

                        {/* Photos */}
                        {(() => {
                          const photos = photoLabels
                            .map((p) => ({ src: (insp as Record<string, unknown>)[p.key] as string | null, label: p.label }))
                            .filter((p) => p.src);
                          if (photos.length === 0) return null;
                          return (
                            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                              {photos.map((photo, idx) => (
                                <button
                                  key={photo.label}
                                  onClick={() => { setLightboxPhotos(photos as { src: string; label: string }[]); setLightboxIndex(idx); }}
                                  className="relative aspect-square bg-slate-100 rounded-lg overflow-hidden hover:ring-2 hover:ring-[var(--primary)]"
                                >
                                  <img src={photo.src!} alt={photo.label} className="w-full h-full object-cover" />
                                  <span className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[10px] text-center py-0.5">{photo.label}</span>
                                </button>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {lightboxPhotos && (
        <PhotoLightbox photos={lightboxPhotos} initialIndex={lightboxIndex} onClose={() => setLightboxPhotos(null)} />
      )}
    </DashboardLayout>
  );
}
