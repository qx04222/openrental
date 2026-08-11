import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { useConfirm } from "@/hooks/useConfirm";
import { toast } from "sonner";
import {
  Save,
  Plus,
  Trash2,
  Copy,
  Star,
  Eye,
  Pencil,
  FileText,
  Info,
  Sparkles,
} from "lucide-react";
import { serverErrorText } from "@/lib/serverError";
import { translateDynamic } from "@/lib/i18nHelpers";

const TEMPLATE_VARIABLE_KEYS = [
  { key: "{companyName}", labelKey: "contractTemplates.varCompanyName" },
  { key: "{customerName}", labelKey: "contractTemplates.varCustomerName" },
  { key: "{equipmentDescription}", labelKey: "contractTemplates.varEquipment" },
  { key: "{equipmentSerial}", labelKey: "contractTemplates.varEquipmentSerial" },
  { key: "{startDate}", labelKey: "contractTemplates.varStartDate" },
  { key: "{endDate}", labelKey: "contractTemplates.varEndDate" },
  { key: "{deliveryAddress}", labelKey: "contractTemplates.varDeliveryAddress" },
  { key: "{dailyRate}", labelKey: "contractTemplates.varDailyRate" },
  { key: "{weeklyRate}", labelKey: "contractTemplates.varWeeklyRate" },
  { key: "{monthlyRate}", labelKey: "contractTemplates.varMonthlyRate" },
  { key: "{deposit}", labelKey: "contractTemplates.varDeposit" },
  { key: "{totalAmount}", labelKey: "contractTemplates.varTotalAmount" },
  { key: "{agreementNumber}", labelKey: "contractTemplates.varAgreementNumber" },
  { key: "{effectiveDate}", labelKey: "contractTemplates.varEffectiveDate" },
  { key: "{renterSignature}", labelKey: "contractTemplates.varRenterSignature" },
  { key: "{signatureDate}", labelKey: "contractTemplates.varSignatureDate" },
];

const SAMPLE_DATA: Record<string, string> = {
  "{companyName}": "OpenRental",
  "{customerName}": "John Smith",
  "{equipmentDescription}": "CAT 320 Excavator",
  "{equipmentSerial}": "VLGE602HCS0610373",
  "{startDate}": "January 15, 2026",
  "{endDate}": "February 15, 2026",
  "{deliveryAddress}": "123 Job Site Rd, Toronto, ON",
  "{dailyRate}": "$280.00",
  "{weeklyRate}": "$1,250.00",
  "{monthlyRate}": "$3,300.00",
  "{deposit}": "$2,000.00",
  "{totalAmount}": "$12,500.00",
  "{agreementNumber}": "RNT-2026-0042",
  "{effectiveDate}": "March 20, 2026",
  "{renterSignature}": "[Signature]",
  "{signatureDate}": "March 20, 2026",
};

