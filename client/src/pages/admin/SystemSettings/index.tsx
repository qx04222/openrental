import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";

/**
 * Settings Center landing — the left menu (SettingsShell) carries navigation;
 * the right pane shows a short hint. Picking an item swaps the right content.
 */
export default function SystemSettings() {
  const { t } = useTranslation("common");
  return (
    <SettingsShell>
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("sidebar.systemSettings")}</h1>
        <p className="text-sm text-slate-500 mt-1">{t("systemSettings.subtitle")}</p>
        <p className="text-sm text-slate-400 mt-6">{t("systemSettings.pickHint")}</p>
      </div>
    </SettingsShell>
  );
}
