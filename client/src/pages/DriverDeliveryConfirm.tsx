import { useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { useBranding } from "@/config/branding";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { CheckCircle, Truck, MapPin, User, Package } from "lucide-react";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { useSignaturePad } from "@/hooks/useSignaturePad";
import { serverErrorText } from "@/lib/serverError";

export default function DriverDeliveryConfirm() {
  const branding = useBranding();
  const { t } = useTranslation("dispatch");
  const { t: tCommon } = useTranslation("common");
  const [, params] = useRoute("/driver/confirm/:token");
  const token = params?.token ?? "";

  const { canvasRef: signatureCanvasRef, signature, handlers: signatureHandlers, clear: clearSignature } = useSignaturePad({ strokeStyle: "#2563EB" });
  const [driverNotes, setDriverNotes] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  // Fetch dispatch info
  const { data, isLoading, error } = trpc.dispatch.getForConfirmation.useQuery(
    { token },
    { enabled: token.length > 0 },
  );

  const confirmMutation = trpc.dispatch.confirmDelivery.useMutation({
    onSuccess: () => {
      setConfirmed(true);
      toast.success(t("confirm.success"));
    },
    onError: (err) => {
      toast.error(serverErrorText(err));
    },
  });

  const handleConfirm = () => {
    if (!signature) {
      toast.error(t("confirm.signatureRequired"));
      return;
    }
    confirmMutation.mutate({
      token,
      customerSignature: signature,
      driverNotes: driverNotes || undefined,
    });
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="text-slate-500">{tCommon("loading")}</div>
      </div>
    );
  }

  // Error state
  if (error || !data) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 p-4">
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-900 mb-2">{t("confirm.notFound")}</h1>
          <p className="text-slate-500">{t("confirm.notFoundDesc")}</p>
        </div>
      </div>
    );
  }

  const dispatch = data.dispatch_orders;
  const customer = data.customers;
  const equipment = data.rental_fleet;

  // Already confirmed
  if (dispatch.customerConfirmedAt) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 p-4">
        <div className="text-center">
          <CheckCircle size={64} className="mx-auto text-green-500 mb-4" />
          <h1 className="text-xl font-bold text-slate-900 mb-2">{t("confirm.alreadyConfirmed")}</h1>
          <p className="text-slate-500">
            {t("confirm.confirmedOn", { date: new Date(dispatch.customerConfirmedAt).toLocaleString() })}
          </p>
        </div>
      </div>
    );
  }

  // Not in confirmable status
  if (!["in_transit", "delivered"].includes(dispatch.status)) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 p-4">
        <div className="text-center">
          <h1 className="text-xl font-bold text-slate-900 mb-2">{t("confirm.cannotConfirm")}</h1>
          <p className="text-slate-500">{t("confirm.wrongStatus", { status: dispatch.status })}</p>
        </div>
      </div>
    );
  }

  // Success state
  if (confirmed) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 p-4">
        <div className="text-center">
          <CheckCircle size={64} className="mx-auto text-green-500 mb-4" />
          <h1 className="text-xl font-bold text-slate-900 mb-2">{t("confirm.success")}</h1>
          <p className="text-slate-500">{t("confirm.thankYou")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-lg mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-bold text-slate-900">{t("confirm.title")}</h1>
            <p className="text-xs text-slate-500">{branding.companyName}</p>
          </div>
          <LanguageSwitcher />
        </div>

        {/* Dispatch Info Card */}
        <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-4 mb-4 space-y-3">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Truck size={16} className="text-slate-400" />
            <span className="font-medium">{t("confirm.orderNumber", { id: dispatch.id })}</span>
            <span className="ml-auto px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700 uppercase">
              {dispatch.orderType}
            </span>
          </div>

          {customer && (
            <div className="flex items-center gap-2 text-sm">
              <User size={16} className="text-slate-400" />
              <span className="text-slate-700">{customer.name}</span>
            </div>
          )}

          {equipment && (
            <div className="flex items-center gap-2 text-sm">
              <Package size={16} className="text-slate-400" />
              <span className="text-slate-700">{equipment.brand} {equipment.model}</span>
            </div>
          )}

          {dispatch.deliveryAddress && (
            <div className="flex items-start gap-2 text-sm">
              <MapPin size={16} className="text-slate-400 mt-0.5" />
              <span className="text-slate-700">{dispatch.deliveryAddress}</span>
            </div>
          )}
        </div>

        {/* Driver Notes */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("confirm.driverNotes")}</label>
          <textarea
            value={driverNotes}
            onChange={(e) => setDriverNotes(e.target.value)}
            className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900 h-20 resize-none"
            placeholder={t("confirm.notesPlaceholder")}
          />
        </div>

        {/* Signature */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">{t("confirm.customerSignature")}</label>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-2">
            <canvas
              ref={signatureCanvasRef}
              className="w-full bg-[var(--surface-container-lowest)] rounded-lg touch-none"
              style={{ height: "200px" }}
              {...signatureHandlers}
            />
          </div>
          <button onClick={clearSignature} className="btn-secondary w-full mt-2">
            {t("confirm.clearSignature")}
          </button>
        </div>

        {/* Confirm Button */}
        <button
          onClick={handleConfirm}
          disabled={confirmMutation.isPending || !signature}
          className="btn-primary w-full py-4 text-lg font-semibold disabled:opacity-50"
        >
          {confirmMutation.isPending ? tCommon("loading") : t("confirm.confirmDelivery")}
        </button>
      </div>
    </div>
  );
}
