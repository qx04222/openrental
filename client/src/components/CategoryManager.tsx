import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Tags, Plus, Pencil, Trash2, X, Package } from "lucide-react";
import { serverErrorText } from "@/lib/serverError";

type EquipmentKind = "machine" | "attachment";

interface CategoryRow {
  id: number;
  name: string;
  description: string | null;
  displayOrder: number | null;
  isActive: boolean;
  equipmentType: EquipmentKind;
  modelCount: number;
  fleetCount: number;
  catalogCount: number;
}

interface FormState {
  name: string;
  description: string;
  displayOrder: number;
  isActive: boolean;
  equipmentType: EquipmentKind;
  dailyRate: string;
  weeklyRate: string;
  monthlyRate: string;
}

const emptyForm: FormState = {
  name: "", description: "", displayOrder: 0, isActive: true,
  equipmentType: "machine", dailyRate: "", weeklyRate: "", monthlyRate: "",
};

const inputClass = "w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-1 focus:ring-[var(--primary)]/50 focus:border-[var(--primary)]";

export function CategoryTypeBadge({ type }: { type: EquipmentKind }) {
  const { t } = useTranslation("fleet");
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
      type === "attachment" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"
    }`}>
      {type === "attachment" ? t("categoryManagement.typeAttachment") : t("categoryManagement.typeMachine")}
    </span>
  );
}

interface CategoryFormModalProps {
  open: boolean;
  onClose: () => void;
  /** Row to edit; null/undefined = create mode (with rate inputs). */
  edit?: CategoryRow | null;
  /** Pre-selected type in create mode (e.g. from the attachment form). */
  presetKind?: EquipmentKind;
  /** Called with the new category name after a successful create. */
  onCreated?: (name: string) => void;
}

export function CategoryFormModal({ open, onClose, edit, presetKind, onCreated }: CategoryFormModalProps) {
  const { t } = useTranslation(["fleet", "common"]);
  const utils = trpc.useUtils();
  const [form, setForm] = useState<FormState>(emptyForm);
  // Re-seed the form each time the modal opens (create vs edit target).
  useEffect(() => {
    if (!open) return;
    setForm(edit
      ? {
          ...emptyForm,
          name: edit.name,
          description: edit.description || "",
          displayOrder: edit.displayOrder ?? 0,
          isActive: edit.isActive,
          equipmentType: edit.equipmentType,
        }
      : { ...emptyForm, equipmentType: presetKind ?? "machine" });
  }, [open, edit, presetKind]);

  const invalidate = () => {
    utils.equipmentCategories.list.invalidate();
    utils.equipmentCategories.listActive.invalidate();
    utils.equipmentModels.list.invalidate();
  };

  const createMutation = trpc.equipmentCategories.create.useMutation({
    onSuccess: (_, vars) => {
      invalidate();
      toast.success(t("categoryManagement.created"));
      onCreated?.(vars.name);
      onClose();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateMutation = trpc.equipmentCategories.update.useMutation({
    onSuccess: () => {
      invalidate();
      utils.rentalFleet.invalidate();
      toast.success(t("categoryManagement.updated"));
      onClose();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  if (!open) return null;

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = () => {
    if (!form.name.trim()) return toast.error(t("categoryManagement.nameRequired"));
    if (edit) {
      updateMutation.mutate({
        id: edit.id,
        name: form.name.trim(),
        description: form.description || undefined,
        displayOrder: form.displayOrder,
        isActive: form.isActive,
        equipmentType: form.equipmentType,
      });
    } else {
      createMutation.mutate({
        name: form.name.trim(),
        description: form.description || undefined,
        displayOrder: form.displayOrder,
        equipmentType: form.equipmentType,
        dailyRate: form.dailyRate || undefined,
        weeklyRate: form.weeklyRate || undefined,
        monthlyRate: form.monthlyRate || undefined,
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-xl max-w-md w-full p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            {edit ? t("categoryManagement.editCategory") : t("categoryManagement.addCategory")}
          </h2>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">{t("categoryManagement.type")} *</label>
            <div className="flex gap-2">
              {(["machine", "attachment"] as const).map((tp) => (
                <button
                  key={tp}
                  type="button"
                  onClick={() => setForm({ ...form, equipmentType: tp })}
                  className={`flex-1 px-3 py-2 rounded border text-sm transition-colors ${
                    form.equipmentType === tp
                      ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)] font-medium"
                      : "border-slate-300 text-slate-600 hover:border-slate-400"
                  }`}
                >
                  {tp === "attachment" ? t("categoryManagement.typeAttachment") : t("categoryManagement.typeMachine")}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">{t("categoryManagement.name")} *</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputClass}
              placeholder={t("categoryManagement.placeholderName")}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">{t("categoryManagement.description")}</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className={inputClass}
              rows={2}
            />
          </div>
          {!edit && (
            <div>
              <label className="block text-xs text-slate-500 mb-1">{t("categoryManagement.rates")}</label>
              <div className="grid grid-cols-3 gap-2">
                {(["dailyRate", "weeklyRate", "monthlyRate"] as const).map((k) => (
                  <div key={k}>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={form[k]}
                      onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                      className={inputClass}
                      placeholder={t(`categoryManagement.${k}`)}
                    />
                    <span className="text-[10px] text-slate-400">{t(`categoryManagement.${k}`)}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-slate-400 mt-1">{t("categoryManagement.ratesHint")}</p>
            </div>
          )}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-xs text-slate-500 mb-1">{t("categoryManagement.displayOrder")}</label>
              <input
                type="number"
                value={form.displayOrder}
                onChange={(e) => setForm({ ...form, displayOrder: parseInt(e.target.value) || 0 })}
                className={inputClass}
                min={0}
              />
            </div>
            {edit && (
              <div className="flex-1 flex items-end">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.isActive}
                    onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                    className="rounded border-slate-300 text-[var(--primary)] focus:ring-[var(--primary)]"
                  />
                  <span className="text-sm text-slate-700">{t("active", { ns: "common" })}</span>
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onClose} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
          <button onClick={handleSubmit} disabled={isPending} className="btn-primary disabled:opacity-50">
            {isPending ? t("saving", { ns: "common" }) : edit ? t("update", { ns: "common" }) : t("create", { ns: "common" })}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Category table + add/edit/delete. Shared by the standalone Category
 * Management page and the inline section on the catalog page — the host
 * provides its own wrapper (page header / collapsible card).
 */
export default function CategoryManager() {
  const { t } = useTranslation(["fleet", "common"]);
  const utils = trpc.useUtils();
  const { data: categories, isLoading } = trpc.equipmentCategories.list.useQuery();

  const [modalOpen, setModalOpen] = useState(false);
  const [editRow, setEditRow] = useState<CategoryRow | null>(null);

  const deleteMutation = trpc.equipmentCategories.delete.useMutation({
    onSuccess: () => {
      utils.equipmentCategories.list.invalidate();
      utils.equipmentCategories.listActive.invalidate();
      toast.success(t("categoryManagement.deleted"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const handleDelete = (cat: CategoryRow) => {
    if (!confirm(t("categoryManagement.deleteConfirm"))) return;
    deleteMutation.mutate({ id: cat.id });
  };

  return (
    <div>
      <div className="flex justify-end mb-3">
        <button
          onClick={() => { setEditRow(null); setModalOpen(true); }}
          className="btn-primary flex items-center gap-2 text-sm"
        >
          <Plus size={16} /> {t("categoryManagement.addCategory")}
        </button>
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="spinner" />
          <span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span>
        </div>
      ) : !categories || categories.length === 0 ? (
        <div className="py-8 text-center text-slate-400">
          <Tags size={32} className="mx-auto mb-2 opacity-30" />
          {t("categoryManagement.noCategories")}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-slate-500 border-b border-slate-200">
              <tr>
                <th className="py-2 px-4">{t("categoryManagement.name")}</th>
                <th className="py-2 px-4 text-center">{t("categoryManagement.type")}</th>
                <th className="py-2 px-4">{t("categoryManagement.description")}</th>
                <th className="py-2 px-4 text-center">{t("categoryManagement.displayOrder")}</th>
                <th className="py-2 px-4 text-center">{t("categoryManagement.equipmentCount")}</th>
                <th className="py-2 px-4 text-center">{t("status", { ns: "common" })}</th>
                <th className="py-2 px-4 text-right">{t("actions", { ns: "common" })}</th>
              </tr>
            </thead>
            <tbody>
              {(categories as CategoryRow[]).map((cat) => (
                <tr key={cat.id} className="border-b border-slate-200/50 hover:bg-slate-100/30">
                  <td className="py-2 px-4">
                    <div className="flex items-center gap-2">
                      <Package size={14} className="text-slate-400" />
                      <span className="font-medium text-slate-900">{cat.name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-center">
                    <CategoryTypeBadge type={cat.equipmentType} />
                  </td>
                  <td className="py-2 px-4 text-slate-500 max-w-xs truncate">{cat.description || "-"}</td>
                  <td className="py-2 px-4 text-center text-slate-500">{cat.displayOrder}</td>
                  <td className="py-2 px-4 text-center">
                    <span className="text-slate-600">{cat.fleetCount}</span>
                    {cat.catalogCount > 0 && <span className="text-slate-400 text-xs ml-1">({cat.catalogCount} catalog)</span>}
                  </td>
                  <td className="py-2 px-4 text-center">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      cat.isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"
                    }`}>
                      {cat.isActive ? t("active", { ns: "common" }) : t("inactive", { ns: "common" })}
                    </span>
                  </td>
                  <td className="py-2 px-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => { setEditRow(cat); setModalOpen(true); }}
                        className="tap-target p-1 text-slate-400 hover:text-[var(--primary)]"
                        title={t("edit", { ns: "common" })}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => handleDelete(cat)}
                        disabled={cat.fleetCount > 0}
                        className="tap-target p-1 text-slate-400 hover:text-red-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        title={cat.fleetCount > 0 ? t("categoryManagement.cannotDelete") : t("delete", { ns: "common" })}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CategoryFormModal open={modalOpen} onClose={() => setModalOpen(false)} edit={editRow} />
    </div>
  );
}
