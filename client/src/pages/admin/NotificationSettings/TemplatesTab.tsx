import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import {
  X, Plus, Pencil, Trash2, Eye, Copy, Mail, Smartphone,
} from "lucide-react";

interface NotificationTemplate {
  id: number;
  name: string;
  channel: string;
  event: string;
  subject: string | null;
  body: string;
  isActive: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RentalEvent {
  value: string;
  label: string;
}

interface TemplatesTabProps {
  templates: NotificationTemplate[];
  rentalEvents: RentalEvent[];
  templateModal: boolean;
  setTemplateModal: (v: boolean) => void;
  editTemplate: NotificationTemplate | null;
  templateForm: {
    name: string;
    channel: string;
    event: string;
    subject: string;
    body: string;
    isActive: boolean;
  };
  setTemplateForm: (v: TemplatesTabProps["templateForm"]) => void;
  previewMode: boolean;
  setPreviewMode: (v: boolean) => void;
  onAdd: () => void;
  onEdit: (tmpl: NotificationTemplate) => void;
  onSave: () => void;
  onDuplicate: (id: number) => void;
  onDelete: (id: number) => void;
  isSaving: boolean;
  inputClass: string;
}

export default function TemplatesTab({
  templates,
  rentalEvents,
  templateModal,
  setTemplateModal,
  editTemplate,
  templateForm,
  setTemplateForm,
  previewMode,
  setPreviewMode,
  onAdd,
  onEdit,
  onSave,
  onDuplicate,
  onDelete,
  isSaving,
  inputClass,
}: TemplatesTabProps) {
  const { t } = useTranslation("admin");

  // ─── Preview ───────────────────────────────────────────────
  const previewBody = useMemo(() => {
    if (!previewMode || !templateForm.body) return "";
    const sampleVars: Record<string, string> = {
      customerName: "John Smith",
      email: "john@example.com",
      phone: "+1 (555) 123-4567",
      rentalId: "1042",
      status: "approved",
      equipmentName: "CAT 320 Excavator",
      startDate: "2026-03-15",
      endDate: "2026-03-30",
      total: "$4,250.00",
      companyName: "OpenRental",
      invoiceNumber: "INV-2026-0042",
      totalAmount: "$4,250.00",
      dueDate: "2026-04-15",
      paymentTerms: "Net 30",
      paymentAmount: "$2,000.00",
      balanceDue: "$2,250.00",
      requestedEndDate: "2026-04-30",
      extensionReason: "Project delayed due to weather",
    };
    return templateForm.body.replace(/\{\{(\w+)\}\}/g, (_, key) => sampleVars[key] ?? `{{${key}}}`);
  }, [previewMode, templateForm.body]);

  const previewSubject = useMemo(() => {
    if (!previewMode || !templateForm.subject) return "";
    const sampleVars: Record<string, string> = {
      customerName: "John Smith",
      rentalId: "1042",
      status: "approved",
      companyName: "OpenRental",
      invoiceNumber: "INV-2026-0042",
      requestedEndDate: "2026-04-30",
    };
    return templateForm.subject.replace(/\{\{(\w+)\}\}/g, (_, key) => sampleVars[key] ?? `{{${key}}}`);
  }, [previewMode, templateForm.subject]);

  return (
    <>
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-slate-900">{t("notifications.templateList")}</h2>
          <button onClick={onAdd} className="btn-primary flex items-center gap-2 text-sm">
            <Plus size={16} /> {t("notifications.addTemplate")}
          </button>
        </div>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-3 px-4">{t("notifications.templateName")}</th>
                <th className="py-3 px-4">{t("notifications.channel")}</th>
                <th className="py-3 px-4">{t("notifications.event")}</th>
                <th className="py-3 px-4">{t("notifications.subject")}</th>
                <th className="py-3 px-4">{t("notifications.active")}</th>
                <th className="py-3 px-4">{t("notifications.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((tmpl) => (
                <tr key={tmpl.id} className="border-b border-slate-200/50 text-slate-600 hover:bg-slate-100/30">
                  <td className="py-3 px-4 text-slate-900 font-medium">{tmpl.name}</td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${tmpl.channel === "email" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>
                      {tmpl.channel === "email" ? <Mail size={12} /> : <Smartphone size={12} />}
                      {tmpl.channel}
                    </span>
                  </td>
                  <td className="py-3 px-4 font-mono text-xs">{tmpl.event}</td>
                  <td className="py-3 px-4 max-w-[200px] truncate">{tmpl.subject || "-"}</td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${tmpl.isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
                      {tmpl.isActive ? t("notifications.yes") : t("notifications.no")}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex gap-2">
                      <button onClick={() => onEdit(tmpl)} className="text-slate-500 hover:text-slate-900" aria-label={t("notifications.editTemplate")}><Pencil size={16} /></button>
                      <button onClick={() => onDuplicate(tmpl.id)} className="text-slate-500 hover:text-blue-500" aria-label={t("notifications.duplicate")}><Copy size={16} /></button>
                      <button onClick={() => { if (confirm(t("notifications.deleteConfirm"))) onDelete(tmpl.id); }} className="text-slate-500 hover:text-[var(--primary)]" aria-label={t("notifications.delete")}><Trash2 size={16} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {templates.length === 0 && (
                <tr><td colSpan={6} className="py-8 text-center text-slate-400">{t("notifications.noTemplates")}</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Variables reference */}
        <div className="card">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">{t("notifications.availableVariables")}</h3>
          <div className="flex flex-wrap gap-2">
            {["customerName", "email", "phone", "rentalId", "status", "equipmentName", "startDate", "endDate", "total", "companyName", "invoiceNumber", "totalAmount", "dueDate", "paymentTerms", "paymentAmount", "balanceDue", "requestedEndDate", "extensionReason"].map((v) => (
              <code key={v} className="bg-slate-100 text-slate-700 px-2 py-1 rounded text-xs font-mono">{`{{${v}}}`}</code>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ Template Modal ═══ */}
      {templateModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setTemplateModal(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">
                {editTemplate ? t("notifications.editTemplate") : t("notifications.addTemplate")}
              </h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setPreviewMode(!previewMode)}
                  className={`text-xs flex items-center gap-1 px-3 py-1.5 rounded-lg border transition ${previewMode ? "bg-blue-50 text-blue-600 border-blue-200" : "bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100"}`}
                >
                  <Eye size={14} /> {t("notifications.preview")}
                </button>
                <button onClick={() => setTemplateModal(false)} className="text-slate-500 hover:text-slate-900"><X size={20} /></button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.templateName")} *</label>
                  <input value={templateForm.name} onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.channel")} *</label>
                  <select value={templateForm.channel} onChange={(e) => setTemplateForm({ ...templateForm, channel: e.target.value })} className={inputClass}>
                    <option value="email">{t("notifications.email")}</option>
                    <option value="sms">{t("notifications.sms")}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.event")} *</label>
                  <select value={templateForm.event} onChange={(e) => setTemplateForm({ ...templateForm, event: e.target.value })} className={inputClass}>
                    <option value="">{t("notifications.selectEvent")}</option>
                    {rentalEvents.map((ev) => (
                      <option key={ev.value} value={ev.value}>{t(ev.label as never)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end gap-2">
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={templateForm.isActive} onChange={(e) => setTemplateForm({ ...templateForm, isActive: e.target.checked })} className="rounded" />
                    {t("notifications.active")}
                  </label>
                </div>
              </div>

              {templateForm.channel === "email" && (
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("notifications.subject")}</label>
                  {previewMode ? (
                    <div className="bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-900 border border-slate-200">{previewSubject || <span className="text-slate-400">({t("notifications.noSubject")})</span>}</div>
                  ) : (
                    <input value={templateForm.subject} onChange={(e) => setTemplateForm({ ...templateForm, subject: e.target.value })} className={inputClass} placeholder="Rental #{{rentalId}} - {{status}}" />
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-500 mb-1">{t("notifications.body")} *</label>
                {previewMode ? (
                  templateForm.channel === "email" ? (
                    <div className="bg-white rounded-lg p-4 border border-slate-200 min-h-[150px] text-sm" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewBody) }} />
                  ) : (
                    <div className="bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-900 border border-slate-200 min-h-[100px] whitespace-pre-wrap">{previewBody}</div>
                  )
                ) : (
                  <textarea
                    value={templateForm.body}
                    onChange={(e) => setTemplateForm({ ...templateForm, body: e.target.value })}
                    rows={6}
                    className={inputClass}
                    placeholder={templateForm.channel === "email"
                      ? "<h1>Hello {{customerName}}</h1><p>Your rental #{{rentalId}} has been {{status}}.</p>"
                      : "Hi {{customerName}}, your rental #{{rentalId}} is now {{status}}."}
                  />
                )}
              </div>

              {!previewMode && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700">
                  <strong>{t("notifications.variablesHelp")}:</strong>{" "}
                  {"{{customerName}}, {{email}}, {{phone}}, {{rentalId}}, {{status}}, {{equipmentName}}, {{startDate}}, {{endDate}}, {{total}}, {{companyName}}, {{invoiceNumber}}, {{totalAmount}}, {{dueDate}}, {{paymentTerms}}, {{paymentAmount}}, {{balanceDue}}, {{requestedEndDate}}, {{extensionReason}}"}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
              <button onClick={() => setTemplateModal(false)} className="btn-secondary">{t("notifications.cancel")}</button>
              <button onClick={onSave} disabled={isSaving} className="btn-primary">
                {editTemplate ? t("notifications.update") : t("notifications.create")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
