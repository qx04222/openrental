import { Link } from "wouter";
import { useBranding } from "@/config/branding";
import { trpc } from "@/lib/trpc";
import { ClipboardCheck, Truck, LogOut, Wifi, WifiOff, Calendar } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { getPendingInspections } from "@/lib/pwa";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { assetProgressTab } from "@/lib/assetProgressPresentation";

export default function FieldDashboard() {
  const branding = useBranding();
  const { t } = useTranslation("public");
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);

  const logout = trpc.fieldAuth.logout.useMutation({
    onSuccess: () => { window.location.href = "/field-access"; },
  });

  const { data: operations } = trpc.rentalAssetProgress.fieldList.useQuery(undefined, {
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });

  const activeDeliveries = useMemo(
    () => (operations || []).filter((item) => item.stage !== "completed"),
    [operations]
  );

  const todayDeliveries = useMemo(() => {
    const today = new Date().toDateString();
    return activeDeliveries.filter((item) => {
      const date = item.stage.startsWith("return_") ? item.endDate : item.startDate;
      return new Date(date).toDateString() === today;
    });
  }, [activeDeliveries]);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    getPendingInspections().then((items) => setPendingCount(items.length)).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-[var(--surface)] p-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <img src="/logo.png" alt={branding.companyName} className="h-8" />
            <p className="text-sm text-slate-500 mt-1">{t("fieldDashboard.title")}</p>
          </div>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <div className={`flex items-center gap-1 text-xs ${isOnline ? "text-green-500" : "text-red-400"}`}>
              {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
              {isOnline ? t("fieldDashboard.online") : t("fieldDashboard.offline")}
            </div>
            <button onClick={() => logout.mutate()} className="text-slate-500 hover:text-[var(--primary)]" aria-label="Sign out">
              <LogOut size={20} />
            </button>
          </div>
        </div>

        {/* Pending Sync Banner */}
        {pendingCount > 0 && (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 mb-6 text-yellow-400 text-sm">
            {pendingCount} {t("fieldDashboard.pendingSync")}
          </div>
        )}

        {/* Actions */}
        <div className="space-y-4">
          <Link href="/field-inspection" className="card flex items-center gap-4 hover:border-[#2563EB]/50 transition-colors cursor-pointer">
            <div className="p-3 bg-[var(--primary)]/15 rounded-lg text-[var(--primary)]">
              <ClipboardCheck size={28} />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-bold text-slate-900">{t("fieldDashboard.startInspection")}</h2>
              <p className="text-sm text-slate-500">{t("fieldDashboard.inspectionDesc")}</p>
            </div>
          </Link>

          <Link href="/field-deliveries" className="card flex items-center gap-4 hover:border-blue-600/50 transition-colors cursor-pointer">
            <div className="p-3 bg-blue-500/20 rounded-lg text-blue-400">
              <Truck size={28} />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-bold text-slate-900">{t("fieldDashboard.deliveries")}</h2>
              <p className="text-sm text-slate-500">{t("fieldDashboard.deliveriesDesc")}</p>
            </div>
            <div className="flex flex-col items-end gap-1">
              {activeDeliveries.length > 0 && (
                <span className="bg-blue-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                  {activeDeliveries.length}
                </span>
              )}
              {todayDeliveries.length > 0 && (
                <span className="bg-orange-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
                  {todayDeliveries.length} {t("fieldDashboard.todayDeliveries")}
                </span>
              )}
            </div>
          </Link>
        </div>

        {/* Today's Schedule */}
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <Calendar size={16} />
            {t("fieldDashboard.todaySchedule")}
          </h3>
          {todayDeliveries.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-sm bg-[var(--surface-container-lowest)] rounded-lg border border-slate-100">
              {t("fieldDashboard.noScheduleToday")}
            </div>
          ) : (
            <div className="space-y-2">
              {todayDeliveries.map((item) => (
                  <Link
                    key={`${item.rentalRequestId}:${item.rentalFleetId}`}
                    href="/field-deliveries"
                    className="block bg-[var(--surface-container-lowest)] rounded-lg border border-slate-100 p-3 hover:border-blue-300 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-900">
                        {item.serialNumber || `#${item.rentalFleetId}`} — {item.equipmentLabel}
                      </span>
                      <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-medium text-white">
                        {t(`assetProgress.tab.${assetProgressTab(item.stage)}`, { ns: "common" })}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {item.customerName} · {item.rentalNumber || `#${item.rentalRequestId}`}
                    </div>
                  </Link>
              ))}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="mt-8 text-center text-xs text-slate-400">
          <p>{branding.contactPhone}</p>
          <p>{branding.address}</p>
        </div>
      </div>
    </div>
  );
}
