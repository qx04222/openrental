import { useMemo, useState } from "react";
import { ArrowLeft, ClipboardList } from "lucide-react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import AssetProgressPanel, { type AssetProgressItem } from "@/components/AssetProgressPanel";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { assetProgressTab, fieldProgressRefreshInterval, type AssetProgressTab } from "@/lib/assetProgressPresentation";
import { trpc } from "@/lib/trpc";
import { serverErrorText } from "@/lib/serverError";

const tabs: Array<{ value: AssetProgressTab; labelKey: "assetProgress.tab.entry" | "assetProgress.tab.rental" | "assetProgress.tab.return" | "assetProgress.tab.completed" }> = [
  { value: "entry", labelKey: "assetProgress.tab.entry" },
  { value: "rental", labelKey: "assetProgress.tab.rental" },
  { value: "return", labelKey: "assetProgress.tab.return" },
  { value: "completed", labelKey: "assetProgress.tab.completed" },
];

export default function FieldDeliveries() {
  const { t } = useTranslation(["public", "common"]);
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<AssetProgressTab>("entry");
  const progress = trpc.rentalAssetProgress.fieldList.useQuery(undefined, {
    refetchInterval: () => fieldProgressRefreshInterval(document.visibilityState),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const refreshProgress = async (item?: AssetProgressItem) => {
    await utils.rentalAssetProgress.fieldList.invalidate();
    if (item) {
      await utils.rentalAssetProgress.byRental.invalidate({ rentalId: item.rentalRequestId });
      await utils.rentalAssetProgress.timeline.invalidate({ rentalId: item.rentalRequestId, rentalFleetId: item.rentalFleetId });
    }
  };

  const startReturn = trpc.rentalAssetProgress.startReturn.useMutation({
    onSuccess: async (_result, input) => {
      await refreshProgress(progress.data?.find((item) => item.rentalRequestId === input.rentalId && item.rentalFleetId === input.rentalFleetId));
      setTab("return");
      toast.success(t("assetProgress.returnStarted", { ns: "common" }));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });
  const advanceTransport = trpc.dispatch.updateMyStatus.useMutation({
    onSuccess: async () => {
      await refreshProgress();
      toast.success(t("assetProgress.transportUpdated", { ns: "common" }));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });
  const confirmPickup = trpc.rollingRentals.pickup.useMutation({
    onSuccess: async (_result, input) => {
      await refreshProgress(progress.data?.find((item) => item.rentalRequestId === input.rentalId && item.rentalFleetId === input.rentalFleetId));
      toast.success(t("assetProgress.physicalPickupRecorded", { ns: "common" }));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });

  const items = useMemo(
    () => (progress.data ?? []).filter((item) => assetProgressTab(item.stage) === tab),
    [progress.data, tab],
  );
  const counts = useMemo(() => (progress.data ?? []).reduce<Record<AssetProgressTab, number>>((result, item) => {
    result[assetProgressTab(item.stage)] += 1;
    return result;
  }, { entry: 0, rental: 0, return: 0, completed: 0 }), [progress.data]);

  const openInspection = (item: AssetProgressItem, type: "dispatch" | "return") => {
    const params = new URLSearchParams({
      type,
      fleetId: String(item.rentalFleetId),
      fleetLabel: item.equipmentLabel,
      rentalId: String(item.rentalRequestId),
    });
    setLocation(`/field-inspection?${params.toString()}`);
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(196,37,26,0.08),transparent_35%),var(--surface)] px-4 py-5">
      <div className="mx-auto max-w-xl">
        <header className="mb-6 flex items-center gap-3">
          <Link href="/field-dashboard" className="rounded-lg p-2 text-slate-500 hover:bg-white hover:text-slate-900" aria-label={t("back", { ns: "common" })}><ArrowLeft size={22} /></Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.2em] text-[var(--primary)]"><ClipboardList size={14} /> {t("fieldDeliveries.liveOperations")}</div>
            <h1 className="mt-0.5 text-xl font-black tracking-tight text-slate-950">{t("fieldDeliveries.progressTitle")}</h1>
            <p className="text-xs text-slate-500">{t("fieldDeliveries.progressSubtitle")}</p>
          </div>
          <LanguageSwitcher />
        </header>

        <nav className="mb-4 grid grid-cols-4 gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {tabs.map(({ value, labelKey }) => (
            <button key={value} onClick={() => setTab(value)} className={`rounded-lg px-1 py-2 text-[11px] font-bold transition-colors ${tab === value ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100"}`}>
              <span className="block">{t(labelKey, { ns: "common" })}</span>
              <span className={`mt-0.5 inline-block min-w-5 rounded-full px-1.5 font-mono text-[10px] ${tab === value ? "bg-white/15" : "bg-slate-100"}`}>{counts[value]}</span>
            </button>
          ))}
        </nav>

        <AssetProgressPanel
          items={items}
          loading={progress.isLoading}
          onInspect={openInspection}
          onStartReturn={(item) => startReturn.mutate({ rentalId: item.rentalRequestId, rentalFleetId: item.rentalFleetId })}
          onConfirmPickup={(item) => confirmPickup.mutate({ rentalId: item.rentalRequestId, rentalFleetId: item.rentalFleetId })}
          onAdvanceTransport={(_item, id, status, driverNotes) => advanceTransport.mutate({ id, status, driverNotes })}
        />
      </div>
    </main>
  );
}
