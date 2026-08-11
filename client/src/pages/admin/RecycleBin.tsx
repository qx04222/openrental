import { useState } from "react";
import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { Trash2, RotateCcw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { auditEntityColors } from "@/lib/statusColors";
import { serverErrorText } from "@/lib/serverError";

type EntityType = "rental" | "fleet" | "inspection" | "dispatch" | "user" | "customer" | "warehouse" | "invoice" | "quotation";

function formatTime(date: Date | string, locale = "en-US"): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function RecycleBin() {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const utils = trpc.useUtils();

  const { data: items = [], isLoading } = trpc.recycleBin.list.useQuery();

  const restoreMutation = trpc.recycleBin.restore.useMutation({
    onSuccess: () => {
      toast.success(t("recycleBin.restored"));
      utils.recycleBin.list.invalidate();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const permanentDeleteMutation = trpc.recycleBin.permanentDelete.useMutation({
    onSuccess: () => {
      toast.success(t("recycleBin.permanentlyDeleted"));
      utils.recycleBin.list.invalidate();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const emptyAllMutation = trpc.recycleBin.emptyAll.useMutation({
    onSuccess: () => {
      toast.success(t("recycleBin.emptied"));
      utils.recycleBin.list.invalidate();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [confirmPermanentId, setConfirmPermanentId] = useState<string | null>(null);
  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false);

  return (
    <SettingsShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Trash2 className="text-slate-600" size={24} />
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("recycleBin.title")}</h1>
          </div>
          {items.length > 0 && (
            <div>
              {showEmptyConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--primary)]">{t("recycleBin.emptyConfirm")}</span>
                  <button
                    onClick={() => {
                      emptyAllMutation.mutate();
                      setShowEmptyConfirm(false);
                    }}
                    className="px-3 py-1.5 text-sm bg-[var(--primary)] text-white rounded-lg hover:bg-[var(--accent-hover)]"
                  >
                    {t("confirm", { ns: "common" })}
                  </button>
                  <button
                    onClick={() => setShowEmptyConfirm(false)}
                    className="px-3 py-1.5 text-sm bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200"
                  >
                    {t("cancel", { ns: "common" })}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowEmptyConfirm(true)}
                  className="flex items-center gap-2 text-sm text-[var(--primary)] bg-[var(--primary)]/10 hover:bg-[var(--primary)]/10 rounded-lg px-3 py-2 transition-colors"
                >
                  <AlertTriangle size={16} />
                  {t("recycleBin.emptyAll")}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Table */}
        <div className="card overflow-x-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="spinner" />
              <span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span>
            </div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-slate-400">
              <Trash2 size={48} className="mx-auto mb-4 opacity-30" />
              <p>{t("recycleBin.empty")}</p>
            </div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">{t("recycleBin.entityType")}</th>
                  <th className="py-3 px-4">{t("recycleBin.name")}</th>
                  <th className="py-3 px-4">{t("recycleBin.deletedAt")}</th>
                  <th className="py-3 px-4">{t("actions", { ns: "common" })}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const key = `${item.entityType}-${item.entityId}`;
                  return (
                    <tr key={key} className="border-b border-slate-200/50 text-slate-600 hover:bg-slate-100/30">
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${auditEntityColors[item.entityType] || "bg-slate-100 text-slate-600"}`}>
                          {item.entityType}
                        </span>
                        <span className="ml-1 text-xs text-slate-400">#{item.entityId}</span>
                      </td>
                      <td className="py-3 px-4 text-slate-900">{item.identifier}</td>
                      <td className="py-3 px-4 text-xs text-slate-500 whitespace-nowrap">{formatTime(item.deletedAt, i18n.language)}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => restoreMutation.mutate({ entityType: item.entityType as EntityType, entityId: item.entityId })}
                            disabled={restoreMutation.isPending}
                            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 rounded px-2 py-1 transition-colors"
                          >
                            <RotateCcw size={12} />
                            {t("recycleBin.restore")}
                          </button>
                          {confirmPermanentId === key ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => {
                                  permanentDeleteMutation.mutate({ entityType: item.entityType as EntityType, entityId: item.entityId });
                                  setConfirmPermanentId(null);
                                }}
                                className="text-xs text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] rounded px-2 py-1"
                              >
                                {t("confirm", { ns: "common" })}
                              </button>
                              <button
                                onClick={() => setConfirmPermanentId(null)}
                                className="text-xs text-slate-500 hover:text-slate-700 bg-slate-100 rounded px-2 py-1"
                              >
                                {t("cancel", { ns: "common" })}
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmPermanentId(key)}
                              className="flex items-center gap-1 text-xs text-[var(--primary)] hover:text-[var(--accent-hover)] bg-[var(--primary)]/10 hover:bg-[var(--primary)]/10 rounded px-2 py-1 transition-colors"
                            >
                              <Trash2 size={12} />
                              {t("recycleBin.permanentDelete")}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </SettingsShell>
  );
}
