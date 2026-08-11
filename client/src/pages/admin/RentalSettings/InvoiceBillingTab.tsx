import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Save, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";

interface FormState {
  invoice_language: string;
  invoice_payment_terms: string;
  invoice_due_days: string;
  invoice_footer_notes: string;
  invoice_auto_send: string;
  order_confirmation_auto_send: string;
  late_fee_percentage: string;
  late_fee_daily_rate_pct: string;
  late_fee_grace_hours: string;
}

const DEFAULTS: FormState = {
  invoice_language: "en",
  invoice_payment_terms: "Net 30",
  invoice_due_days: "30",
  invoice_footer_notes: "",
  invoice_auto_send: "false",
  order_confirmation_auto_send: "false",
  late_fee_percentage: "0",
  late_fee_daily_rate_pct: "150",
  late_fee_grace_hours: "24",
};

export default function InvoiceBillingTab() {
  const { t } = useTranslation("admin");
  const lateFeeEnabled = useFeatureFlag("late_fee_auto");
  const { data: rentalSettings, refetch } = trpc.rentalSettings.getAll.useQuery();
  const { data: siteSettings } = trpc.siteSettings.getAll.useQuery();
  const updateSetting = trpc.rentalSettings.update.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!rentalSettings) return;
    const map = Object.fromEntries(rentalSettings.map((s) => [s.key, s.value]));
    setForm({
      invoice_language: map["invoice_language"] || DEFAULTS.invoice_language,
      invoice_payment_terms: map["invoice_payment_terms"] || DEFAULTS.invoice_payment_terms,
      invoice_due_days: map["invoice_due_days"] || DEFAULTS.invoice_due_days,
      invoice_footer_notes: map["invoice_footer_notes"] || DEFAULTS.invoice_footer_notes,
      invoice_auto_send: map["invoice_auto_send"] || DEFAULTS.invoice_auto_send,
      order_confirmation_auto_send: map["order_confirmation_auto_send"] || DEFAULTS.order_confirmation_auto_send,
      late_fee_percentage: map["late_fee_percentage"] || DEFAULTS.late_fee_percentage,
      late_fee_daily_rate_pct: map["late_fee_daily_rate_pct"] || DEFAULTS.late_fee_daily_rate_pct,
      late_fee_grace_hours: map["late_fee_grace_hours"] || DEFAULTS.late_fee_grace_hours,
    });
    setDirty(false);
  }, [rentalSettings]);

  const updateField = (key: keyof FormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    const promises = Object.entries(form).map(([key, value]) =>
      updateSetting.mutateAsync({ key, value })
    );
    await Promise.all(promises);
    toast.success(t("rentalSettings.save"));
    setDirty(false);
  };

  const gstNumber = siteSettings?.["gstHstNumber"] || "";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">{t("invoiceBilling.title")}</h3>
          <p className="text-sm text-slate-500 mt-1">
            {t("invoiceBilling.description")}
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={!dirty || updateSetting.isPending}
          className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50"
        >
          <Save size={16} />
          {updateSetting.isPending ? t("invoiceBilling.saving") : t("invoiceBilling.saveChanges")}
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 shadow-sm bg-white divide-y divide-slate-100">
        {/* Invoice Language */}
        <div className="p-4 sm:p-6">
          <div className="max-w-xs">
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("invoiceBilling.invoiceLanguage")}</label>
            <select
              value={form.invoice_language}
              onChange={(e) => updateField("invoice_language", e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
            >
              <option value="en">{t("invoiceBilling.langEn")}</option>
              <option value="zh">{t("invoiceBilling.langZh")}</option>
              <option value="auto">{t("invoiceBilling.langAuto")}</option>
            </select>
            <p className="text-xs text-slate-500 mt-1">{t("invoiceBilling.invoiceLanguageHint")}</p>
          </div>
        </div>

        {/* Payment Terms */}
        <div className="p-4 sm:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("invoiceBilling.paymentTerms")}</label>
              <input
                type="text"
                value={form.invoice_payment_terms}
                onChange={(e) => updateField("invoice_payment_terms", e.target.value)}
                placeholder={t("invoiceBilling.paymentTermsPlaceholder")}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
              />
              <p className="text-xs text-slate-500 mt-1">{t("invoiceBilling.paymentTermsHint")}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("invoiceBilling.dueDays")}</label>
              <input
                type="number"
                min="0"
                value={form.invoice_due_days}
                onChange={(e) => updateField("invoice_due_days", e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
              />
              <p className="text-xs text-slate-500 mt-1">{t("invoiceBilling.dueDaysHint")}</p>
            </div>
          </div>
        </div>

        {/* Late Fee */}
        <div className="p-4 sm:p-6">
          <div className="max-w-xs">
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("invoiceBilling.lateFeePercentage")}</label>
            <div className="relative">
              <input
                type="number"
                min="0"
                max="100"
                step="0.5"
                value={form.late_fee_percentage}
                onChange={(e) => updateField("late_fee_percentage", e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 pr-8 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">{t("invoiceBilling.lateFeeHint")}</p>
          </div>
        </div>

        {/* Automatic Late Fee Settings (late_fee_auto feature flag) */}
        {lateFeeEnabled && (
          <div className="p-4 sm:p-6 space-y-4 bg-amber-50 border-l-4 border-amber-400">
            <div>
              <h4 className="text-sm font-semibold text-slate-900">{t("billing.lateFeeSettings")}</h4>
              <p className="text-xs text-slate-500 mt-0.5">
                Applied automatically when a rental is returned past its end date.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Daily Rate Multiplier (%)
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={form.late_fee_daily_rate_pct}
                    onChange={(e) => updateField("late_fee_daily_rate_pct", e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 pr-8 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  150 = 1.5× the daily base rate per overdue day.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Grace Period (hours)
                </label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={form.late_fee_grace_hours}
                  onChange={(e) => updateField("late_fee_grace_hours", e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Hours after end date before fees start. Default: 24 h.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Footer Notes */}
        <div className="p-4 sm:p-6">
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("invoiceBilling.footerNotes")}</label>
          <textarea
            value={form.invoice_footer_notes}
            onChange={(e) => updateField("invoice_footer_notes", e.target.value)}
            rows={3}
            placeholder={t("invoiceBilling.footerNotesPlaceholder")}
            className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm resize-none focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
          />
          <p className="text-xs text-slate-500 mt-1">{t("invoiceBilling.footerNotesHint")}</p>
        </div>

        {/* Auto-Send Toggles */}
        <div className="p-4 sm:p-6 space-y-4">
          <h4 className="text-sm font-medium text-slate-900">{t("invoiceBilling.automation")}</h4>
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-sm text-slate-700">{t("invoiceBilling.autoSendInvoice")}</span>
              <p className="text-xs text-slate-500">{t("invoiceBilling.autoSendInvoiceHint")}</p>
            </div>
            <button
              type="button"
              onClick={() => updateField("invoice_auto_send", form.invoice_auto_send === "true" ? "false" : "true")}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                form.invoice_auto_send === "true" ? "bg-[var(--primary)]" : "bg-slate-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  form.invoice_auto_send === "true" ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </label>
          <label className="flex items-center justify-between cursor-pointer">
            <div>
              <span className="text-sm text-slate-700">{t("invoiceBilling.autoSendConfirmation")}</span>
              <p className="text-xs text-slate-500">{t("invoiceBilling.autoSendConfirmationHint")}</p>
            </div>
            <button
              type="button"
              onClick={() => updateField("order_confirmation_auto_send", form.order_confirmation_auto_send === "true" ? "false" : "true")}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                form.order_confirmation_auto_send === "true" ? "bg-[var(--primary)]" : "bg-slate-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  form.order_confirmation_auto_send === "true" ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </label>
        </div>

        {/* GST/HST Number (read-only) */}
        <div className="p-4 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">{t("invoiceBilling.gstHstNumber")}</label>
              <p className="text-sm text-slate-900 font-mono">
                {gstNumber || <span className="text-slate-400 italic">{t("invoiceBilling.notConfigured")}</span>}
              </p>
            </div>
            <Link
              href="/admin/site-settings"
              className="text-sm text-[var(--primary)] hover:underline flex items-center gap-1"
            >
              {t("invoiceBilling.editInSiteSettings")} <ExternalLink size={14} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
