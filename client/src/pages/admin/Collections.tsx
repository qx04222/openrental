import { useState, useMemo, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { PhoneCall, Phone, ChevronDown, ChevronRight, Clock } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { serverErrorText } from "@/lib/serverError";

/**
 * The daily call list for money already owed.
 *
 * Nothing automated reaches these customers: 94 of 104 have no email address on
 * file and the SMS channel is switched off by policy. So the chase is a person
 * with a phone, and this page exists to make that one screen instead of four —
 * who to call, what they owe, how late it is, and what they said last time.
 *
 * Rows where someone already agreed a future follow-up date collapse into a
 * "waiting" section. They are still on the list and still counted; they are
 * just not today's work.
 */
export default function Collections() {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.collections.list.useQuery();

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showWaiting, setShowWaiting] = useState(false);
  const [logFor, setLogFor] = useState<{ customerId: number; name: string } | null>(null);

  const fmtMoney = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (d: Date | string | null) =>
    d ? new Date(d).toLocaleDateString(i18n.language === "zh" ? "zh-CN" : "en-CA") : "—";

  const all = useMemo(() => data?.customers ?? [], [data]);
  const due = useMemo(() => all.filter((c) => !c.waiting), [all]);
  const waiting = useMemo(() => all.filter((c) => c.waiting), [all]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderRows = (list: typeof all) =>
    list.map((c) => {
      const isOpen = expanded.has(c.customerId);
      return (
        <Fragment key={c.customerId}>
          <tr
            className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
            onClick={() => toggle(c.customerId)}
          >
            <td className="py-3 px-3 w-6 text-slate-400">
              {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </td>
            <td className="py-3 px-3">
              <Link
                href={`/admin/customers/${c.customerId}`}
                className="text-[var(--primary)] hover:underline font-medium"
                onClick={(e) => e.stopPropagation()}
              >
                {c.company || c.name}
              </Link>
              {c.company && c.name !== c.company && (
                <div className="text-xs text-slate-400">{c.name}</div>
              )}
            </td>
            <td className="py-3 px-3 whitespace-nowrap">
              {c.phone ? (
                <a
                  href={`tel:${c.phone}`}
                  className="inline-flex items-center gap-1 text-slate-700 hover:text-[var(--primary)]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Phone size={13} /> {c.phone}
                </a>
              ) : (
                <span className="text-xs text-red-600">{t("collections.noPhone")}</span>
              )}
            </td>
            <td className="py-3 px-3 text-right tabular-nums font-semibold text-red-700">
              {fmtMoney(c.totalOwed)}
            </td>
            <td className="py-3 px-3 text-right tabular-nums text-slate-500 hidden sm:table-cell">
              {c.invoiceCount}
            </td>
            <td className="py-3 px-3 text-right tabular-nums hidden sm:table-cell">
              <span className={c.oldestDaysOverdue >= 30 ? "text-red-700 font-semibold" : "text-amber-700"}>
                {t("collections.daysLate", { days: c.oldestDaysOverdue })}
              </span>
            </td>
            <td className="py-3 px-3 hidden lg:table-cell text-slate-500 max-w-[16rem]">
              {c.lastContactedAt ? (
                <>
                  <div className="whitespace-nowrap">{fmtDate(c.lastContactedAt)}</div>
                  {c.lastContactSummary && (
                    <div className="text-xs text-slate-400 truncate" title={c.lastContactSummary}>
                      {c.lastContactSummary}
                    </div>
                  )}
                </>
              ) : (
                <span className="text-xs text-slate-400">{t("collections.neverContacted")}</span>
              )}
            </td>
            <td className="py-3 px-3 text-right">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setLogFor({ customerId: c.customerId, name: c.company || c.name });
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--primary)] text-white hover:opacity-90"
              >
                <PhoneCall size={13} /> {t("collections.logContact")}
              </button>
            </td>
          </tr>
          {isOpen && (
            <tr className="bg-slate-50/60 border-b border-slate-100">
              <td />
              <td colSpan={7} className="py-3 px-3">
                <table className="text-xs w-full max-w-2xl">
                  <tbody>
                    {c.invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td className="py-1 pr-4 font-medium text-slate-700">{inv.invoiceNumber || `#${inv.id}`}</td>
                        <td className="py-1 pr-4 tabular-nums text-right">{fmtMoney(Number(inv.balanceDue))}</td>
                        <td className="py-1 pr-4 text-slate-500 whitespace-nowrap">{fmtDate(inv.dueDate)}</td>
                        <td className="py-1 text-slate-500">{t("collections.daysLate", { days: inv.daysOverdue })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {c.followUpNotes && (
                  <div className="mt-2 text-xs text-slate-500">
                    {t("collections.followUpNotes")}: {c.followUpNotes}
                  </div>
                )}
              </td>
            </tr>
          )}
        </Fragment>
      );
    });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)] flex items-center gap-3">
            <PhoneCall size={28} /> {t("collections.title")}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t("collections.subtitle")}</p>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {serverErrorText(error)}
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label={t("collections.statOutstanding")} value={fmtMoney(data?.totals.amount ?? 0)} tone="red" />
          <StatCard label={t("collections.statCustomers")} value={String(data?.totals.customerCount ?? 0)} />
          <StatCard label={t("collections.statInvoices")} value={String(data?.totals.invoiceCount ?? 0)} />
          <StatCard label={t("collections.statWaiting")} value={fmtMoney(data?.totals.waitingAmount ?? 0)} />
        </div>

        {(data?.unassigned.length ?? 0) > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="font-medium">
              {t("collections.unassignedTitle", {
                count: data!.unassigned.length,
                amount: fmtMoney(data!.totals.unassignedAmount),
              })}
            </div>
            <div className="text-xs mt-1 text-amber-800">
              {t("collections.unassignedHint")}{" "}
              {data!.unassigned.map((i) => i.invoiceNumber || `#${i.id}`).join("、")}
            </div>
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-slate-400">{t("loading", { ns: "common" })}</div>
          ) : all.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">{t("collections.empty")}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400 border-b border-slate-200 bg-slate-50">
                    <th />
                    <th className="py-3 px-3 font-medium">{t("collections.colCustomer")}</th>
                    <th className="py-3 px-3 font-medium">{t("collections.colPhone")}</th>
                    <th className="py-3 px-3 font-medium text-right">{t("collections.colOwed")}</th>
                    <th className="py-3 px-3 font-medium text-right hidden sm:table-cell">{t("collections.colInvoices")}</th>
                    <th className="py-3 px-3 font-medium text-right hidden sm:table-cell">{t("collections.colOldest")}</th>
                    <th className="py-3 px-3 font-medium hidden lg:table-cell">{t("collections.colLastContact")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {renderRows(due)}

                  {waiting.length > 0 && (
                    <tr className="bg-slate-50">
                      <td colSpan={8} className="py-2 px-3">
                        <button
                          onClick={() => setShowWaiting((v) => !v)}
                          className="inline-flex items-center gap-2 text-xs font-medium text-slate-500 hover:text-slate-800"
                        >
                          {showWaiting ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <Clock size={13} />
                          {t("collections.waitingGroup", { count: waiting.length })}
                        </button>
                      </td>
                    </tr>
                  )}
                  {showWaiting && renderRows(waiting)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {logFor && (
        <LogContactDialog
          customerId={logFor.customerId}
          customerName={logFor.name}
          onClose={() => setLogFor(null)}
          onSaved={() => {
            setLogFor(null);
            utils.collections.list.invalidate();
          }}
        />
      )}
    </DashboardLayout>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "red" }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold tabular-nums mt-1 ${tone === "red" ? "text-red-700" : "text-slate-900"}`}>
        {value}
      </div>
    </div>
  );
}

const CONTACT_TYPES = ["call", "visit", "note", "follow_up"] as const;

function LogContactDialog({
  customerId,
  customerName,
  onClose,
  onSaved,
}: {
  customerId: number;
  customerName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(["admin", "common"]);
  const [type, setType] = useState<(typeof CONTACT_TYPES)[number]>("call");
  const [summary, setSummary] = useState("");
  const [nextFollowUp, setNextFollowUp] = useState("");

  const { data: history } = trpc.collections.history.useQuery({ customerId, limit: 5 });

  const mut = trpc.collections.logContact.useMutation({
    onSuccess: () => {
      toast.success(t("collections.logged"));
      onSaved();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-bold text-slate-900">{t("collections.logContact")}</h2>
          <p className="text-sm text-slate-500">{customerName}</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">{t("collections.contactType")}</label>
          <div className="flex flex-wrap gap-2">
            {CONTACT_TYPES.map((k) => (
              <button
                key={k}
                onClick={() => setType(k)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${
                  type === k
                    ? "bg-[var(--primary)] text-white border-transparent"
                    : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                }`}
              >
                {t(`collections.contactType_${k}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">{t("collections.summary")}</label>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder={t("collections.summaryPlaceholder")}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">{t("collections.nextFollowUp")}</label>
          <input
            type="date"
            value={nextFollowUp}
            onChange={(e) => setNextFollowUp(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
          <p className="text-xs text-slate-400 mt-1">{t("collections.nextFollowUpHint")}</p>
        </div>

        {history && history.length > 0 && (
          <div className="border-t border-slate-100 pt-3">
            <div className="text-xs font-medium text-slate-600 mb-2">{t("collections.recentContacts")}</div>
            <ul className="space-y-1.5">
              {history.map((h) => (
                <li key={h.id} className="text-xs text-slate-500">
                  <span className="text-slate-400">{new Date(h.createdAt).toLocaleDateString()}</span>{" "}
                  <span className="font-medium text-slate-600">{t(`collections.contactType_${h.type}`)}</span> — {h.summary}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100"
          >
            {t("cancel", { ns: "common" })}
          </button>
          <button
            disabled={!summary.trim() || mut.isPending}
            onClick={() =>
              mut.mutate({
                customerId,
                type,
                summary: summary.trim(),
                // Date-only input, read as a local calendar date.
                nextFollowUp: nextFollowUp ? new Date(`${nextFollowUp}T12:00:00`) : null,
              })
            }
            className="px-4 py-2 rounded-lg text-sm font-medium bg-[var(--primary)] text-white disabled:opacity-40"
          >
            {mut.isPending ? t("saving", { ns: "common" }) : t("save", { ns: "common" })}
          </button>
        </div>
      </div>
    </div>
  );
}
