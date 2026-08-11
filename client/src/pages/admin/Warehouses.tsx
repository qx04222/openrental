import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, X, Building2, Star, Power } from "lucide-react";
import ProvinceSelect from "@/components/ProvinceSelect";
import { serverErrorText } from "@/lib/serverError";

const emptyForm = { name: "", address: "", city: "", province: "", postalCode: "", phone: "", isPrimary: false, contactName: "", contactPhone: "", contactEmail: "" };

export default function Warehouses() {
  const { t } = useTranslation(["admin", "common"]);
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.warehouses.list.useQuery();
  const createMut = trpc.warehouses.create.useMutation({
    onSuccess: () => { utils.warehouses.list.invalidate(); setOpen(false); toast.success(t("warehouses.warehouseCreated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateMut = trpc.warehouses.update.useMutation({
    onSuccess: () => { utils.warehouses.list.invalidate(); setOpen(false); toast.success(t("warehouses.warehouseUpdated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteMut = trpc.warehouses.delete.useMutation({
    onSuccess: () => { utils.warehouses.list.invalidate(); toast.success(t("warehouses.warehouseDeleted")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const closeModal = useCallback(() => setOpen(false), []);
  useEscapeKey(open, closeModal);

  const openAdd = () => { setEditId(null); setForm(emptyForm); setOpen(true); };
  type Warehouse = NonNullable<typeof data>[number];
  const openEdit = (w: Warehouse) => {
    setEditId(w.id);
    setForm({
      name: w.name || "",
      address: w.address || "",
      city: w.city || "",
      province: w.province || "",
      postalCode: w.postalCode || "",
      phone: w.phone || "",
      isPrimary: w.isPrimary || false,
      contactName: w.contactName || "",
      contactPhone: w.contactPhone || "",
      contactEmail: w.contactEmail || "",
    });
    setOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name) return toast.error(t("warehouses.nameIsRequired"));
    const payload = {
      name: form.name,
      address: form.address || undefined,
      city: form.city || undefined,
      province: form.province || undefined,
      postalCode: form.postalCode || undefined,
      phone: form.phone || undefined,
      isPrimary: form.isPrimary,
      contactName: form.contactName || undefined,
      contactPhone: form.contactPhone || undefined,
      contactEmail: form.contactEmail || undefined,
    };
    if (editId) {
      updateMut.mutate({ id: editId, ...payload });
    } else {
      createMut.mutate(payload);
    }
  };

  const handleToggleActive = (w: Warehouse) => {
    updateMut.mutate({ id: w.id, isActive: !w.isActive });
  };

  return (
    <SettingsShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("warehouses.title")}</h1>
          <button onClick={openAdd} className="btn-primary flex items-center gap-2"><Plus size={18} /> {t("warehouses.addWarehouse")}</button>
        </div>

        {isLoading ? <div className="flex items-center justify-center py-12"><div className="spinner" /><span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span></div> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(data || []).map((w) => (
              <div key={w.id} className="card space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-slate-100 text-[var(--primary)]"><Building2 size={20} /></div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-slate-900 font-semibold">{w.name}</h3>
                        {w.isPrimary && <Star size={14} className="text-yellow-500 fill-yellow-500" />}
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${w.isActive ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                        {w.isActive ? t("active", { ns: "common" }) : t("inactive", { ns: "common" })}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleToggleActive(w)}
                      title={w.isActive ? t("warehouses.deactivate") : t("warehouses.activate")}
                      aria-label={w.isActive ? t("warehouses.deactivate") : t("warehouses.activate")}
                      className={`p-1 ${w.isActive ? "text-green-500 hover:text-red-400" : "text-red-400 hover:text-green-500"}`}
                    >
                      <Power size={16} />
                    </button>
                    <button onClick={() => openEdit(w)} className="text-slate-500 hover:text-slate-900 p-1" aria-label="Edit warehouse"><Pencil size={16} /></button>
                    <button onClick={() => { if (confirm(t("warehouses.deleteConfirm"))) deleteMut.mutate({ id: w.id }); }} className="text-slate-500 hover:text-[var(--primary)] p-1" aria-label="Delete warehouse"><Trash2 size={16} /></button>
                  </div>
                </div>
                {w.address && <p className="text-sm text-slate-500">{w.address}</p>}
                {(w.city || w.province) && (
                  <p className="text-sm text-slate-400">{[w.city, w.province, w.postalCode].filter(Boolean).join(", ")}</p>
                )}
                {w.phone && <p className="text-sm text-slate-400">{w.phone}</p>}
                {w.contactName && (
                  <div className="pt-2 border-t border-slate-200/50">
                    <p className="text-xs text-slate-400">{t("warehouses.contact")} {w.contactName}</p>
                    {w.contactPhone && <p className="text-xs text-slate-400">{w.contactPhone}</p>}
                    {w.contactEmail && <p className="text-xs text-slate-400">{w.contactEmail}</p>}
                  </div>
                )}
              </div>
            ))}
            {data?.length === 0 && (
              <div className="col-span-full text-center py-12 text-slate-400">{t("warehouses.noWarehouses")}</div>
            )}
          </div>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("warehouses.addWarehouse")}</h2>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input placeholder={t("warehouses.nameRequired")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              <input placeholder={t("warehouses.address")} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input placeholder={t("warehouses.city")} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                <ProvinceSelect value={form.province} onChange={(v) => setForm({ ...form, province: v })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                <input placeholder={t("warehouses.postalCode")} value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <input placeholder={t("warehouses.phone")} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />

              <div className="border-t border-slate-200 pt-3">
                <p className="text-sm font-medium text-slate-700 mb-2">{t("warehouses.contactPerson")}</p>
                <div className="grid grid-cols-1 gap-3">
                  <input placeholder={t("warehouses.contactName")} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  <div className="grid grid-cols-2 gap-3">
                    <input placeholder={t("warehouses.contactPhone")} value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                    <input placeholder={t("warehouses.contactEmail")} value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} className="rounded border-slate-300" />
                <span className="text-sm text-slate-700">{t("warehouses.primaryWarehouse")}</span>
              </label>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleSubmit} disabled={createMut.isPending || updateMut.isPending} className="btn-primary">{editId ? t("update", { ns: "common" }) : t("create", { ns: "common" })}</button>
            </div>
          </div>
        </div>
      )}
    </SettingsShell>
  );
}
