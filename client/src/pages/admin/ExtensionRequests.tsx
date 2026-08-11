import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { Check, X, MessageSquare } from "lucide-react";
import { adminRenewalDays } from "@shared/extensionRequestPresentation";
import { serverErrorText } from "@/lib/serverError";
import { toExtensionRequestRow } from "@/lib/extensionRequestRow";
import { canUseModulePermission } from "@/lib/modulePermissions";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  approved: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
};

export default function ExtensionRequests() {
  const { t } = useTranslation("portal");
  const utils = trpc.useUtils();
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const can = (module: Parameters<typeof canUseModulePermission>[1], action: Parameters<typeof canUseModulePermission>[2]) =>
    canUseModulePermission(myPerms, module, action);

  const { data: requests, isLoading } = trpc.extensionRequests.list.useQuery();

  const [notesOpen, setNotesOpen] = useState(false);
  const [actionType, setActionType] = useState<"approve" | "reject">("approve");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");

  const closeModal = useCallback(() => setNotesOpen(false), []);
  useEscapeKey(notesOpen, closeModal);

  const approveMut = trpc.extensionRequests.approve.useMutation({
    onSuccess: () => {
      toast.success(t("extensionRequests.approveSuccess"));
      utils.extensionRequests.list.invalidate();
      setNotesOpen(false);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const rejectMut = trpc.extensionRequests.reject.useMutation({
    onSuccess: () => {
      toast.success(t("extensionRequests.rejectSuccess"));
      utils.extensionRequests.list.invalidate();
      setNotesOpen(false);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const openAction = (id: number, type: "approve" | "reject") => {
    setSelectedId(id);
    setActionType(type);
    setNotes("");
    setNotesOpen(true);
  };

  const handleSubmit = () => {
    if (!selectedId) return;
    const payload = { id: selectedId, adminNotes: notes.trim() || undefined };
    if (actionType === "approve") {
      approveMut.mutate(payload);
    } else {
      rejectMut.mutate(payload);
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("extensionRequests.title")}</h1>

        <div className="card overflow-x-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="spinner" />
              <span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span>
            </div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">{t("extensionRequests.id")}</th>
                  <th className="py-3 px-4">{t("extensionRequests.customer")}</th>
                  <th className="py-3 px-4 hidden md:table-cell">{t("extensionRequests.rental")}</th>
                  <th className="py-3 px-4 hidden md:table-cell">{t("extensionRequests.requestedDate")}</th>
                  <th className="py-3 px-4 hidden lg:table-cell">{t("extensionRequests.reason")}</th>
                  <th className="py-3 px-4">{t("extensionRequests.status")}</th>
                  <th className="py-3 px-4">{t("extensionRequests.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {(requests || []).map((request) => {
                  const {
                    id,
                    customerName,
                    rentalNumber,
                    requestedDate,
                    rawReason,
                    status,
                  } = toExtensionRequestRow(request);
                  const renewalDays = adminRenewalDays(rawReason);
                  const reason = renewalDays === null
                    ? rawReason || "-"
                    : t("extensionRequests.adminRenewalReason", { days: renewalDays });

                  return (
                    <tr key={id} className="border-b border-slate-200/50 text-slate-600 hover:bg-slate-100/30">
                      <td className="py-3 px-4 text-slate-900 font-medium">{id}</td>
                      <td className="py-3 px-4">{customerName}</td>
                      <td className="py-3 px-4 hidden md:table-cell">{rentalNumber}</td>
                      <td className="py-3 px-4 hidden md:table-cell">{requestedDate}</td>
                      <td className="py-3 px-4 hidden lg:table-cell max-w-xs truncate">{reason}</td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${STATUS_COLORS[status] || ""}`}>
                          {t(`extensionRequests.${status}` as const, status)}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {status === "pending" && can("extensions", "update") && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => openAction(id, "approve")}
                              className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg transition"
                              aria-label={t("extensionRequests.approve")}
                              title={t("extensionRequests.approve")}
                            >
                              <Check size={16} />
                            </button>
                            <button
                              onClick={() => openAction(id, "reject")}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition"
                              aria-label={t("extensionRequests.reject")}
                              title={t("extensionRequests.reject")}
                            >
                              <X size={16} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {(!requests || requests.length === 0) && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-slate-400">
                      {t("extensionRequests.noRequests")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Notes Dialog */}
      {notesOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setNotesOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <MessageSquare size={20} />
                {actionType === "approve" ? t("extensionRequests.approve") : t("extensionRequests.reject")}
              </h2>
              <button onClick={() => setNotesOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label={t("close", { ns: "common" })}>
                <X size={20} />
              </button>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                {t("extensionRequests.notes")}
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("extensionRequests.notesPlaceholder")}
                rows={3}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)] outline-none resize-none"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setNotesOpen(false)} className="btn-secondary">
                {t("cancel", { ns: "common" })}
              </button>
              <button
                onClick={handleSubmit}
                disabled={approveMut.isPending || rejectMut.isPending}
                className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition ${
                  actionType === "approve"
                    ? "bg-green-600 hover:bg-green-700"
                    : "bg-red-600 hover:bg-red-700"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {actionType === "approve" ? t("extensionRequests.approve") : t("extensionRequests.reject")}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
