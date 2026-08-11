import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Wallet, Plus, Minus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { serverErrorText } from "@/lib/serverError";
import { canUseModulePermission } from "@/lib/modulePermissions";

/** Money we hold that belongs to the customer — a liability, not revenue. */
export default function CustomerCreditPanel({ customerId }: { customerId: number }) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  const utils = trpc.useUtils();
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const canAdjust = canUseModulePermission(myPerms, "invoices", "update");

  const { data, isLoading } = trpc.customerCredit.byCustomer.useQuery({ customerId });
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [sign, setSign] = useState<1 | -1>(1);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const refundMut = trpc.customerCredit.refund.useMutation({
    onSuccess: (res) => {
      utils.customerCredit.byCustomer.invalidate({ customerId });
      utils.customerCredit.overview.invalidate();
      setRefundOpen(false);
      setRefundAmount("");
      setRefundReason("");
      toast.success(t("credit.refunded", { balance: res.balance.toFixed(2) }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const adjustMut = trpc.customerCredit.adjust.useMutation({
    onSuccess: () => {
      utils.customerCredit.byCustomer.invalidate({ customerId });
      utils.customerCredit.overview.invalidate();
      setAdjustOpen(false);
      setAmount("");
      setReason("");
      toast.success(t("credit.adjusted"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const fmtMoney = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (d: Date | string | null) =>
    d ? new Date(d).toLocaleDateString(i18n.language === "zh" ? "zh-CN" : "en-CA") : "—";

  if (isLoading) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="h-5 w-32 bg-slate-100 rounded animate-pulse" />
      </div>
    );
  }

  const balance = data?.balance ?? 0;
  const entries = data?.entries ?? [];

  // A customer who has never had credit gets no panel at all rather than an
  // empty box — the page is long enough already.
  if (balance === 0 && entries.length === 0 && !canAdjust) return null;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Wallet size={16} /> {t("credit.title")}
          </h2>
          <p className="text-xs text-slate-500 mt-1">{t("credit.subtitle")}</p>
        </div>
        <div className="text-right">
          <div className={`text-2xl font-bold tabular-nums ${balance > 0 ? "text-emerald-700" : "text-slate-400"}`}>
            {fmtMoney(balance)}
          </div>
          {canAdjust && (
            <div className="flex items-center gap-3 justify-end mt-1">
              {balance > 0.005 && (
                <button
                  type="button"
                  onClick={() => { setRefundOpen((v) => !v); setAdjustOpen(false); }}
                  className="text-xs text-[var(--primary)] hover:underline"
                >
                  {t("credit.refund")}
                </button>
              )}
              <button
                type="button"
                onClick={() => { setAdjustOpen((v) => !v); setRefundOpen(false); }}
                className="text-xs text-[var(--primary)] hover:underline"
              >
                {t("credit.adjust")}
              </button>
            </div>
          )}
        </div>
      </div>

      {adjustOpen && canAdjust && (
        <div className="border border-slate-200 rounded-lg p-3 space-y-3 bg-slate-50">
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg overflow-hidden border border-slate-300">
              <button
                type="button"
                onClick={() => setSign(1)}
                className={`px-3 py-1.5 text-sm flex items-center gap-1 ${sign === 1 ? "bg-emerald-600 text-white" : "bg-white text-slate-600"}`}
              >
                <Plus size={14} /> {t("credit.increase")}
              </button>
              <button
                type="button"
                onClick={() => setSign(-1)}
                className={`px-3 py-1.5 text-sm flex items-center gap-1 ${sign === -1 ? "bg-red-600 text-white" : "bg-white text-slate-600"}`}
              >
                <Minus size={14} /> {t("credit.decrease")}
              </button>
            </div>
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-32 tabular-nums"
            />
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("credit.reasonPlaceholder")}
            className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-full"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={adjustMut.isPending || !amount || reason.trim().length < 3}
              onClick={() => adjustMut.mutate({
                customerId,
                amount: sign * Math.abs(parseFloat(amount || "0")),
                reason: reason.trim(),
              })}
              className="btn-primary text-sm px-3 py-1.5 disabled:opacity-50"
            >
              {t("credit.confirmAdjust")}
            </button>
            <button
              type="button"
              onClick={() => setAdjustOpen(false)}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              {t("cancel", { ns: "common" })}
            </button>
          </div>
          <p className="text-[11px] text-slate-400">{t("credit.adjustHint")}</p>
        </div>
      )}

      {refundOpen && canAdjust && (
        <div className="border border-red-200 rounded-lg p-3 space-y-3 bg-red-50">
          <p className="text-sm font-medium text-red-800">{t("credit.refundTitle")}</p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.01"
              min="0"
              max={balance}
              value={refundAmount}
              onChange={(e) => setRefundAmount(e.target.value)}
              placeholder="0.00"
              className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-32 tabular-nums"
            />
            <button
              type="button"
              onClick={() => setRefundAmount(String(balance))}
              className="text-xs text-slate-500 hover:text-slate-700 underline"
            >
              {t("credit.refundAll")}
            </button>
          </div>
          <input
            value={refundReason}
            onChange={(e) => setRefundReason(e.target.value)}
            placeholder={t("credit.reasonPlaceholder")}
            className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm w-full"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={refundMut.isPending || !refundAmount || refundReason.trim().length < 3}
              onClick={() => refundMut.mutate({
                customerId,
                amount: Math.abs(parseFloat(refundAmount || "0")),
                reason: refundReason.trim(),
              })}
              className="bg-red-600 hover:bg-red-700 text-white rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {t("credit.confirmRefund")}
            </button>
            <button type="button" onClick={() => setRefundOpen(false)} className="text-sm text-slate-500 hover:text-slate-700">
              {t("cancel", { ns: "common" })}
            </button>
          </div>
          <p className="text-[11px] text-red-700">{t("credit.refundHint")}</p>
        </div>
      )}

      {entries.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-200">
                <th className="pb-2 font-medium">{t("credit.colDate")}</th>
                <th className="pb-2 font-medium">{t("credit.colType")}</th>
                <th className="pb-2 font-medium">{t("credit.colSource")}</th>
                <th className="pb-2 font-medium text-right">{t("credit.colAmount")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="py-2 text-slate-500 whitespace-nowrap">{fmtDate(e.updatedAt ?? e.createdAt)}</td>
                  <td className="py-2 text-slate-700">{t(`credit.type.${e.entryType}`, { defaultValue: e.entryType })}</td>
                  <td className="py-2 text-slate-500">
                    {e.rentalNumber ? (
                      <span className="font-mono text-xs">{e.rentalNumber}</span>
                    ) : (
                      <span className="text-slate-400">{e.notes || "—"}</span>
                    )}
                  </td>
                  <td className={`py-2 text-right tabular-nums font-medium ${e.amount >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {e.amount >= 0 ? "+" : "−"}{fmtMoney(Math.abs(e.amount))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-400">{t("credit.empty")}</p>
      )}
    </div>
  );
}