export default function ContractTermsTab() {
  const { t } = useTranslation("admin");
  const confirm = useConfirm();
  const utils = trpc.useUtils();
  const { data: templates = [], isLoading } = trpc.contractTemplates.list.useQuery({ includeInactive: true });

  const createMutation = trpc.contractTemplates.create.useMutation({
    onSuccess: () => {
      utils.contractTemplates.list.invalidate();
      toast.success(t("contractTemplates.created"));
    },
  });

  const updateMutation = trpc.contractTemplates.update.useMutation({
    onSuccess: () => {
      utils.contractTemplates.list.invalidate();
      toast.success(t("contractTemplates.saved"));
    },
  });

  const deleteMutation = trpc.contractTemplates.delete.useMutation({
    onSuccess: () => {
      utils.contractTemplates.list.invalidate();
      toast.success(t("contractTemplates.deleted"));
      setSelectedId(null);
    },
  });

  const setDefaultMutation = trpc.contractTemplates.setDefault.useMutation({
    onSuccess: () => {
      utils.contractTemplates.list.invalidate();
      toast.success(t("contractTemplates.defaultSet"));
    },
  });

  const duplicateMutation = trpc.contractTemplates.duplicate.useMutation({
    onSuccess: () => {
      utils.contractTemplates.list.invalidate();
      toast.success(t("contractTemplates.duplicated"));
    },
  });

  const seedDefaultMutation = trpc.contractTemplates.seedDefault.useMutation({
    onSuccess: (result) => {
      utils.contractTemplates.list.invalidate();
      if (result.seeded) {
        toast.success(t("contractTemplates.defaultSeeded"));
      } else {
        toast.info(t("contractTemplates.defaultAlreadyExists"));
      }
    },
  });

  // ─── Company signature (Lessor) settings ──────────────────────
  const { data: siteSettings } = trpc.siteSettings.getAll.useQuery();
  const repSignature = siteSettings?.["contract_rep_signature"] || "";
  const [repName, setRepName] = useState("");
  const [repTitle, setRepTitle] = useState("");
  const sigFileRef = useRef<HTMLInputElement>(null);

  // Seed local name/title from settings once loaded.
  const sigLoadedRef = useRef(false);
  if (siteSettings && !sigLoadedRef.current) {
    sigLoadedRef.current = true;
    setRepName(siteSettings["contract_rep_name"] || "");
    setRepTitle(siteSettings["contract_rep_title"] || "");
  }

  const saveSetting = trpc.siteSettings.update.useMutation({
    onSuccess: () => {
      utils.siteSettings.getAll.invalidate();
      toast.success(t("contractTemplates.signatureSaved"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const handleSignatureUpload = (file: File) => {
    if (!file.type.startsWith("image/")) { toast.error("Please choose an image file"); return; }
    if (file.size > 1_000_000) { toast.error("Image too large (max 1 MB)"); return; }
    const reader = new FileReader();
    reader.onload = () => saveSetting.mutate({ key: "contract_rep_signature", value: String(reader.result) });
    reader.readAsDataURL(file);
  };

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [isNew, setIsNew] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [dirty, setDirty] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSelectTemplate = useCallback((tpl: typeof templates[number]) => {
    setSelectedId(tpl.id);
    setEditName(tpl.name);
    setEditContent(tpl.content);
    setIsNew(false);
    setDirty(false);
    setShowPreview(false);
  }, []);

  const handleNewTemplate = () => {
    setSelectedId(null);
    setEditName("");
    setEditContent("");
    setIsNew(true);
    setDirty(true);
    setShowPreview(false);
  };

  const handleSave = async () => {
    if (!editName.trim() || !editContent.trim()) return;

    if (isNew) {
      const result = await createMutation.mutateAsync({
        name: editName.trim(),
        content: editContent.trim(),
      });
      setSelectedId(result.id);
      setIsNew(false);
    } else if (selectedId) {
      await updateMutation.mutateAsync({
        id: selectedId,
        name: editName.trim(),
        content: editContent.trim(),
      });
    }
    setDirty(false);
  };

  const handleDelete = async (id: number) => {
    const ok = await confirm({
      title: t("contractTemplates.delete") + "?",
      dangerous: true,
      confirmLabel: t("contractTemplates.delete"),
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    await deleteMutation.mutateAsync({ id });
  };

  const insertVariable = (varKey: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const newContent = editContent.substring(0, start) + varKey + editContent.substring(end);
    setEditContent(newContent);
    setDirty(true);
    // Restore cursor position after React re-render
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + varKey.length, start + varKey.length);
    });
  };

  const previewContent = editContent.replace(
    /\{(\w+)\}/g,
    (match) => SAMPLE_DATA[match] ?? match,
  );

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-lg font-semibold text-slate-900">{t("contractTemplates.title")}</h3>
        <p className="text-sm text-slate-500 mt-1">{t("contractTemplates.description")}</p>
      </div>

      {/* Company signature (auto-applied to the Lessor line of every contract) */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h4 className="text-sm font-semibold text-slate-900">{t("contractTemplates.signatureTitle")}</h4>
        <p className="text-xs text-slate-500 mt-0.5 mb-3">{t("contractTemplates.signatureDesc")}</p>
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex flex-col gap-2">
            <div className="h-20 w-56 rounded border border-dashed border-slate-300 bg-slate-50 flex items-center justify-center overflow-hidden">
              {repSignature
                ? <img src={repSignature} alt="signature" className="max-h-full max-w-full object-contain" />
                : <span className="text-xs text-slate-400">{t("contractTemplates.signatureNone")}</span>}
            </div>
            <div className="flex gap-2">
              <input ref={sigFileRef} type="file" accept="image/png,image/jpeg" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleSignatureUpload(f); e.target.value = ""; }} />
              <button onClick={() => sigFileRef.current?.click()} className="btn-secondary text-xs">
                {t("contractTemplates.signatureUpload")}
              </button>
              {repSignature && (
                <button onClick={() => saveSetting.mutate({ key: "contract_rep_signature", value: "" })}
                  className="text-xs text-red-600 hover:underline px-2">
                  {t("contractTemplates.signatureRemove")}
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2 min-w-[200px]">
            <label className="text-xs text-slate-600">{t("contractTemplates.signatureRepName")}
              <input value={repName} onChange={(e) => setRepName(e.target.value)}
                onBlur={() => saveSetting.mutate({ key: "contract_rep_name", value: repName })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
            </label>
            <label className="text-xs text-slate-600">{t("contractTemplates.signatureRepTitle")}
              <input value={repTitle} onChange={(e) => setRepTitle(e.target.value)}
                onBlur={() => saveSetting.mutate({ key: "contract_rep_title", value: repTitle })}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm" />
            </label>
            <p className="text-[11px] text-slate-400">{t("contractTemplates.signatureHint")}</p>
          </div>
        </div>
      </div>

      <div className="flex gap-6">
        {/* Left panel: Template list */}
        <div className="w-1/3 flex flex-col gap-3">
          <button
            onClick={handleNewTemplate}
            className="btn-primary flex items-center gap-2 text-sm justify-center"
          >
            <Plus size={16} />
            {t("contractTemplates.newTemplate")}
          </button>

          {isLoading ? (
            <div className="text-sm text-slate-400 text-center py-8">Loading...</div>
          ) : templates.length === 0 ? (
            <div className="text-sm text-slate-400 text-center py-8 space-y-3">
              <p>{t("contractTemplates.noTemplates")}</p>
              <button
                onClick={() => seedDefaultMutation.mutate()}
                disabled={seedDefaultMutation.isPending}
                className="inline-flex items-center gap-1.5 text-xs bg-amber-50 text-amber-700 border border-amber-200 px-3 py-1.5 rounded-lg hover:bg-amber-100 transition disabled:opacity-50"
              >
                <Sparkles size={14} />
                {seedDefaultMutation.isPending
                  ? t("contractTemplates.seeding")
                  : t("contractTemplates.seedDefault")}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  onClick={() => handleSelectTemplate(tpl)}
                  className={`
                    border rounded-lg p-3 cursor-pointer transition group
                    ${selectedId === tpl.id
                      ? "border-[var(--primary)] bg-red-50"
                      : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                    }
                    ${!tpl.isActive ? "opacity-50" : ""}
                  `}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText size={14} className="text-slate-400 flex-shrink-0" />
                      <span className="text-sm font-medium text-slate-900 truncate">{tpl.name}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {tpl.isDefault && (
                        <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded font-medium">
                          {t("contractTemplates.default")}
                        </span>
                      )}
                      {!tpl.isActive && (
                        <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                          Inactive
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!tpl.isDefault && tpl.isActive && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setDefaultMutation.mutate({ id: tpl.id }); }}
                        className="text-xs text-slate-500 hover:text-yellow-600 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-yellow-50"
                        title={t("contractTemplates.setDefault")}
                      >
                        <Star size={12} />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); duplicateMutation.mutate({ id: tpl.id }); }}
                      className="text-xs text-slate-500 hover:text-blue-600 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-blue-50"
                      title={t("contractTemplates.duplicate")}
                    >
                      <Copy size={12} />
                    </button>
                    {!tpl.isDefault && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(tpl.id); }}
                        className="text-xs text-slate-500 hover:text-red-600 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-red-50"
                        title={tpl.isDefault ? t("contractTemplates.cannotDeleteDefault") : t("contractTemplates.delete")}
                        disabled={tpl.isDefault}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right panel: Editor */}
        <div className="w-2/3 flex flex-col gap-4">
          {!selectedId && !isNew ? (
            <div className="flex items-center justify-center h-64 border border-dashed border-slate-300 rounded-xl text-slate-400 text-sm">
              {templates.length === 0
                ? t("contractTemplates.noTemplates")
                : "Select a template to edit"
              }
            </div>
          ) : (
            <>
              {/* Template name */}
              <input
                type="text"
                value={editName}
                onChange={(e) => { setEditName(e.target.value); setDirty(true); }}
                placeholder={t("contractTemplates.namePlaceholder")}
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
              />

              {/* Toggle: Edit / Preview */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowPreview(false)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition ${
                    !showPreview ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <Pencil size={14} />
                  {t("contractTemplates.edit")}
                </button>
                <button
                  onClick={() => setShowPreview(true)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition ${
                    showPreview ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <Eye size={14} />
                  {t("contractTemplates.preview")}
                </button>
              </div>

              {/* Editor or Preview */}
              {showPreview ? (
                <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 min-h-[300px] text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                  {previewContent}
                </div>
              ) : (
                <textarea
                  ref={textareaRef}
                  value={editContent}
                  onChange={(e) => { setEditContent(e.target.value); setDirty(true); }}
                  rows={14}
                  placeholder={t("contractTemplates.content")}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 font-mono resize-y focus:ring-2 focus:ring-[var(--primary)]/20 focus:border-[var(--primary)]"
                />
              )}

              {/* Variable chips */}
              {!showPreview && (
                <div>
                  <p className="text-xs text-slate-500 mb-1.5 font-medium">
                    {t("contractTemplates.variablesTitle")}
                    <span className="font-normal ml-1 text-slate-400">
                      {t("contractTemplates.variablesHint")}
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {TEMPLATE_VARIABLE_KEYS.map((v) => (
                      <button
                        key={v.key}
                        onClick={() => insertVariable(v.key)}
                        className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-md hover:bg-blue-100 transition font-mono"
                        title={translateDynamic(t, v.labelKey)}
                      >
                        {v.key}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Variable Reference */}
              {!showPreview && (
                <details className="border border-slate-200 rounded-lg">
                  <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm text-slate-600 hover:bg-slate-50 select-none">
                    <Info size={14} />
                    {t("contractTemplates.variableRefTitle")}
                  </summary>
                  <div className="px-3 pb-3">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-slate-500 border-b border-slate-100">
                          <th className="py-1 pr-4 font-medium">{t("contractTemplates.variableRefVar")}</th>
                          <th className="py-1 pr-4 font-medium">{t("contractTemplates.variableRefDesc")}</th>
                          <th className="py-1 font-medium">{t("contractTemplates.variableRefExample")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {TEMPLATE_VARIABLE_KEYS.map((v) => (
                          <tr key={v.key} className="border-b border-slate-50">
                            <td className="py-1.5 pr-4 font-mono text-blue-700">{v.key}</td>
                            <td className="py-1.5 pr-4 text-slate-600">{translateDynamic(t, v.labelKey)}</td>
                            <td className="py-1.5 text-slate-400 italic">{SAMPLE_DATA[v.key]}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}

              {/* Save button */}
              <div className="flex justify-end">
                <button
                  onClick={handleSave}
                  disabled={!dirty || isSaving || !editName.trim() || !editContent.trim()}
                  className="btn-primary flex items-center gap-2 text-sm disabled:opacity-50"
                >
                  <Save size={16} />
                  {isSaving ? "Saving..." : t("contractTemplates.saved").replace("saved", "Save")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Info card */}
      <div className="rounded-xl border border-slate-200 bg-blue-50 p-4">
        <p className="text-sm text-blue-800">
          <strong>{t("contractTerms.howItWorksTitle")}</strong> {t("contractTerms.howItWorksText")}
        </p>
      </div>
    </div>
  );
}
