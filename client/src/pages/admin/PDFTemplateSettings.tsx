import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Save, FileText, Palette, Layout, FileDown } from "lucide-react";
import { serverErrorText } from "@/lib/serverError";
import { translateDynamic, type RuntimeTranslator } from "@/lib/i18nHelpers";

/** All PDF settings stored as key-value pairs in rentalSettings table */
const ALL_PDF_KEYS = [
  // Global
  "pdf_accent_color",
  "pdf_show_logo",
  "pdf_font_size",
  "pdf_page_size",
  "pdf_company_name_override",
  "pdf_company_address_override",
  "pdf_company_phone_override",
  "pdf_company_email_override",
  // Per-doc footers
  "pdf_order_footer",
  "pdf_dispatch_footer",
  "pdf_inspection_footer",
  "pdf_invoice_footer",
  "pdf_quote_footer",
  // Per-doc headers
  "pdf_order_header",
  "pdf_dispatch_header",
  "pdf_inspection_header",
  "pdf_invoice_header",
  "pdf_quote_header",
  // Per-doc notes
  "pdf_order_notes",
  "pdf_dispatch_notes",
  "pdf_inspection_notes",
  "pdf_invoice_notes",
  "pdf_quote_notes",
  // Invoice-specific
  "pdf_invoice_payment_terms",
  "pdf_invoice_bank_details",
  "pdf_invoice_late_fee_notice",
  // Quote-specific
  "pdf_quote_validity_text",
  "pdf_quote_terms",
];

type Tab = "global" | "invoice" | "quotation" | "order" | "dispatch" | "inspection";

