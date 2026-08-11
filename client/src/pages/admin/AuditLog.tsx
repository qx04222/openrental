import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { computeDiff, type DiffEntry } from "@/lib/jsonDiff";
import { Shield, RefreshCw, X, ChevronLeft, ChevronRight } from "lucide-react";
import { auditActionKey, auditEntityKey, auditFallbackLabel } from "@/lib/auditPresentation";
import { translateDynamic } from "@/lib/i18nHelpers";

// ─── Helpers ──────────────────────────────────────────────────

function formatTime(date: Date | string, locale: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function parseChanges(changesStr: string | null | undefined): Record<string, unknown> | null {
  if (!changesStr) return null;
  try {
    return JSON.parse(changesStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Diff viewer ──────────────────────────────────────────────

function DiffStatusBadge({ status }: { status: DiffEntry["status"] }) {
  const { t } = useTranslation("admin");
  const map: Record<DiffEntry["status"], string> = {
    added: "bg-green-100 text-green-800",
    removed: "bg-red-100 text-red-700",
    changed: "bg-yellow-100 text-yellow-800",
    unchanged: "bg-slate-100 text-slate-500",
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold uppercase ${map[status]}`}>
      {t(`auditLog.diffStatus.${status}`)}
    </span>
  );
}

function renderValue(v: unknown, noneLabel: string): string {
  if (v === undefined) return noneLabel;
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function DiffViewer({ changes }: { changes: string | null | undefined }) {
  const { t } = useTranslation("admin");
  const parsed = parseChanges(changes);

  if (!parsed) {
    return (
      <p className="text-slate-400 text-sm italic py-4 text-center">{t("auditLog.noChangeData")}</p>
    );
  }

  // The changes field uses { field: { old, new } } shape from the existing app
  // Try that shape first; fall back to generic before/after diff
  const keys = Object.keys(parsed);
  const isOldNewShape = keys.length > 0 && keys.every(
    (k) => parsed[k] !== null && typeof parsed[k] === "object" && ("old" in (parsed[k] as object) || "new" in (parsed[k] as object))
  );

  if (isOldNewShape) {
    return (
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="py-2 pr-3 font-semibold">{t("auditLog.field")}</th>
            <th className="py-2 pr-3 font-semibold">{t("auditLog.before")}</th>
            <th className="py-2 pr-3 font-semibold">{t("auditLog.after")}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((field) => {
            const entry = parsed[field] as { old?: unknown; new?: unknown };
            return (
              <tr key={field} className="border-b border-slate-100">
                <td className="py-2 pr-3 font-mono text-xs text-slate-700">{field}</td>
                <td className="py-2 pr-3 font-mono text-xs text-red-700 bg-red-50 rounded px-1">
                  {renderValue(entry.old, t("auditLog.noneValue"))}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-green-700 bg-green-50 rounded px-1">
                  {renderValue(entry.new, t("auditLog.noneValue"))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }

  // Generic before/after diff
  const diffs = computeDiff(parsed as Record<string, unknown>, {});
  if (diffs.length === 0) {
    return <p className="text-slate-400 text-sm italic py-4 text-center">{t("auditLog.noDifferences")}</p>;
  }

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-left text-slate-500 border-b border-slate-200">
          <th className="py-2 pr-3 font-semibold">{t("auditLog.field")}</th>
          <th className="py-2 pr-3 font-semibold">{t("auditLog.status")}</th>
          <th className="py-2 pr-3 font-semibold">{t("auditLog.before")}</th>
          <th className="py-2 pr-3 font-semibold">{t("auditLog.after")}</th>
        </tr>
      </thead>
      <tbody>
        {diffs.map((d) => (
          <tr key={d.key} className="border-b border-slate-100">
            <td className="py-2 pr-3 font-mono text-xs text-slate-700">{d.key}</td>
            <td className="py-2 pr-3"><DiffStatusBadge status={d.status} /></td>
            <td className="py-2 pr-3 font-mono text-xs text-red-700">{renderValue(d.before, t("auditLog.noneValue"))}</td>
            <td className="py-2 pr-3 font-mono text-xs text-green-700">{renderValue(d.after, t("auditLog.noneValue"))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Change diff dialog ───────────────────────────────────────

interface ChangesDialogProps {
  open: boolean;
  onClose: () => void;
  changes: string | null | undefined;
  label: string;
}

function ChangesDialog({ open, onClose, changes, label }: ChangesDialogProps) {
  const { t } = useTranslation("admin");
  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
            <Dialog.Title className="text-base font-semibold text-slate-800">
              {t("auditLog.changesTitle", { label })}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                onClick={onClose}
                className="text-slate-400 hover:text-slate-600 transition-colors"
                aria-label={t("auditLog.close")}
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <div className="overflow-y-auto px-6 py-4">
            <DiffViewer changes={changes} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Main page ────────────────────────────────────────────────

const LIMIT = 50;

export default function AuditLog() {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const flagEnabled = useFeatureFlag("audit_log_search");

  // Filters
  const [userId, setUserId] = useState<number | undefined>(undefined);
  const [entityType, setEntityType] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [queryText, setQueryText] = useState<string>("");
  const [offset, setOffset] = useState(0);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogChanges, setDialogChanges] = useState<string | null | undefined>(null);
  const [dialogLabel, setDialogLabel] = useState<string>("");

  const searchInput = {
    userId: userId ?? undefined,
    entityType: entityType || undefined,
    action: action || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    query: queryText || undefined,
    limit: LIMIT,
    offset,
  };

  const { data, isLoading, refetch } = trpc.auditLog.search.useQuery(searchInput, {
    enabled: flagEnabled,
    refetchInterval: 60_000,
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const facets = data?.facets;

  function handleClear() {
    setUserId(undefined);
    setEntityType("");
    setAction("");
    setDateFrom("");
    setDateTo("");
    setQueryText("");
    setOffset(0);
  }

  function openChanges(changes: string | null | undefined, label: string) {
    setDialogChanges(changes);
    setDialogLabel(label);
    setDialogOpen(true);
  }

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;
  const actionLabel = (value: string) => translateDynamic(t, auditActionKey(value), {
    defaultValue: auditFallbackLabel(value),
  });
  const entityLabel = (value: string) => translateDynamic(t, auditEntityKey(value), {
    defaultValue: auditFallbackLabel(value),
  });

  if (!flagEnabled) {
    return (
      <SettingsShell>
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-slate-400">
          <Shield size={40} />
          <p className="text-sm">{t("auditLog.notEnabled")}</p>
        </div>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="text-slate-600" size={24} />
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">
              {t("auditLog.title")}
            </h1>
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-lg px-3 py-2 transition-colors"
          >
            <RefreshCw size={16} />
            {t("refresh", { ns: "common" })}
          </button>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-3 items-end">
          {/* User dropdown from facets */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-medium">{t("auditLog.user")}</label>
            <select
              value={userId ?? ""}
              onChange={(e) => {
                setUserId(e.target.value ? Number(e.target.value) : undefined);
                setOffset(0);
              }}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm min-w-[140px]"
            >
              <option value="">{t("auditLog.allUsers")}</option>
              {facets?.users.map((u) => (
                <option key={u.id ?? "null"} value={u.id ?? ""}>
                  {t("auditLog.userWithCount", { id: u.id, count: u.count })}
                </option>
              ))}
            </select>
          </div>

          {/* Action dropdown from facets */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-medium">{t("auditLog.action")}</label>
            <select
              value={action}
              onChange={(e) => { setAction(e.target.value); setOffset(0); }}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm min-w-[140px]"
            >
              <option value="">{t("auditLog.allActions")}</option>
              {facets?.actions.map((a) => (
                <option key={a.action} value={a.action}>
                  {t("auditLog.facetWithCount", { label: actionLabel(a.action), count: a.count })}
                </option>
              ))}
            </select>
          </div>

          {/* Entity type dropdown from facets */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-medium">{t("auditLog.entityTypeLabel")}</label>
            <select
              value={entityType}
              onChange={(e) => { setEntityType(e.target.value); setOffset(0); }}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm min-w-[140px]"
            >
              <option value="">{t("auditLog.allEntityTypes")}</option>
              {facets?.entityTypes.map((et) => (
                <option key={et.type} value={et.type}>
                  {t("auditLog.facetWithCount", { label: entityLabel(et.type), count: et.count })}
                </option>
              ))}
            </select>
          </div>

          {/* Date from */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-medium">{t("auditLog.dateFrom")}</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setOffset(0); }}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
            />
          </div>

          {/* Date to */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-medium">{t("auditLog.dateTo")}</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setOffset(0); }}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
            />
          </div>

          {/* Free text search */}
          <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
            <label className="text-xs text-slate-500 font-medium">{t("auditLog.searchLabel")}</label>
            <input
              type="text"
              placeholder={t("auditLog.searchPlaceholder")}
              value={queryText}
              onChange={(e) => { setQueryText(e.target.value); setOffset(0); }}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
            />
          </div>

          <button
            onClick={handleClear}
            className="self-end px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-100 transition-colors"
          >
            {t("auditLog.clear")}
          </button>
        </div>

        {/* Table */}
        <div className="card overflow-x-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="spinner" />
              <span className="ml-3 text-sm text-slate-500">{t("auditLog.loadingLogs")}</span>
            </div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">{t("auditLog.time")}</th>
                  <th className="py-3 px-4">{t("auditLog.user")}</th>
                  <th className="py-3 px-4">{t("auditLog.action")}</th>
                  <th className="py-3 px-4">{t("auditLog.entity")}</th>
                  <th className="py-3 px-4 hidden md:table-cell">IP</th>
                  <th className="py-3 px-4"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-slate-200/50 text-slate-600 hover:bg-slate-100/30"
                  >
                    <td className="py-3 px-4 text-slate-900 whitespace-nowrap text-xs">
                      {formatTime(row.createdAt, i18n.resolvedLanguage ?? i18n.language)}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap text-xs">
                      {row.userName ?? row.userUsername ?? (row.userId
                        ? t("auditLog.userFallback", { id: row.userId })
                        : t("auditLog.system"))}
                    </td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide bg-slate-100 text-slate-700">
                        {actionLabel(row.action)}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide bg-blue-50 text-blue-700">
                        {entityLabel(row.entityType)}
                      </span>
                      {row.entityId != null && (
                        <span className="ml-1 text-xs text-slate-400">#{row.entityId}</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-400 whitespace-nowrap hidden md:table-cell">
                      {row.ipAddress ?? "-"}
                    </td>
                    <td className="py-3 px-4">
                      <button
                        onClick={() =>
                          openChanges(
                            row.changes,
                            `${entityLabel(row.entityType)} #${row.entityId ?? "?"} — ${actionLabel(row.action)}`
                          )
                        }
                        className="text-xs text-blue-600 hover:underline whitespace-nowrap"
                      >
                        {t("auditLog.viewChanges")}
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-400 text-sm">
                      {t("auditLog.noLogs")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            {t("auditLog.showingRange", {
              from: rows.length === 0 ? 0 : offset + 1,
              to: Math.min(offset + rows.length, total),
              total,
            })}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setOffset(Math.max(0, offset - LIMIT))}
              disabled={offset === 0}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label={t("auditLog.previousPage")}
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {t("auditLog.pageOf", { current: currentPage, total: Math.max(1, totalPages) })}
            </span>
            <button
              onClick={() => setOffset(offset + LIMIT)}
              disabled={offset + LIMIT >= total}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label={t("auditLog.nextPage")}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Changes diff dialog */}
      <ChangesDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        changes={dialogChanges}
        label={dialogLabel}
      />
    </SettingsShell>
  );
}
