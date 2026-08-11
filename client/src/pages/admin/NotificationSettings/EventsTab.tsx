import { useTranslation } from "react-i18next";
import {
  Zap, CheckCircle2, AlertTriangle,
} from "lucide-react";

interface NotificationTemplate {
  id: number;
  name: string;
  channel: string;
  event: string;
  subject: string | null;
  body: string;
  isActive: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RentalEvent {
  value: string;
  label: string;
}

interface EventsTabProps {
  rentalEvents: RentalEvent[];
  globalCfg: Record<string, string>;
  templates: NotificationTemplate[];
  onToggleEvent: (event: string) => void;
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${checked ? "bg-[var(--primary)]" : "bg-slate-200"}`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${checked ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

export default function EventsTab({
  rentalEvents,
  globalCfg,
  templates,
  onToggleEvent,
}: EventsTabProps) {
  const { t } = useTranslation("admin");

  return (
    <div className="space-y-4">
      <div className="card space-y-4">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-lg bg-amber-50 text-amber-600 text-xl"><Zap size={20} /></div>
          <div>
            <h2 className="text-lg font-bold text-slate-900">{t("notifications.eventPreferences")}</h2>
            <p className="text-sm text-slate-500">{t("notifications.eventPreferencesDesc")}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rentalEvents.map((ev) => {
            const enabled = globalCfg[`event_${ev.value}`] !== "false";
            const hasTemplate = templates.some((tmpl) => tmpl.event === ev.value && tmpl.isActive);
            return (
              <div
                key={ev.value}
                className={`flex items-center justify-between p-4 rounded-xl border transition ${enabled ? "bg-white border-slate-200" : "bg-slate-50 border-slate-100 opacity-60"}`}
              >
                <div className="flex items-center gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{t(ev.label as never)}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-xs text-slate-400 font-mono">{ev.value}</code>
                      {hasTemplate ? (
                        <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={10} /> {t("notifications.hasTemplate")}</span>
                      ) : (
                        <span className="text-xs text-amber-500 flex items-center gap-1"><AlertTriangle size={10} /> {t("notifications.noTemplate")}</span>
                      )}
                    </div>
                  </div>
                </div>
                <ToggleSwitch
                  checked={enabled}
                  onChange={() => onToggleEvent(ev.value)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