export default function PDFTemplateSettings() {
  const { t } = useTranslation("admin");
  const utils = trpc.useUtils();

  const { data: rentalSettingsData } = trpc.rentalSettings.getAll.useQuery();
  const updateSetting = trpc.rentalSettings.update.useMutation({
    onSuccess: () => { utils.rentalSettings.getAll.invalidate(); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [form, setForm] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<Tab>("global");

  useEffect(() => {
    if (rentalSettingsData) {
      const map: Record<string, string> = {};
      for (const row of rentalSettingsData as Array<{ key: string; value: string }>) {
        map[row.key] = row.value;
      }
      const initial: Record<string, string> = {};
      for (const key of ALL_PDF_KEYS) {
        initial[key] = map[key] || "";
      }
      setForm(initial);
    }
  }, [rentalSettingsData]);

  const set = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    for (const key of ALL_PDF_KEYS) {
      if (form[key] !== undefined) {
        updateSetting.mutate({ key, value: form[key] });
      }
    }
    toast.success(t("pdfSettings.saved"));
  };

  const tabs: { key: Tab; label: string; icon: typeof FileText }[] = [
    { key: "global", label: t("pdfSettings.tabGlobal"), icon: Palette },
    { key: "invoice", label: t("pdfSettings.tabInvoice"), icon: FileText },
    { key: "quotation", label: t("pdfSettings.tabQuotation"), icon: FileDown },
    { key: "order", label: t("pdfSettings.tabOrder"), icon: Layout },
    { key: "dispatch", label: t("pdfSettings.tabDispatch"), icon: FileText },
    { key: "inspection", label: t("pdfSettings.tabInspection"), icon: FileText },
  ];

  const inputClass = "w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm";
  const labelClass = "text-sm font-medium text-slate-600 mb-1 block";
  const sectionClass = "space-y-4";
  const cardClass = "bg-white border border-slate-200 rounded-xl p-5 space-y-4";

  return (
    <SettingsShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileText className="text-slate-600" size={24} />
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("pdfSettings.title")}</h1>
          </div>
          <button
            onClick={handleSave}
            disabled={updateSetting.isPending}
            className="btn-primary flex items-center gap-2"
          >
            <Save size={18} />
            {t("pdfSettings.save")}
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${
                  activeTab === tab.key
                    ? "border-[var(--primary)] text-[var(--primary)]"
                    : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
                onClick={() => setActiveTab(tab.key)}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        {activeTab === "global" && (
          <div className={sectionClass}>
            <div className={cardClass}>
              <h3 className="font-semibold text-slate-900">{t("pdfSettings.brandingSection")}</h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>{t("pdfSettings.accentColor")}</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={form.pdf_accent_color || "#2563EB"}
                      onChange={(e) => set("pdf_accent_color", e.target.value)}
                      className="w-10 h-10 rounded border border-slate-300 bg-transparent cursor-pointer"
                    />
                    <input
                      type="text"
                      value={form.pdf_accent_color || "#2563EB"}
                      onChange={(e) => set("pdf_accent_color", e.target.value)}
                      placeholder="#2563EB"
                      className={inputClass}
                    />
                  </div>
                </div>

                <div>
                  <label className={labelClass}>{t("pdfSettings.showLogo")}</label>
                  <label className="flex items-center gap-2 cursor-pointer mt-2">
                    <input
                      type="checkbox"
                      checked={form.pdf_show_logo !== "false"}
                      onChange={(e) => set("pdf_show_logo", e.target.checked ? "true" : "false")}
                      className="w-4 h-4 text-[var(--primary)] rounded border-slate-300"
                    />
                    <span className="text-sm text-slate-600">
                      {form.pdf_show_logo !== "false" ? t("pdfSettings.enabled") : t("pdfSettings.disabled")}
                    </span>
                  </label>
                </div>

                <div>
                  <label className={labelClass}>{t("pdfSettings.fontSize")}</label>
                  <select
                    value={form.pdf_font_size || "normal"}
                    onChange={(e) => set("pdf_font_size", e.target.value)}
                    className={inputClass}
                  >
                    <option value="small">{t("pdfSettings.fontSmall")}</option>
                    <option value="normal">{t("pdfSettings.fontNormal")}</option>
                    <option value="large">{t("pdfSettings.fontLarge")}</option>
                  </select>
                </div>

                <div>
                  <label className={labelClass}>{t("pdfSettings.pageSize")}</label>
                  <select
                    value={form.pdf_page_size || "A4"}
                    onChange={(e) => set("pdf_page_size", e.target.value)}
                    className={inputClass}
                  >
                    <option value="A4">A4</option>
                    <option value="Letter">Letter</option>
                  </select>
                </div>
              </div>
            </div>

            <div className={cardClass}>
              <h3 className="font-semibold text-slate-900">{t("pdfSettings.companyOverrides")}</h3>
              <p className="text-xs text-slate-500">{t("pdfSettings.companyOverridesHint")}</p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>{t("pdfSettings.companyName")}</label>
                  <input type="text" value={form.pdf_company_name_override || ""} onChange={(e) => set("pdf_company_name_override", e.target.value)} placeholder={t("pdfSettings.useDefault")} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>{t("pdfSettings.companyAddress")}</label>
                  <input type="text" value={form.pdf_company_address_override || ""} onChange={(e) => set("pdf_company_address_override", e.target.value)} placeholder={t("pdfSettings.useDefault")} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>{t("pdfSettings.companyPhone")}</label>
                  <input type="text" value={form.pdf_company_phone_override || ""} onChange={(e) => set("pdf_company_phone_override", e.target.value)} placeholder={t("pdfSettings.useDefault")} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>{t("pdfSettings.companyEmail")}</label>
                  <input type="text" value={form.pdf_company_email_override || ""} onChange={(e) => set("pdf_company_email_override", e.target.value)} placeholder={t("pdfSettings.useDefault")} className={inputClass} />
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "invoice" && (
          <div className={sectionClass}>
            <div className={cardClass}>
              <h3 className="font-semibold text-slate-900">{t("pdfSettings.invoiceSettings")}</h3>

              <div>
                <label className={labelClass}>{t("pdfSettings.headerText")}</label>
                <input type="text" value={form.pdf_invoice_header || ""} onChange={(e) => set("pdf_invoice_header", e.target.value)} placeholder={t("pdfSettings.headerPlaceholder")} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.paymentTerms")}</label>
                <input type="text" value={form.pdf_invoice_payment_terms || ""} onChange={(e) => set("pdf_invoice_payment_terms", e.target.value)} placeholder={t("pdfSettings.placeholderPaymentTerms")} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.bankDetails")}</label>
                <textarea value={form.pdf_invoice_bank_details || ""} onChange={(e) => set("pdf_invoice_bank_details", e.target.value)} placeholder={t("pdfSettings.bankDetailsPlaceholder")} rows={3} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.lateFeeNotice")}</label>
                <input type="text" value={form.pdf_invoice_late_fee_notice || ""} onChange={(e) => set("pdf_invoice_late_fee_notice", e.target.value)} placeholder={t("pdfSettings.lateFeePlaceholder")} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.notes")}</label>
                <textarea value={form.pdf_invoice_notes || ""} onChange={(e) => set("pdf_invoice_notes", e.target.value)} placeholder={t("pdfSettings.notesPlaceholder")} rows={2} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.footer")}</label>
                <textarea value={form.pdf_invoice_footer || ""} onChange={(e) => set("pdf_invoice_footer", e.target.value)} placeholder={t("pdfSettings.footerPlaceholder")} rows={2} className={inputClass} />
              </div>
            </div>
          </div>
        )}

        {activeTab === "quotation" && (
          <div className={sectionClass}>
            <div className={cardClass}>
              <h3 className="font-semibold text-slate-900">{t("pdfSettings.quotationSettings")}</h3>

              <div>
                <label className={labelClass}>{t("pdfSettings.headerText")}</label>
                <input type="text" value={form.pdf_quote_header || ""} onChange={(e) => set("pdf_quote_header", e.target.value)} placeholder={t("pdfSettings.headerPlaceholder")} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.validityText")}</label>
                <input type="text" value={form.pdf_quote_validity_text || ""} onChange={(e) => set("pdf_quote_validity_text", e.target.value)} placeholder={t("pdfSettings.placeholderValidityText")} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.termsConditions")}</label>
                <textarea value={form.pdf_quote_terms || ""} onChange={(e) => set("pdf_quote_terms", e.target.value)} placeholder={t("pdfSettings.termsPlaceholder")} rows={3} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.notes")}</label>
                <textarea value={form.pdf_quote_notes || ""} onChange={(e) => set("pdf_quote_notes", e.target.value)} placeholder={t("pdfSettings.notesPlaceholder")} rows={2} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>{t("pdfSettings.footer")}</label>
                <textarea value={form.pdf_quote_footer || ""} onChange={(e) => set("pdf_quote_footer", e.target.value)} placeholder={t("pdfSettings.footerPlaceholder")} rows={2} className={inputClass} />
              </div>
            </div>
          </div>
        )}

        {activeTab === "order" && (
          <DocTypeSettings
            prefix="order"
            title={t("pdfSettings.orderSettings")}
            form={form}
            set={set}
            t={t}
            inputClass={inputClass}
            labelClass={labelClass}
            cardClass={cardClass}
          />
        )}

        {activeTab === "dispatch" && (
          <DocTypeSettings
            prefix="dispatch"
            title={t("pdfSettings.dispatchSettings")}
            form={form}
            set={set}
            t={t}
            inputClass={inputClass}
            labelClass={labelClass}
            cardClass={cardClass}
          />
        )}

        {activeTab === "inspection" && (
          <DocTypeSettings
            prefix="inspection"
            title={t("pdfSettings.inspectionSettings")}
            form={form}
            set={set}
            t={t}
            inputClass={inputClass}
            labelClass={labelClass}
            cardClass={cardClass}
          />
        )}
      </div>
    </SettingsShell>
  );
}

/** Reusable per-doc-type settings (header, notes, footer) */
function DocTypeSettings({
  prefix,
  title,
  form,
  set,
  t,
  inputClass,
  labelClass,
  cardClass,
}: {
  prefix: string;
  title: string;
  form: Record<string, string>;
  set: (key: string, value: string) => void;
  t: RuntimeTranslator;
  inputClass: string;
  labelClass: string;
  cardClass: string;
}) {
  return (
    <div className="space-y-4">
      <div className={cardClass}>
        <h3 className="font-semibold text-slate-900">{title}</h3>

        <div>
          <label className={labelClass}>{translateDynamic(t, "pdfSettings.headerText")}</label>
          <input
            type="text"
            value={form[`pdf_${prefix}_header`] || ""}
            onChange={(e) => set(`pdf_${prefix}_header`, e.target.value)}
            placeholder={translateDynamic(t, "pdfSettings.headerPlaceholder")}
            className={inputClass}
          />
        </div>

        <div>
          <label className={labelClass}>{translateDynamic(t, "pdfSettings.notes")}</label>
          <textarea
            value={form[`pdf_${prefix}_notes`] || ""}
            onChange={(e) => set(`pdf_${prefix}_notes`, e.target.value)}
            placeholder={translateDynamic(t, "pdfSettings.notesPlaceholder")}
            rows={2}
            className={inputClass}
          />
        </div>

        <div>
          <label className={labelClass}>{translateDynamic(t, "pdfSettings.footer")}</label>
          <textarea
            value={form[`pdf_${prefix}_footer`] || ""}
            onChange={(e) => set(`pdf_${prefix}_footer`, e.target.value)}
            placeholder={translateDynamic(t, "pdfSettings.footerPlaceholder")}
            rows={2}
            className={inputClass}
          />
        </div>
      </div>
    </div>
  );
}
