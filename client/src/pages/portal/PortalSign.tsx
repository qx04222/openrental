import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import PortalLayout from "./PortalLayout";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CheckCircle, FileText, ArrowLeft } from "lucide-react";
import { useSignaturePad } from "@/hooks/useSignaturePad";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";

export default function PortalSign() {
  const { t } = useTranslation("portal");
  const fmtDate = useFormatCalendarDate();
  const [, params] = useRoute("/portal/sign/:rentalId");
  const [, setLocation] = useLocation();
  const rentalId = params?.rentalId ? Number(params.rentalId) : 0;

  const { canvasRef: signatureCanvasRef, signature, handlers: signatureHandlers, clear: clearSig } = useSignaturePad();
  const [signed, setSigned] = useState(false);

  const { data: order, isLoading } = trpc.customerPortal.orderDetail.useQuery(
    { id: rentalId },
    { enabled: rentalId > 0 },
  );

  const signMut = trpc.customerPortal.signContract.useMutation({
    onSuccess: () => { setSigned(true); toast.success(t("sign.success")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const submit = () => {
    if (!signature) { toast.error(t("sign.required")); return; }
    signMut.mutate({ rentalId, signature });
  };

  if (isLoading) {
    return <PortalLayout><div className="flex items-center justify-center py-12"><div className="spinner" /></div></PortalLayout>;
  }

  if (!order) {
    return (
      <PortalLayout>
        <div className="text-center py-12">
          <h2 className="text-xl font-bold text-slate-900 mb-2">{t("sign.notFound")}</h2>
          <button onClick={() => setLocation("/portal/orders")} className="text-[var(--primary)] underline">{t("sign.backToOrders")}</button>
        </div>
      </PortalLayout>
    );
  }

  if (signed || order.contractSignedAt) {
    return (
      <PortalLayout>
        <div className="max-w-md mx-auto text-center py-12">
          <CheckCircle size={64} className="mx-auto text-green-500 mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">{t("sign.alreadySigned")}</h2>
          <p className="text-slate-500 mb-6">
            {t("sign.signedOn", { date: new Date(order.contractSignedAt || Date.now()).toLocaleString() })}
          </p>
          {order.contractUrl && (
            <a
              href={order.contractUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] rounded-lg transition"
            >
              <FileText size={16} /> {t("sign.viewContract")}
            </a>
          )}
          <div className="mt-4">
            <button onClick={() => setLocation("/portal/orders")} className="text-sm text-slate-500 hover:text-slate-900 underline">
              {t("sign.backToOrders")}
            </button>
          </div>
        </div>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout>
      <div className="max-w-2xl mx-auto space-y-4">
        <button
          onClick={() => setLocation("/portal/orders")}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft size={14} /> {t("sign.backToOrders")}
        </button>

        <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5">
          <h1 className="text-xl font-bold text-slate-900 mb-1">{t("sign.title")}</h1>
          <p className="text-sm text-slate-500 mb-4">
            {order.rentalNumber || `#${order.id}`} · {order.equipmentDescription || "-"}
          </p>

          <div className="space-y-2 text-sm text-slate-600 border-t border-slate-200 pt-4">
            <div className="flex justify-between"><span>{t("sign.startDate")}</span><span className="text-slate-900 font-medium">{fmtDate(order.startDate)}</span></div>
            <div className="flex justify-between"><span>{t("sign.endDate")}</span><span className="text-slate-900 font-medium">{fmtDate(order.endDate)}</span></div>
            <div className="flex justify-between"><span>{t("sign.totalCost")}</span><span className="text-slate-900 font-bold">${order.totalAmount || "0"}</span></div>
          </div>
        </div>

        {order.contractUrl && (
          <a
            href={order.contractUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center px-4 py-3 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
          >
            <FileText size={16} className="inline mr-2" /> {t("sign.previewContract")}
          </a>
        )}

        <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5 space-y-3">
          <label className="block text-sm font-medium text-slate-700">{t("sign.signHere")}</label>
          <div className="bg-slate-50 rounded-lg border border-slate-300 p-2">
            <canvas
              ref={signatureCanvasRef}
              className="w-full bg-white rounded touch-none"
              style={{ height: "220px" }}
              {...signatureHandlers}
            />
          </div>
          <div className="flex gap-2">
            <button onClick={clearSig} className="flex-1 px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition">
              {t("sign.clear")}
            </button>
            <button
              onClick={submit}
              disabled={!signature || signMut.isPending}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] disabled:bg-slate-300 disabled:cursor-not-allowed rounded-lg transition"
            >
              {signMut.isPending ? t("sign.submitting") : t("sign.submit")}
            </button>
          </div>
          <p className="text-xs text-slate-400">{t("sign.legalNotice")}</p>
        </div>
      </div>
    </PortalLayout>
  );
}
