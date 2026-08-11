import { useState } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { translateDynamic } from "@/lib/i18nHelpers";
import {
  Plus,
  X,
  Pencil,
  Tag,
  Users,
  DollarSign,
  CheckCircle,
  XCircle,
  Eye,
  Copy,
  Banknote,
  Check,
  Trash2,
} from "lucide-react";
import { serverErrorText } from "@/lib/serverError";

// ─── Types ──────────────────────────────────────────────────
type Tab = "promotions" | "codes" | "ledger";

const emptyPromoForm = {
  name: "",
  discountPercent: "5.00",
  commissionPercent: "5.00",
  startDate: "",
  endDate: "",
  description: "",
  maxUsesPerCode: "",
};

export default function Promotions() {
  const { t } = useTranslation("admin");
  const utils = trpc.useUtils();

  // ─── Tab state ────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("promotions");
  const [selectedPromoId, setSelectedPromoId] = useState<number | null>(null);

  // ─── Promotions ───────────────────────────────────────────
  const { data: promos, isLoading } = trpc.promotions.list.useQuery();
  const createPromo = trpc.promotions.create.useMutation({
    onSuccess: () => { utils.promotions.list.invalidate(); setCreateOpen(false); toast.success(t("promotions.createSuccess")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updatePromo = trpc.promotions.update.useMutation({
    onSuccess: () => { utils.promotions.list.invalidate(); setEditOpen(false); toast.success(t("promotions.updateSuccess")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deletePromo = trpc.promotions.delete.useMutation({
    onSuccess: () => { utils.promotions.list.invalidate(); toast.success(t("promotions.deleteSuccess")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Codes ────────────────────────────────────────────────
  const { data: codes } = trpc.promotions.listCodes.useQuery(
    selectedPromoId ? { promotionId: selectedPromoId } : undefined,
    { enabled: tab === "codes" }
  );
  const { data: drivers } = trpc.drivers.list.useQuery();
  const generateCodes = trpc.promotions.generateCodes.useMutation({
    onSuccess: (data) => {
      utils.promotions.listCodes.invalidate();
      utils.promotions.list.invalidate();
      toast.success(t("promotions.codesGenerated", { count: data.length }));
      setGenOpen(false);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateCode = trpc.promotions.updateCode.useMutation({
    onSuccess: () => { utils.promotions.listCodes.invalidate(); toast.success(t("promotions.codeUpdated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteCode = trpc.promotions.deleteCode.useMutation({
    onSuccess: () => {
      utils.promotions.listCodes.invalidate();
      utils.promotions.list.invalidate();
      toast.success(t("promotions.codeDeleted"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Ledger ───────────────────────────────────────────────
  const { data: ledger } = trpc.referralLedger.list.useQuery(
    selectedPromoId ? { promotionId: selectedPromoId } : undefined,
    { enabled: tab === "ledger" }
  );
  const { data: summary } = trpc.referralLedger.summary.useQuery(
    selectedPromoId ? { promotionId: selectedPromoId } : undefined,
    { enabled: tab === "ledger" }
  );
  const approveLedger = trpc.referralLedger.approve.useMutation({
    onSuccess: (r) => {
      utils.referralLedger.list.invalidate();
      utils.referralLedger.summary.invalidate();
      toast.success(t("promotions.approved", { count: r.updated }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const markPaidLedger = trpc.referralLedger.markPaid.useMutation({
    onSuccess: (r) => {
      utils.referralLedger.list.invalidate();
      utils.referralLedger.summary.invalidate();
      toast.success(t("promotions.markedPaid", { count: r.updated }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Dialog state ─────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [form, setForm] = useState(emptyPromoForm);
  const [editId, setEditId] = useState<number | null>(null);
  const [selectedDriverIds, setSelectedDriverIds] = useState<number[]>([]);
  const [codePrefix, setCodePrefix] = useState("DR");
  const [selectedLedgerIds, setSelectedLedgerIds] = useState<number[]>([]);

  useEscapeKey(createOpen || editOpen || genOpen, () => { setCreateOpen(false); setEditOpen(false); setGenOpen(false); });

  const F = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  // ─── Helpers ──────────────────────────────────────────────
  const statusBadge = (isActive: boolean, start: Date, end: Date) => {
    const now = new Date();
    if (!isActive) return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-slate-100 text-slate-500"><span className="w-1.5 h-1.5 rounded-full bg-slate-400" />{t("promotions.inactive")}</span>;
    if (now < start) return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-amber-100 text-amber-800"><span className="w-1.5 h-1.5 rounded-full bg-amber-600" />{t("promotions.upcoming")}</span>;
    if (now > end) return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-red-100 text-red-800"><span className="w-1.5 h-1.5 rounded-full bg-red-600" />{t("promotions.expired")}</span>;
    return <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-emerald-100 text-emerald-800"><span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />{t("promotions.active")}</span>;
  };

  const commissionBadge = (status: string) => {
    const colors: Record<string, string> = {
      pending: "bg-yellow-100 text-yellow-700",
      approved: "bg-blue-100 text-blue-700",
      paid: "bg-green-100 text-green-700",
      cancelled: "bg-red-100 text-red-700",
    };
    return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${colors[status] || "bg-slate-100 text-slate-500"}`}>{translateDynamic(t, `promotions.commission${status.charAt(0).toUpperCase() + status.slice(1)}`, { defaultValue: status })}</span>;
  };

  const fmtDate = useFormatCalendarDate();

  // ─── Render ───────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t("promotions.title")}</h1>
          <button
            onClick={() => { setForm(emptyPromoForm); setCreateOpen(true); }}
            className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> {t("promotions.create")}
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {(["promotions", "codes", "ledger"] as Tab[]).map((t2) => (
            <button
              key={t2}
              onClick={() => setTab(t2)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t2 ? "border-blue-600 text-blue-600" : "border-transparent text-slate-500 hover:text-slate-700"}`}
            >
              {t2 === "promotions" && <><Tag className="w-4 h-4 inline mr-1" />{t("promotions.tabPromotions")}</>}
              {t2 === "codes" && <><Users className="w-4 h-4 inline mr-1" />{t("promotions.tabCodes")}</>}
              {t2 === "ledger" && <><DollarSign className="w-4 h-4 inline mr-1" />{t("promotions.tabLedger")}</>}
            </button>
          ))}
        </div>

        {/* Promotion selector for codes/ledger tabs */}
        {tab !== "promotions" && (
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-slate-600">{t("promotions.selectPromotion")}:</label>
            <select
              value={selectedPromoId ?? ""}
              onChange={(e) => setSelectedPromoId(e.target.value ? Number(e.target.value) : null)}
              className="border rounded px-3 py-1.5 text-sm"
            >
              <option value="">{t("promotions.allPromotions")}</option>
              {promos?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* ─── Promotions Tab ───────────────────────────────── */}
        {tab === "promotions" && (
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left">
                <tr>
                  <th className="px-4 py-3">{t("promotions.name")}</th>
                  <th className="px-4 py-3">{t("promotions.discount")}</th>
                  <th className="px-4 py-3">{t("promotions.commission")}</th>
                  <th className="px-4 py-3">{t("promotions.period")}</th>
                  <th className="px-4 py-3">{t("promotions.codes")}</th>
                  <th className="px-4 py-3">{t("promotions.uses")}</th>
                  <th className="px-4 py-3">{t("promotions.totalCommission")}</th>
                  <th className="px-4 py-3">{t("promotions.status")}</th>
                  <th className="px-4 py-3">{t("promotions.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">{t("promotions.loading")}</td></tr>
                ) : !promos?.length ? (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">{t("promotions.empty")}</td></tr>
                ) : promos.map((p) => (
                  <tr key={p.id} className="border-t hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium">{p.name}</td>
                    <td className="px-4 py-3">{p.discountPercent}%</td>
                    <td className="px-4 py-3">{p.commissionPercent}%</td>
                    <td className="px-4 py-3 text-xs">
                      {fmtDate(p.startDate)} ~ {fmtDate(p.endDate)}
                    </td>
                    <td className="px-4 py-3">{p.stats.totalCodes}</td>
                    <td className="px-4 py-3">{p.stats.totalUses}</td>
                    <td className="px-4 py-3">{formatCurrency(Number(p.stats.totalCommission))}</td>
                    <td className="px-4 py-3">{statusBadge(p.isActive, new Date(p.startDate), new Date(p.endDate))}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button
                          onClick={() => { setSelectedPromoId(p.id); setTab("codes"); }}
                          className="p-1 text-blue-600 hover:bg-blue-50 rounded" title={t("promotions.viewCodes")}
                        ><Eye className="w-4 h-4" /></button>
                        <button
                          onClick={() => {
                            setEditId(p.id);
                            setForm({
                              name: p.name,
                              discountPercent: p.discountPercent,
                              commissionPercent: p.commissionPercent,
                              startDate: fmtDate(p.startDate),
                              endDate: fmtDate(p.endDate),
                              description: p.description || "",
                              maxUsesPerCode: p.maxUsesPerCode?.toString() || "",
                            });
                            setEditOpen(true);
                          }}
                          className="tap-target p-1 text-slate-600 hover:bg-slate-100 rounded" title={t("promotions.edit")}
                        ><Pencil className="w-4 h-4" /></button>
                        <button
                          onClick={() => { if (confirm(t("promotions.deleteConfirm"))) deletePromo.mutate({ id: p.id }); }}
                          className="tap-target p-1 text-red-600 hover:bg-red-50 rounded" title={t("promotions.delete")}
                        ><XCircle className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ─── Codes Tab ────────────────────────────────────── */}
        {tab === "codes" && (
          <>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  if (!selectedPromoId && promos?.length) {
                    setSelectedPromoId(promos[0].id);
                  }
                  setSelectedDriverIds([]);
                  setCodePrefix("DR");
                  setGenOpen(true);
                }}
                className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700"
                disabled={!selectedPromoId && !promos?.length}
              >
                <Plus className="w-4 h-4" /> {t("promotions.generateCodes")}
              </button>
            </div>
            <div className="bg-white rounded-lg shadow overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left">
                  <tr>
                    <th className="px-4 py-3">{t("promotions.code")}</th>
                    <th className="px-4 py-3">{t("promotions.operator")}</th>
                    <th className="px-4 py-3">{t("promotions.uses")}</th>
                    <th className="px-4 py-3">{t("promotions.totalCommission")}</th>
                    <th className="px-4 py-3">{t("promotions.status")}</th>
                    <th className="px-4 py-3">{t("promotions.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {!codes?.length ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">{t("promotions.noCodes")}</td></tr>
                  ) : codes.map((c) => (
                    <tr key={c.code.id} className="border-t hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono font-medium">
                        {c.code.code}
                        <button
                          onClick={() => { navigator.clipboard.writeText(c.code.code); toast.success(t("promotions.codeCopied")); }}
                          className="ml-2 text-slate-400 hover:text-slate-600"
                        ><Copy className="w-3.5 h-3.5 inline" /></button>
                      </td>
                      <td className="px-4 py-3">{c.driver?.name || "-"}</td>
                      <td className="px-4 py-3">{c.code.totalUses}</td>
                      <td className="px-4 py-3">{formatCurrency(Number(c.code.totalCommission))}</td>
                      <td className="px-4 py-3">
                        {c.code.isActive
                          ? <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-emerald-100 text-emerald-800"><span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />{t("promotions.active")}</span>
                          : <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide bg-slate-100 text-slate-500"><span className="w-1.5 h-1.5 rounded-full bg-slate-400" />{t("promotions.inactive")}</span>
                        }
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => updateCode.mutate({ id: c.code.id, isActive: !c.code.isActive })}
                            className={`p-1 rounded ${c.code.isActive ? "text-red-600 hover:bg-red-50" : "text-green-600 hover:bg-green-50"}`}
                            title={c.code.isActive ? t("promotions.deactivate") : t("promotions.activate")}
                          >
                            {c.code.isActive ? <XCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => { if (confirm(t("promotions.deleteCodeConfirm"))) deleteCode.mutate({ id: c.code.id }); }}
                            className="p-1 rounded text-slate-400 hover:text-[var(--primary)] hover:bg-red-50"
                            title={t("promotions.deleteCode")}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ─── Ledger Tab ───────────────────────────────────── */}
        {tab === "ledger" && (
          <>
            {/* Summary cards */}
            {summary && summary.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {summary.map((s) => (
                  <div key={s.driverId} className="bg-white rounded-lg shadow p-4">
                    <div className="text-sm font-medium text-slate-600">{s.driverName || `Driver #${s.driverId}`}</div>
                    <div className="mt-2 text-xl font-bold">{formatCurrency(Number(s.totalCommission))}</div>
                    <div className="mt-1 flex gap-2 text-xs">
                      <span className="text-yellow-600">{t("promotions.pending")}: {formatCurrency(Number(s.pendingCommission))}</span>
                      <span className="text-blue-600">{t("promotions.approvedShort")}: {formatCurrency(Number(s.approvedCommission))}</span>
                      <span className="text-green-600">{t("promotions.paidShort")}: {formatCurrency(Number(s.paidCommission))}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Batch actions */}
            {selectedLedgerIds.length > 0 && (
              <div className="flex gap-2 items-center bg-blue-50 px-4 py-2 rounded-lg">
                <span className="text-sm">{t("promotions.selected", { count: selectedLedgerIds.length })}</span>
                <button
                  onClick={() => approveLedger.mutate({ ids: selectedLedgerIds }, { onSuccess: () => setSelectedLedgerIds([]) })}
                  className="flex items-center gap-1 bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700"
                ><Check className="w-3.5 h-3.5" /> {t("promotions.approveSelected")}</button>
                <button
                  onClick={() => markPaidLedger.mutate({ ids: selectedLedgerIds }, { onSuccess: () => setSelectedLedgerIds([]) })}
                  className="flex items-center gap-1 bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700"
                ><Banknote className="w-3.5 h-3.5" /> {t("promotions.markPaidSelected")}</button>
              </div>
            )}

            <div className="bg-white rounded-lg shadow overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left">
                  <tr>
                    <th className="px-4 py-3 w-8">
                      <input type="checkbox" onChange={(e) => {
                        if (e.target.checked) setSelectedLedgerIds(ledger?.map(l => l.ledger.id) || []);
                        else setSelectedLedgerIds([]);
                      }} />
                    </th>
                    <th className="px-4 py-3">{t("promotions.rentalNumber")}</th>
                    <th className="px-4 py-3">{t("promotions.customer")}</th>
                    <th className="px-4 py-3">{t("promotions.operator")}</th>
                    <th className="px-4 py-3">{t("promotions.rentalFee")}</th>
                    <th className="px-4 py-3">{t("promotions.discountAmt")}</th>
                    <th className="px-4 py-3">{t("promotions.commissionAmt")}</th>
                    <th className="px-4 py-3">{t("promotions.commissionStatus")}</th>
                    <th className="px-4 py-3">{t("promotions.date")}</th>
                  </tr>
                </thead>
                <tbody>
                  {!ledger?.length ? (
                    <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">{t("promotions.noLedger")}</td></tr>
                  ) : ledger.map((l) => (
                    <tr key={l.ledger.id} className="border-t hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedLedgerIds.includes(l.ledger.id)}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedLedgerIds([...selectedLedgerIds, l.ledger.id]);
                            else setSelectedLedgerIds(selectedLedgerIds.filter(id => id !== l.ledger.id));
                          }}
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{l.rental?.rentalNumber || "-"}</td>
                      <td className="px-4 py-3">{l.customer?.name || "-"}</td>
                      <td className="px-4 py-3">{l.driver?.name || "-"}</td>
                      <td className="px-4 py-3">{formatCurrency(Number(l.ledger.rentalFee))}</td>
                      <td className="px-4 py-3 text-red-600">-{formatCurrency(Number(l.ledger.discountAmount))}</td>
                      <td className="px-4 py-3 text-green-600">{formatCurrency(Number(l.ledger.commissionAmount))}</td>
                      <td className="px-4 py-3">{commissionBadge(l.ledger.commissionStatus)}</td>
                      <td className="px-4 py-3 text-xs">{fmtDate(l.ledger.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* ─── Create Promotion Dialog ────────────────────────── */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setCreateOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">{t("promotions.createTitle")}</h2>
              <button onClick={() => setCreateOpen(false)}><X className="w-5 h-5" /></button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">{t("promotions.name")} *</label>
                <input value={form.name} onChange={F("name")} className="w-full border rounded px-3 py-2" placeholder={t("promotions.namePlaceholder")} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("promotions.discount")} %</label>
                  <input value={form.discountPercent} onChange={F("discountPercent")} className="w-full border rounded px-3 py-2" type="number" step="0.01" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("promotions.commission")} %</label>
                  <input value={form.commissionPercent} onChange={F("commissionPercent")} className="w-full border rounded px-3 py-2" type="number" step="0.01" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("promotions.startDate")} *</label>
                  <input value={form.startDate} onChange={F("startDate")} className="w-full border rounded px-3 py-2" type="date" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("promotions.endDate")} *</label>
                  <input value={form.endDate} onChange={F("endDate")} className="w-full border rounded px-3 py-2" type="date" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t("promotions.maxUses")}</label>
                <input value={form.maxUsesPerCode} onChange={F("maxUsesPerCode")} className="w-full border rounded px-3 py-2" type="number" placeholder={t("promotions.unlimited")} />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t("promotions.description")}</label>
                <textarea value={form.description} onChange={F("description")} className="w-full border rounded px-3 py-2" rows={2} />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t">
              <button onClick={() => setCreateOpen(false)} className="px-4 py-2 border rounded">{t("promotions.cancel")}</button>
              <button
                onClick={() => createPromo.mutate({
                  name: form.name,
                  discountPercent: form.discountPercent,
                  commissionPercent: form.commissionPercent,
                  startDate: form.startDate,
                  endDate: form.endDate,
                  maxUsesPerCode: form.maxUsesPerCode ? Number(form.maxUsesPerCode) : undefined,
                  description: form.description || undefined,
                })}
                disabled={!form.name || !form.startDate || !form.endDate || createPromo.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >{t("promotions.save")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit Promotion Dialog ──────────────────────────── */}
      {editOpen && editId && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setEditOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">{t("promotions.editTitle")}</h2>
              <button onClick={() => setEditOpen(false)}><X className="w-5 h-5" /></button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">{t("promotions.name")}</label>
                <input value={form.name} onChange={F("name")} className="w-full border rounded px-3 py-2" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("promotions.discount")} %</label>
                  <input value={form.discountPercent} onChange={F("discountPercent")} className="w-full border rounded px-3 py-2" type="number" step="0.01" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("promotions.commission")} %</label>
                  <input value={form.commissionPercent} onChange={F("commissionPercent")} className="w-full border rounded px-3 py-2" type="number" step="0.01" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">{t("promotions.startDate")}</label>
                  <input value={form.startDate} onChange={F("startDate")} className="w-full border rounded px-3 py-2" type="date" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">{t("promotions.endDate")}</label>
                  <input value={form.endDate} onChange={F("endDate")} className="w-full border rounded px-3 py-2" type="date" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t("promotions.description")}</label>
                <textarea value={form.description} onChange={F("description")} className="w-full border rounded px-3 py-2" rows={2} />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t">
              <button onClick={() => setEditOpen(false)} className="px-4 py-2 border rounded">{t("promotions.cancel")}</button>
              <button
                onClick={() => updatePromo.mutate({
                  id: editId,
                  name: form.name || undefined,
                  discountPercent: form.discountPercent || undefined,
                  commissionPercent: form.commissionPercent || undefined,
                  startDate: form.startDate || undefined,
                  endDate: form.endDate || undefined,
                  description: form.description || undefined,
                })}
                disabled={updatePromo.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >{t("promotions.save")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Generate Codes Dialog ──────────────────────────── */}
      {genOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setGenOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">{t("promotions.generateCodesTitle")}</h2>
              <button onClick={() => setGenOpen(false)}><X className="w-5 h-5" /></button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">{t("promotions.selectPromotion")} *</label>
                <select
                  value={selectedPromoId ?? ""}
                  onChange={(e) => setSelectedPromoId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full border rounded px-3 py-2"
                >
                  <option value="">{t("promotions.selectPromotion")}...</option>
                  {promos?.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t("promotions.codePrefix")}</label>
                <input value={codePrefix} onChange={(e) => setCodePrefix(e.target.value)} className="w-full border rounded px-3 py-2" placeholder="DR" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">{t("promotions.selectOperators")}</label>
                <div className="max-h-60 overflow-y-auto border rounded p-2 space-y-1">
                  {drivers?.filter((o) => o.isActive).map((op) => (
                    <label key={op.id} className="flex items-center gap-2 px-2 py-1 hover:bg-slate-50 rounded cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedDriverIds.includes(op.id)}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedDriverIds([...selectedDriverIds, op.id]);
                          else setSelectedDriverIds(selectedDriverIds.filter(id => id !== op.id));
                        }}
                      />
                      <span className="text-sm">{op.name}</span>
                      {op.phone && <span className="text-xs text-slate-400">{op.phone}</span>}
                    </label>
                  ))}
                </div>
                {drivers && (
                  <button
                    onClick={() => setSelectedDriverIds(drivers.filter((o) => o.isActive).map((o) => o.id))}
                    className="text-xs text-blue-600 mt-1 hover:underline"
                  >{t("promotions.selectAll")}</button>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t">
              <button onClick={() => setGenOpen(false)} className="px-4 py-2 border rounded">{t("promotions.cancel")}</button>
              <button
                onClick={() => selectedPromoId && generateCodes.mutate({
                  promotionId: selectedPromoId,
                  driverIds: selectedDriverIds,
                  codePrefix: codePrefix || undefined,
                })}
                disabled={!selectedPromoId || selectedDriverIds.length === 0 || generateCodes.isPending}
                className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
              >{t("promotions.generate")}</button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
