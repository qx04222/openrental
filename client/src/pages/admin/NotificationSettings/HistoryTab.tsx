import { useTranslation } from "react-i18next";
import { Trash2, Mail, Smartphone } from "lucide-react";
import { notificationStatusColors as statusColors } from "@/lib/statusColors";
import { translateDynamic } from "@/lib/i18nHelpers";

interface NotificationLogEntry {
  id: number;
  channel: string;
  recipient: string;
  subject: string | null;
  event: string | null;
  status: string;
  errorMessage: string | null;
  relatedEntityType: string | null;
  relatedEntityId: number | null;
  createdAt: Date;
}

interface HistoryTabProps {
  stats: {
    totalSent: number;
    totalFailed: number;
    emailSent: number;
    smsSent: number;
    last24h: number;
    last7d: number;
  } | undefined;
  logs: NotificationLogEntry[];
  historyChannel: string;
  setHistoryChannel: (v: string) => void;
  historyStatus: string;
  setHistoryStatus: (v: string) => void;
  onClearLog: () => void;
}

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card !p-3 text-center">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

const fmtDate = (d: string | Date | null | undefined) => d ? new Date(d).toLocaleString() : "-";

export default function HistoryTab({
  stats,
  logs,
  historyChannel,
  setHistoryChannel,
  historyStatus,
  setHistoryStatus,
  onClearLog,
}: HistoryTabProps) {
  const { t } = useTranslation("admin");

  return (
    <div className="space-y-4">
      {/* Mini stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MiniStat label={t("notifications.totalSent")} value={stats?.totalSent ?? 0} color="text-green-600" />
        <MiniStat label={t("notifications.totalFailed")} value={stats?.totalFailed ?? 0} color="text-red-600" />
        <MiniStat label={t("notifications.last24h")} value={stats?.last24h ?? 0} color="text-blue-600" />
        <MiniStat label={t("notifications.last7d")} value={stats?.last7d ?? 0} color="text-purple-600" />
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center flex-wrap">
        <select
          value={historyChannel}
          onChange={(e) => setHistoryChannel(e.target.value)}
          className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700"
        >
          <option value="">{t("notifications.allChannels")}</option>
          <option value="email">{t("notifications.email")}</option>
          <option value="sms">{t("notifications.sms")}</option>
        </select>
        <select
          value={historyStatus}
          onChange={(e) => setHistoryStatus(e.target.value)}
          className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700"
        >
          <option value="">{t("notifications.allStatuses")}</option>
          <option value="sent">{t("notifications.statusSent")}</option>
          <option value="failed">{t("notifications.statusFailed")}</option>
        </select>
        <div className="ml-auto">
          <button
            onClick={onClearLog}
            className="text-xs text-[var(--primary)] hover:text-[var(--accent-hover)] flex items-center gap-1"
          >
            <Trash2 size={12} /> {t("notifications.clearOldLogs")}
          </button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-slate-500 border-b border-slate-200">
            <tr>
              <th className="py-3 px-4">{t("notifications.time")}</th>
              <th className="py-3 px-4">{t("notifications.channel")}</th>
              <th className="py-3 px-4">{t("notifications.recipient")}</th>
              <th className="py-3 px-4">{t("notifications.eventCol")}</th>
              <th className="py-3 px-4">{t("notifications.subject")}</th>
              <th className="py-3 px-4">{t("notifications.status")}</th>
              <th className="py-3 px-4">{t("notifications.error")}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} className="border-b border-slate-200/50 text-slate-600 hover:bg-slate-100/30">
                <td className="py-3 px-4 text-xs whitespace-nowrap">{fmtDate(log.createdAt)}</td>
                <td className="py-3 px-4">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${log.channel === "email" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>
                    {log.channel === "email" ? <Mail size={12} /> : <Smartphone size={12} />}
                    {translateDynamic(t, `notifications.${log.channel}`, { defaultValue: log.channel })}
                  </span>
                </td>
                <td className="py-3 px-4 text-sm">{log.recipient}</td>
                <td className="py-3 px-4 font-mono text-xs text-slate-400">{log.event || "-"}</td>
                <td className="py-3 px-4 max-w-[200px] truncate">{log.subject || "-"}</td>
                <td className="py-3 px-4">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold tracking-wide ${statusColors[log.status] || ""}`}>
                    {translateDynamic(t, `notifications.status${log.status.charAt(0).toUpperCase() + log.status.slice(1)}`, { defaultValue: log.status })}
                  </span>
                </td>
                <td className="py-3 px-4 text-red-400 max-w-[200px] truncate text-xs">{log.errorMessage || "-"}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={7} className="py-8 text-center text-slate-400">{t("notifications.noHistory")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
