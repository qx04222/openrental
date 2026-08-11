import { useState, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, X, ChevronDown, ChevronUp, ImageIcon, FileText, Video, Tags } from "lucide-react";
import { catalogSourceColors as sourceColors } from "@/lib/statusColors";
import { compressImage } from "@/lib/imageUtils";
import CategorySelect from "@/components/CategorySelect";
import CategoryManager, { CategoryFormModal } from "@/components/CategoryManager";
import { serverErrorText } from "@/lib/serverError";

/** Inline file upload component for catalog fields */
function CatalogFileUpload({ value, onChange, accept, compress, maxSize = 10 * 1024 * 1024, icon, hint }: {
  value: string; onChange: (url: string) => void; accept: string; compress?: boolean;
  maxSize?: number; icon: ReactNode; hint: string;
}) {
  const { t } = useTranslation("admin");
  const ref = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    if (file.size > maxSize) { toast.error(`File too large (max ${Math.round(maxSize / 1024 / 1024)}MB)`); return; }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      let result = ev.target?.result as string;
      if (compress && file.type.startsWith("image/")) result = await compressImage(result);
      onChange(result);
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  if (value) {
    const isImage = value.startsWith("data:image/") || /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(value);
    return (
      <div className="flex items-center gap-3 border border-slate-200 rounded-lg p-2">
        {isImage ? (
          <img src={value} alt="" className="h-16 w-16 object-cover rounded" />
        ) : (
          <div className="h-16 w-16 bg-slate-100 rounded flex items-center justify-center text-slate-400">{icon}</div>
        )}
        <span className="text-xs text-slate-500 flex-1 truncate">{value.startsWith("data:") ? "Uploaded file" : value.split("/").pop()}</span>
        <button type="button" onClick={() => onChange("")} className="text-slate-400 hover:text-red-500"><X size={16} /></button>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
      onClick={() => ref.current?.click()}
      className="border-2 border-dashed border-slate-300 rounded-lg p-4 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/50 transition-colors"
    >
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      {uploading ? (
        <div className="flex flex-col items-center gap-1 text-slate-400">
          <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full" />
          <span className="text-xs">{t("catalog.uploadingFile")}</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1 text-slate-400">
          {icon}
          <span className="text-xs">{hint}</span>
        </div>
      )}
    </div>
  );
}

/** Dynamic Key-Value spec editor */
function SpecEditor({ specs, onChange, category }: {
  specs: { key: string; value: string }[];
  onChange: (specs: { key: string; value: string }[]) => void;
  category: string;
}) {
  const { t } = useTranslation("admin");

  const suggestedKeys: Record<string, string[]> = {
    Excavator: ["Max Dig Depth", "Max Reach", "Max Dump Height", "Bucket Size"],
    "Wheel Loader": ["Bucket Capacity", "Lift Height", "Breakout Force"],
    CTL: ["Rated Operating Capacity", "Lift Height", "HP"],
    "Skid Steer": ["Rated Operating Capacity", "Lift Height", "HP"],
  };

  const suggestions = suggestedKeys[category] || [];
  const existingKeys = new Set(specs.map((s) => s.key));

  const addSpec = (key = "") => onChange([...specs, { key, value: "" }]);
  const removeSpec = (i: number) => onChange(specs.filter((_, idx) => idx !== i));
  const updateSpec = (i: number, field: "key" | "value", val: string) => {
    const updated = [...specs];
    updated[i] = { ...updated[i], [field]: val };
    onChange(updated);
  };

  return (
    <div className="space-y-3">
      {/* Suggested quick-add buttons */}
      {suggestions.filter((s) => !existingKeys.has(s)).length > 0 && (
        <div>
          <p className="text-xs text-slate-500 mb-1">{t("catalog.suggestedSpecs")}</p>
          <div className="flex gap-1 flex-wrap">
            {suggestions.filter((s) => !existingKeys.has(s)).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => addSpec(s)}
                className="px-2 py-0.5 text-xs bg-slate-100 text-slate-600 rounded hover:bg-slate-200"
              >
                + {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Spec rows */}
      {specs.map((spec, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            value={spec.key}
            onChange={(e) => updateSpec(i, "key", e.target.value)}
            placeholder={t("catalog.specKey")}
            className="flex-1 bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
          />
          <input
            value={spec.value}
            onChange={(e) => updateSpec(i, "value", e.target.value)}
            placeholder={t("catalog.specValue")}
            className="flex-1 bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
          />
          <button type="button" onClick={() => removeSpec(i)} className="text-slate-400 hover:text-red-500 flex-shrink-0">
            <X size={16} />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={() => addSpec()}
        className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1"
      >
        <Plus size={14} /> {t("catalog.addSpec")}
      </button>
    </div>
  );
}

type FilterTab = "all" | "industrial" | "powersports" | "attachment";

/** Derive the user-visible "kind" of a catalog item from its sourceType +
 * equipmentType. Legacy `sourceType: "manual"` items are bucketed as
 * industrial (the dominant business) since the external sync was retired. */
function catalogKind(item: { sourceType: string | null; equipmentType?: string | null }): "industrial" | "powersports" | "attachment" {
  if (item.equipmentType === "attachment") return "attachment";
  if (item.sourceType === "powersports") return "powersports";
  return "industrial";
}

const emptyForm = {
  brand: "", model: "", category: "", modelYear: "", description: "",
  specifications: "", msrp: "", imageUrl: "", enginePower: "",
  operatingWeight: "", bucketCapacity: "", ratedLoad: "",
  availabilityStatus: "available", leadTimeDays: "", displayOrder: "0",
  brochureUrl: "", videoUrl: "",
  // The form tracks "kind" — a 3-way choice the user actually thinks in.
  // It maps to (sourceType, equipmentType) at submit time.
  kind: "industrial" as "industrial" | "powersports" | "attachment",
};

/** Pure render — parent owns the selected state so it can persist on save. */
function CompatibilityEditor({
  selected,
  onToggle,
  machines,
}: {
  selected: Set<number>;
  onToggle: (id: number) => void;
  machines: { id: number; brand: string; model: string; modelYear: number | null; category: string }[];
}) {
  const { t } = useTranslation("admin");
  return (
    <div className="border border-amber-200 bg-amber-50/30 rounded-lg p-3 space-y-2">
      <p className="text-sm font-semibold text-amber-900">{t("catalog.compatTitle")}</p>
      <p className="text-xs text-amber-700">{t("catalog.compatHint")}</p>
      <div className="border border-amber-200 rounded bg-white max-h-56 overflow-y-auto divide-y divide-slate-100">
        {machines.length === 0 ? (
          <div className="p-3 text-center text-sm text-slate-400">{t("catalog.compatNoMachines")}</div>
        ) : (
          machines.map((m) => (
            <label key={m.id} className="flex items-center gap-2 p-2 hover:bg-slate-50 cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => onToggle(m.id)}
                className="rounded border-amber-400 text-amber-600"
              />
              <span className="text-slate-900">{m.brand} {m.model}{m.modelYear ? ` (${m.modelYear})` : ""}</span>
              <span className="text-xs text-slate-500 ml-auto">{m.category}</span>
            </label>
          ))
        )}
      </div>
      <p className="text-xs text-slate-500">{t("catalog.compatSelected", { count: selected.size })}</p>
    </div>
  );
}

function parseSpecsToKV(raw: string): { key: string; value: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, value]) => ({ key, value: String(value) }));
    }
  } catch {
    // not JSON
  }
  return [];
}

function kvToSpecsJson(specs: { key: string; value: string }[]): string {
  const filtered = specs.filter((s) => s.key.trim());
  if (filtered.length === 0) return "";
  const obj: Record<string, string> = {};
  for (const s of filtered) obj[s.key.trim()] = s.value;
  return JSON.stringify(obj);
}

export default function CatalogSync() {
  const { t } = useTranslation("admin");
  const utils = trpc.useUtils();
  const { data: catalogData, isLoading } = trpc.catalogSync.getCatalog.useQuery();
  const createMut = trpc.catalogSync.createItem.useMutation({
    // Modal-close is deferred to handleSubmit so the compat save can chain.
    onSuccess: () => { utils.catalogSync.getCatalog.invalidate(); toast.success(t("catalog.itemCreated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateMut = trpc.catalogSync.updateItem.useMutation({
    onSuccess: () => { utils.catalogSync.getCatalog.invalidate(); toast.success(t("catalog.itemUpdated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteMut = trpc.catalogSync.deleteItem.useMutation({
    onSuccess: () => { utils.catalogSync.getCatalog.invalidate(); toast.success(t("catalog.itemDeleted")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // Category management lives in the shared <CategoryManager /> section below;
  // this query only feeds the section-header count (react-query dedupes it).
  const { data: categoriesData } = trpc.equipmentCategories.list.useQuery();

  const [filter, setFilter] = useState<FilterTab>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formTab, setFormTab] = useState<"basic" | "specs">("basic");
  const [specEntries, setSpecEntries] = useState<{ key: string; value: string }[]>([]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [compatSelected, setCompatSelected] = useState<Set<number>>(new Set());

  const setCompatMut = trpc.attachmentCompatibility.setCompatibleMachines.useMutation({
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const [categorySectionOpen, setCategorySectionOpen] = useState(false);
  // Inline "+ add category" from the item form — preset to the form's kind.
  const [quickCatOpen, setQuickCatOpen] = useState(false);

  type CatalogItem = NonNullable<typeof catalogData>[number];

  const filtered = (catalogData || []).filter((item) => {
    if (filter === "all") return true;
    return catalogKind(item as { sourceType: string | null; equipmentType?: string | null }) === filter;
  });

  const openAdd = () => {
    setEditId(null);
    setForm(emptyForm);
    setSpecEntries([]);
    setCompatSelected(new Set());
    setFormTab("basic");
    setAdvancedOpen(false);
    setModalOpen(true);
  };

  const openEdit = async (item: CatalogItem) => {
    setEditId(item.id);
    // Pre-load existing compatibility for attachments so the editor opens
    // with the boxes already ticked
    const itemKind = catalogKind(item as { sourceType: string | null; equipmentType?: string | null });
    if (itemKind === "attachment") {
      try {
        const existing = await utils.attachmentCompatibility.forAttachment.fetch({ attachmentCatalogId: item.id });
        setCompatSelected(new Set(existing.map((e) => e.machineCatalogId)));
      } catch {
        setCompatSelected(new Set());
      }
    } else {
      setCompatSelected(new Set());
    }
    setForm({
      brand: item.brand || "",
      model: item.model || "",
      category: item.category || "",
      modelYear: item.modelYear ? String(item.modelYear) : "",
      description: item.description || "",
      specifications: item.specifications || "",
      msrp: item.msrp || "",
      imageUrl: item.imageUrl || "",
      enginePower: item.enginePower || "",
      operatingWeight: item.operatingWeight || "",
      bucketCapacity: item.bucketCapacity || "",
      ratedLoad: item.ratedLoad || "",
      availabilityStatus: item.availabilityStatus || "available",
      leadTimeDays: item.leadTimeDays ? String(item.leadTimeDays) : "",
      displayOrder: item.displayOrder != null ? String(item.displayOrder) : "0",
      brochureUrl: item.brochureUrl || "",
      videoUrl: item.videoUrl || "",
      kind: catalogKind(item as { sourceType: string | null; equipmentType?: string | null }),
    });
    setSpecEntries(parseSpecsToKV(item.specifications || ""));
    setFormTab("basic");
    setAdvancedOpen(false);
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    if (!form.brand || !form.model || !form.category) return toast.error(t("catalog.requiredFields"));
    const specsJson = kvToSpecsJson(specEntries);
    const payload = {
      brand: form.brand,
      model: form.model,
      category: form.category,
      modelYear: form.modelYear ? Number(form.modelYear) : undefined,
      description: form.description || undefined,
      specifications: specsJson || form.specifications || undefined,
      msrp: form.msrp || undefined,
      imageUrl: form.imageUrl || undefined,
      enginePower: form.enginePower || undefined,
      operatingWeight: form.operatingWeight || undefined,
      bucketCapacity: form.bucketCapacity || undefined,
      ratedLoad: form.ratedLoad || undefined,
      availabilityStatus: form.availabilityStatus,
      leadTimeDays: form.leadTimeDays ? Number(form.leadTimeDays) : undefined,
      displayOrder: form.displayOrder ? Number(form.displayOrder) : 0,
      brochureUrl: form.brochureUrl || undefined,
      videoUrl: form.videoUrl || undefined,
      // Map the user's "kind" back to the (sourceType, equipmentType) pair.
      // Attachments still need a sourceType for legacy schema reasons; pin
      // them to industrial since that's where they're listed business-wise.
      sourceType: (form.kind === "powersports" ? "powersports" : "industrial") as "industrial" | "powersports",
      equipmentType: (form.kind === "attachment" ? "attachment" : "machine") as "machine" | "attachment",
    };
    try {
      const saved = editId
        ? await updateMut.mutateAsync({ id: editId, ...payload })
        : await createMut.mutateAsync(payload);
      // If this is an attachment, persist the compatibility list against
      // the same row in a single click. Skip when the saved row id is
      // missing (shouldn't happen) or when type=machine.
      if (form.kind === "attachment" && saved?.id) {
        await setCompatMut.mutateAsync({
          attachmentCatalogId: saved.id,
          machineCatalogIds: [...compatSelected],
        });
        utils.attachmentCompatibility.forAttachment.invalidate({ attachmentCatalogId: saved.id });
        utils.attachmentCompatibility.forMachine.invalidate();
      }
      setModalOpen(false);
    } catch {
      // mutation onError already toasted; leave modal open so user can retry
    }
  };

  const toggleCompat = (id: number) => {
    setCompatSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const inputClass = "bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full";
  const tabBtn = (tab: typeof formTab, label: string) => (
    <button
      onClick={() => setFormTab(tab)}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition ${formTab === tab ? "bg-[var(--primary)]/10 text-[var(--primary)] font-bold" : "text-slate-500 hover:bg-slate-100"}`}
    >
      {label}
    </button>
  );

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("catalog.title")}</h1>
          <button onClick={openAdd} className="btn-primary flex items-center gap-2">
            <Plus size={18} /> {t("catalog.addItem")}
          </button>
        </div>

        {/* Filter pills */}
        <div className="flex gap-2 flex-wrap">
          {(["all", "industrial", "powersports", "attachment"] as FilterTab[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 rounded-lg text-sm font-medium ${
                filter === f
                  ? "bg-[var(--primary)]/10 text-[var(--primary)] font-bold"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              {t(`catalog.filter_${f}`)}
            </button>
          ))}
        </div>

        {/* Category Management Section */}
        <div className="card">
          <button
            onClick={() => setCategorySectionOpen(!categorySectionOpen)}
            className="w-full flex items-center justify-between text-lg font-semibold text-slate-900"
          >
            <div className="flex items-center gap-2">
              <Tags size={20} className="text-slate-400" />
              {t("catalog.categorySection")}
              {categoriesData && <span className="text-sm font-normal text-slate-400 ml-2">({categoriesData.length})</span>}
            </div>
            {categorySectionOpen ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
          </button>
          {categorySectionOpen && (
            <div className="mt-4">
              <CategoryManager />
            </div>
          )}
        </div>

        {/* Catalog Table */}
        <div className="card overflow-x-auto">
          {isLoading ? <p className="text-slate-500 py-4">{t("loading", { ns: "common" })}</p> : (
            <table className="w-full text-sm text-left">
              <thead className="text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">{t("catalog.brand")}</th>
                  <th className="py-3 px-4">{t("catalog.model")}</th>
                  <th className="py-3 px-4">{t("catalog.category")}</th>
                  <th className="py-3 px-4">{t("catalog.msrp")}</th>
                  <th className="py-3 px-4">{t("catalog.source")}</th>
                  <th className="py-3 px-4">{t("catalog.availability")}</th>
                  <th className="py-3 px-4">{t("catalog.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id} className="border-b border-slate-200/50 text-slate-600 hover:bg-slate-100/30">
                    <td className="py-3 px-4 text-slate-900 font-medium">{item.brand}</td>
                    <td className="py-3 px-4">{item.model}</td>
                    <td className="py-3 px-4">{item.category || "-"}</td>
                    <td className="py-3 px-4">{item.msrp ? `$${Number(item.msrp).toLocaleString()}` : "-"}</td>
                    <td className="py-3 px-4">
                      {(() => {
                        const kind = catalogKind(item as { sourceType: string | null; equipmentType?: string | null });
                        // Reuse the source-color palette by mapping kind back to a color slot
                        const colorKey = kind === "attachment" ? "manual" : kind;
                        return (
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${sourceColors[colorKey] || ""}`}>
                            {t(`catalog.filter_${kind}`)}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-3 px-4 capitalize">{item.availabilityStatus || "available"}</td>
                    <td className="py-3 px-4 flex gap-2">
                      <button onClick={() => openEdit(item)} className="text-slate-500 hover:text-slate-900" aria-label="Edit"><Pencil size={16} /></button>
                      {item.sourceId === null && (
                        <button onClick={() => { if (confirm(t("catalog.deleteConfirm"))) deleteMut.mutate({ id: item.id }); }} className="text-slate-500 hover:text-[var(--primary)]" aria-label="Delete"><Trash2 size={16} /></button>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-slate-400">{t("catalog.noItems")}</td></tr>}
              </tbody>
            </table>
          )}
        </div>

      </div>

      {/* Add/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setModalOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-3xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{editId ? t("catalog.editItem") : t("catalog.addItem")}</h2>
              <button onClick={() => setModalOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>

            {/* Form Tabs — simplified to Basic + Specifications */}
            <div className="flex gap-1 flex-wrap">
              {tabBtn("basic", t("catalog.tabBasic"))}
              {tabBtn("specs", t("catalog.tabSpecs"))}
            </div>

            <div className="space-y-4">
              {formTab === "basic" && (
                <>
                  {/* Kind radio: industrial / powersports / attachment */}
                  <div className="grid grid-cols-3 gap-2">
                    {(["industrial", "powersports", "attachment"] as const).map((kind) => (
                      <button
                        type="button"
                        key={kind}
                        onClick={() => {
                          // Machine and attachment categories are separate lists —
                          // crossing that boundary invalidates the current pick.
                          const crossed = (kind === "attachment") !== (form.kind === "attachment");
                          setForm({ ...form, kind, category: crossed ? "" : form.category });
                        }}
                        className={`py-2 rounded-lg border text-sm font-medium ${
                          form.kind === kind
                            ? "border-[var(--primary)] bg-[var(--primary)]/5 text-[var(--primary)]"
                            : "border-slate-300 text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        {t(`catalog.filter_${kind}`)}
                      </button>
                    ))}
                  </div>

                  {/* Core fields */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.brand")} *</label>
                      <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} className={inputClass} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.category")} *</label>
                      <div className="flex gap-2">
                        <CategorySelect
                          value={form.category}
                          onChange={(v) => setForm({ ...form, category: v })}
                          kind={form.kind === "attachment" ? "attachment" : "machine"}
                          className={inputClass}
                        />
                        <button
                          type="button"
                          onClick={() => setQuickCatOpen(true)}
                          className="btn-secondary shrink-0 px-2 flex items-center"
                          title={t("catalog.addCategory")}
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.model")} *</label>
                      <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={inputClass} />
                    </div>
                    {/* Year removed from catalog — it doesn't affect pricing and is
                        managed per-asset on the rental fleet instead. */}
                  </div>

                  {/* Description — enhanced with placeholder guidance */}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("catalog.description")}</label>
                    <textarea
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      rows={5}
                      className={inputClass}
                      placeholder={t("catalog.descriptionPlaceholder")}
                    />
                  </div>

                  {/* Image Upload */}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("catalog.imageUrl")}</label>
                    <CatalogFileUpload
                      value={form.imageUrl}
                      onChange={(url) => setForm({ ...form, imageUrl: url })}
                      accept="image/*"
                      compress
                      icon={<ImageIcon size={20} />}
                      hint={t("catalog.dragDropImage")}
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Brochure Upload */}
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.brochureUrl")}</label>
                      <CatalogFileUpload
                        value={form.brochureUrl}
                        onChange={(url) => setForm({ ...form, brochureUrl: url })}
                        accept="application/pdf"
                        maxSize={20 * 1024 * 1024}
                        icon={<FileText size={20} />}
                        hint="PDF — max 20MB"
                      />
                    </div>
                    {/* Video Upload */}
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.videoUrl")}</label>
                      <CatalogFileUpload
                        value={form.videoUrl}
                        onChange={(url) => setForm({ ...form, videoUrl: url })}
                        accept="video/*"
                        maxSize={50 * 1024 * 1024}
                        icon={<Video size={20} />}
                        hint="MP4, MOV, WebM — max 50MB"
                      />
                    </div>
                  </div>

                  {/* Advanced Settings — collapsed by default */}
                  <div className="border border-slate-200 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setAdvancedOpen(!advancedOpen)}
                      className="w-full flex items-center justify-between px-4 py-2 text-sm text-slate-500 hover:text-slate-700"
                    >
                      {t("catalog.advancedSettings")}
                      {advancedOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    {advancedOpen && (
                      <div className="px-4 pb-4 grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("catalog.availability")}</label>
                          <select value={form.availabilityStatus} onChange={(e) => setForm({ ...form, availabilityStatus: e.target.value })} className={inputClass}>
                            <option value="available">{t("catalog.statusAvailable")}</option>
                            <option value="limited">{t("catalog.statusLimited")}</option>
                            <option value="out_of_stock">{t("catalog.statusOutOfStock")}</option>
                            <option value="discontinued">{t("catalog.statusDiscontinued")}</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("catalog.msrp")}</label>
                          <input value={form.msrp} onChange={(e) => setForm({ ...form, msrp: e.target.value })} className={inputClass} placeholder="0.00" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("catalog.leadTime")}</label>
                          <input type="number" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })} className={inputClass} placeholder={t("catalog.leadTimePlaceholder")} />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("catalog.displayOrder")}</label>
                          <input type="number" value={form.displayOrder} onChange={(e) => setForm({ ...form, displayOrder: e.target.value })} className={inputClass} />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Attachment compatibility editor — visible whenever the
                       kind is set to attachment, including during create */}
                  {form.kind === "attachment" && (
                    <CompatibilityEditor
                      selected={compatSelected}
                      onToggle={toggleCompat}
                      machines={(catalogData || [])
                        .filter((c) => c.equipmentType === "machine" && c.id !== editId)
                        .map((c) => ({
                          id: c.id,
                          brand: c.brand,
                          model: c.model,
                          modelYear: c.modelYear,
                          category: c.category,
                        }))}
                    />
                  )}
                </>
              )}

              {formTab === "specs" && (
                <div className="space-y-4">
                  {/* Fixed spec fields */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.enginePower")}</label>
                      <input value={form.enginePower} onChange={(e) => setForm({ ...form, enginePower: e.target.value })} className={inputClass} placeholder={t("catalog.enginePowerPlaceholder")} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.operatingWeight")}</label>
                      <input value={form.operatingWeight} onChange={(e) => setForm({ ...form, operatingWeight: e.target.value })} className={inputClass} placeholder={t("catalog.operatingWeightPlaceholder")} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.bucketCapacity")}</label>
                      <input value={form.bucketCapacity} onChange={(e) => setForm({ ...form, bucketCapacity: e.target.value })} className={inputClass} placeholder={t("catalog.bucketCapacityPlaceholder")} />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("catalog.ratedLoad")}</label>
                      <input value={form.ratedLoad} onChange={(e) => setForm({ ...form, ratedLoad: e.target.value })} className={inputClass} placeholder={t("catalog.ratedLoadPlaceholder")} />
                    </div>
                  </div>

                  {/* Dynamic Key-Value spec editor */}
                  <div>
                    <p className="text-sm font-medium text-slate-700 mb-2">{t("catalog.specifications")}</p>
                    <SpecEditor
                      specs={specEntries}
                      onChange={setSpecEntries}
                      category={form.category}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setModalOpen(false)} className="btn-secondary">{t("catalog.cancel")}</button>
              <button onClick={handleSubmit} disabled={createMut.isPending || updateMut.isPending} className="btn-primary">
                {editId ? t("catalog.update") : t("catalog.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inline quick-add category from the item form — preset to its kind */}
      <CategoryFormModal
        open={quickCatOpen}
        onClose={() => setQuickCatOpen(false)}
        presetKind={form.kind === "attachment" ? "attachment" : "machine"}
        onCreated={(name) => setForm((f) => ({ ...f, category: name }))}
      />
    </DashboardLayout>
  );
}
