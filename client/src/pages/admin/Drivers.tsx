import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";
import DataTable, { Column } from "@/components/DataTable";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  X,
  Pencil,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { useFormatCalendarDate, formatCalendarDateISO } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";

const emptyForm = {
  name: "",
  phone: "",
  email: "",
  licenseNumber: "",
  licenseExpiry: "",
  vehicleInfo: "",
  notes: "",
};

export default function Drivers() {
  const { t } = useTranslation("admin");
  const utils = trpc.useUtils();

  // ─── Data fetching ──────────────────────────────────────────
  const { data: driverData, isLoading } = trpc.drivers.list.useQuery();

  // ─── Mutations ──────────────────────────────────────────────
  const createMut = trpc.drivers.create.useMutation({
    onSuccess: () => {
      utils.drivers.list.invalidate();
      setCreateOpen(false);
      toast.success(t("drivers.createSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateMut = trpc.drivers.update.useMutation({
    onSuccess: () => {
      utils.drivers.list.invalidate();
      setEditOpen(false);
      toast.success(t("drivers.updateSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deleteMut = trpc.drivers.delete.useMutation({
    onSuccess: () => {
      utils.drivers.list.invalidate();
      toast.success(t("drivers.deleteSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Dialog state ──────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyForm);

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);

  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeEdit = useCallback(() => setEditOpen(false), []);
  useEscapeKey(createOpen, closeCreate);
  useEscapeKey(editOpen, closeEdit);

  // ─── Handlers ──────────────────────────────────────────────
  const openCreate = () => {
    setCreateForm(emptyForm);
    setCreateOpen(true);
  };

  const handleCreate = () => {
    if (!createForm.name.trim()) return toast.error(t("drivers.nameRequired"));
    createMut.mutate({
      name: createForm.name,
      phone: createForm.phone || undefined,
      email: createForm.email || undefined,
      licenseNumber: createForm.licenseNumber || undefined,
      licenseExpiry: createForm.licenseExpiry || undefined,
      vehicleInfo: createForm.vehicleInfo || undefined,
      notes: createForm.notes || undefined,
    });
  };

  const openEdit = (driver: DriverRow) => {
    setEditId(driver.id);
    setEditForm({
      name: driver.name,
      phone: driver.phone || "",
      email: driver.email || "",
      licenseNumber: driver.licenseNumber || "",
      licenseExpiry: driver.licenseExpiry ? formatCalendarDateISO(driver.licenseExpiry) : "",
      vehicleInfo: driver.vehicleInfo || "",
      notes: driver.notes || "",
    });
    setEditOpen(true);
  };

  const handleEdit = () => {
    if (!editId) return;
    if (!editForm.name.trim()) return toast.error(t("drivers.nameRequired"));
    updateMut.mutate({
      id: editId,
      name: editForm.name,
      phone: editForm.phone || undefined,
      email: editForm.email || undefined,
      licenseNumber: editForm.licenseNumber || undefined,
      licenseExpiry: editForm.licenseExpiry || null,
      vehicleInfo: editForm.vehicleInfo || undefined,
      notes: editForm.notes || undefined,
    });
  };

  const toggleActive = (driver: DriverRow) => {
    updateMut.mutate({ id: driver.id, isActive: !driver.isActive });
  };

  // ─── Table data ──────────────────────────────────────────
  type DriverRow = NonNullable<typeof driverData>[number];

  const fmtDate = useFormatCalendarDate();

  const columns: Column<DriverRow>[] = [
    {
      key: "name",
      label: t("drivers.columnName"),
      render: (row) => <span className="text-slate-900 font-medium">{row.name}</span>,
    },
    {
      key: "phone",
      label: t("drivers.columnPhone"),
      render: (row) => <span className="text-sm text-slate-700">{row.phone || "-"}</span>,
      hideOnMobile: true,
    },
    {
      key: "email",
      label: t("drivers.columnEmail"),
      render: (row) => <span className="text-sm text-slate-700">{row.email || "-"}</span>,
      hideOnMobile: true,
    },
    {
      key: "licenseNumber",
      label: t("drivers.columnLicense"),
      render: (row) => <span className="text-sm text-slate-700">{row.licenseNumber || "-"}</span>,
      hideOnMobile: true,
    },
    {
      key: "licenseExpiry",
      label: t("drivers.columnLicenseExpiry"),
      render: (row) => {
        if (!row.licenseExpiry) return <span className="text-sm text-slate-400">-</span>;
        const expiry = new Date(row.licenseExpiry);
        const isExpired = expiry < new Date();
        return (
          <span className={`text-sm ${isExpired ? "text-red-600 font-medium" : "text-slate-700"}`}>
            {fmtDate(row.licenseExpiry)}
          </span>
        );
      },
      hideOnMobile: true,
    },
    {
      key: "isActive",
      label: t("drivers.columnActive"),
      render: (row) => (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${row.isActive ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
          {row.isActive ? t("drivers.activeStatus") : t("drivers.inactiveStatus")}
        </span>
      ),
    },
    {
      key: "_actions",
      label: t("drivers.columnActions"),
      sortable: false,
      searchable: false,
      render: (row) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => toggleActive(row)} className="tap-target text-slate-500 hover:text-blue-600" title={row.isActive ? t("drivers.deactivateTooltip") : t("drivers.activateTooltip")}>
            {row.isActive ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
          </button>
          <button onClick={() => openEdit(row)} className="tap-target text-slate-500 hover:text-slate-900" title={t("drivers.editTooltip")}>
            <Pencil size={16} />
          </button>
          <button
            onClick={() => { if (confirm(t("drivers.deleteConfirm"))) deleteMut.mutate({ id: row.id }); }}
            className="tap-target text-slate-400 hover:text-[var(--primary)]"
            title={t("drivers.deleteTooltip")}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  // ─── Form fields renderer ──────────────────────────────────
  const renderFormFields = (
    form: typeof emptyForm,
    setForm: (f: typeof emptyForm) => void,
  ) => (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("drivers.formName")} <span className="text-[var(--primary)]">*</span></label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("drivers.fullNamePlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("drivers.formPhone")}</label>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(555) 123-4567" className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("drivers.formEmail")}</label>
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("drivers.formLicenseNumber")}</label>
          <input value={form.licenseNumber} onChange={(e) => setForm({ ...form, licenseNumber: e.target.value })} placeholder={t("drivers.licensePlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("drivers.formLicenseExpiry")}</label>
          <input type="date" value={form.licenseExpiry} onChange={(e) => setForm({ ...form, licenseExpiry: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("drivers.formVehicleInfo")}</label>
          <input value={form.vehicleInfo} onChange={(e) => setForm({ ...form, vehicleInfo: e.target.value })} placeholder={t("drivers.vehiclePlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">{t("drivers.formNotes")}</label>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} placeholder={t("drivers.notesPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
      </div>
    </div>
  );

  return (
    <SettingsShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("drivers.pageTitle")}</h1>
          <button onClick={openCreate} className="btn-primary flex items-center gap-2">
            <Plus size={18} /> {t("drivers.createButton")}
          </button>
        </div>

        {/* Table */}
        <DataTable
          data={driverData || []}
          columns={columns}
          isLoading={isLoading}
          emptyMessage={t("drivers.noDriversFound")}
          searchPlaceholder={t("drivers.searchPlaceholder")}
        />
      </div>

      {/* ─── Create Dialog ─────────────────────────────────── */}
      {createOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setCreateOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("drivers.createDialogTitle")}</h2>
              <button onClick={() => setCreateOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            {renderFormFields(createForm, setCreateForm)}
            <div className="flex justify-end gap-3">
              <button onClick={() => setCreateOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleCreate} disabled={createMut.isPending} className="btn-primary">{t("drivers.createDialogTitle")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit Dialog ──────────────────────────────────── */}
      {editOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setEditOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("drivers.editDialogTitle")}</h2>
              <button onClick={() => setEditOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            {renderFormFields(editForm, setEditForm)}
            <div className="flex justify-end gap-3">
              <button onClick={() => setEditOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleEdit} disabled={updateMut.isPending} className="btn-primary">{t("drivers.saveChanges")}</button>
            </div>
          </div>
        </div>
      )}
    </SettingsShell>
  );
}
