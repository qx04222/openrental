import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import DataTable, { Column } from "@/components/DataTable";
import { trpc } from "@/lib/trpc";
import ProvinceSelect from "@/components/ProvinceSelect";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { MemoryInput } from "@/components/MemoryInput";
import {
  Plus,
  Trash2,
  X,
  Pencil,
} from "lucide-react";
import ExportToolbar from "@/components/ExportToolbar";
import { useFormatCalendarDate, formatCalendarDateISO } from "@/lib/dateUtils";
import { useLocation, useSearch } from "wouter";
import { getPositiveSearchParam } from "@/lib/adminSearchNavigation";
import { serverErrorText } from "@/lib/serverError";
import { translateDynamic } from "@/lib/i18nHelpers";

type TabFilter = "all" | "active" | "completed" | "on_hold";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  completed: "bg-slate-100 text-slate-700",
  on_hold: "bg-yellow-100 text-yellow-700",
};

const emptyForm = {
  customerId: "",
  name: "",
  poNumber: "",
  siteAddress: "",
  city: "",
  province: "",
  postalCode: "",
  contactName: "",
  contactPhone: "",
  startDate: "",
  endDate: "",
  notes: "",
};

export default function Projects() {
  const { t } = useTranslation(["admin", "common"]);
  const utils = trpc.useUtils();
  const search = useSearch();
  const [, navigate] = useLocation();
  const linkedProjectId = getPositiveSearchParam(search, "projectId");

  // ─── Data fetching ──────────────────────────────────────────
  const [tab, setTab] = useState<TabFilter>("all");
  const { data: projectData, isLoading } = trpc.projects.list.useQuery(
    tab === "all" ? undefined : { status: tab }
  );
  const { data: customers } = trpc.customers.list.useQuery();

  // ─── Mutations ──────────────────────────────────────────────
  const createMut = trpc.projects.create.useMutation({
    onSuccess: () => {
      utils.projects.list.invalidate();
      setCreateOpen(false);
      toast.success(t("projects.createSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateMut = trpc.projects.update.useMutation({
    onSuccess: () => {
      utils.projects.list.invalidate();
      setEditOpen(false);
      toast.success(t("projects.updateSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deleteMut = trpc.projects.delete.useMutation({
    onSuccess: () => {
      utils.projects.list.invalidate();
      toast.success(t("projects.deleteSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Detail state ──────────────────────────────────────────
  const [detailId, setDetailId] = useState<number | null>(null);
  useEffect(() => {
    if (linkedProjectId) setDetailId(linkedProjectId);
  }, [linkedProjectId]);
  const { data: detailData } = trpc.projects.getById.useQuery({ id: detailId! }, { enabled: !!detailId });
  const { data: summaryData } = trpc.projects.summary.useQuery({ id: detailId! }, { enabled: !!detailId });

  // ─── Dialog state ──────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyForm);

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);

  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeEdit = useCallback(() => setEditOpen(false), []);
  const closeDetail = useCallback(() => {
    setDetailId(null);
    if (linkedProjectId) navigate("/admin/projects");
  }, [linkedProjectId, navigate]);
  useEscapeKey(!!detailId, closeDetail);
  useEscapeKey(createOpen, closeCreate);
  useEscapeKey(editOpen, closeEdit);

  // ─── Handlers ──────────────────────────────────────────────
  const openCreate = () => {
    setCreateForm(emptyForm);
    setCreateOpen(true);
  };

  const handleCreate = () => {
    const customerId = parseInt(createForm.customerId, 10);
    if (!customerId || isNaN(customerId)) return toast.error(t("projects.selectCustomer"));
    if (!createForm.name.trim()) return toast.error(t("projects.nameRequired"));
    createMut.mutate({
      customerId,
      name: createForm.name,
      poNumber: createForm.poNumber || undefined,
      siteAddress: createForm.siteAddress || undefined,
      city: createForm.city || undefined,
      province: createForm.province || undefined,
      postalCode: createForm.postalCode || undefined,
      contactName: createForm.contactName || undefined,
      contactPhone: createForm.contactPhone || undefined,
      startDate: createForm.startDate || undefined,
      endDate: createForm.endDate || undefined,
      notes: createForm.notes || undefined,
    });
  };

  const openEdit = (row: ProjectRow) => {
    setEditId(row.projects.id);
    setEditForm({
      customerId: String(row.projects.customerId),
      name: row.projects.name,
      poNumber: row.projects.poNumber || "",
      siteAddress: row.projects.siteAddress || "",
      city: row.projects.city || "",
      province: row.projects.province || "",
      postalCode: row.projects.postalCode || "",
      contactName: row.projects.contactName || "",
      contactPhone: row.projects.contactPhone || "",
      startDate: row.projects.startDate ? formatCalendarDateISO(row.projects.startDate) : "",
      endDate: row.projects.endDate ? formatCalendarDateISO(row.projects.endDate) : "",
      notes: row.projects.notes || "",
    });
    setEditOpen(true);
  };

  const handleEdit = () => {
    if (!editId) return;
    const customerId = parseInt(editForm.customerId, 10);
    if (!customerId || isNaN(customerId)) return toast.error(t("projects.selectCustomer"));
    if (!editForm.name.trim()) return toast.error(t("projects.nameRequired"));
    updateMut.mutate({
      id: editId,
      name: editForm.name,
      poNumber: editForm.poNumber || undefined,
      siteAddress: editForm.siteAddress || undefined,
      city: editForm.city || undefined,
      province: editForm.province || undefined,
      postalCode: editForm.postalCode || undefined,
      contactName: editForm.contactName || undefined,
      contactPhone: editForm.contactPhone || undefined,
      startDate: editForm.startDate || undefined,
      endDate: editForm.endDate || undefined,
      notes: editForm.notes || undefined,
    });
  };

  // ─── Helpers ──────────────────────────────────────────────
  const fmtDate = useFormatCalendarDate();

  // ─── Table data ──────────────────────────────────────────
  type ProjectRow = NonNullable<typeof projectData>[number];

  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set());
  const [filteredData, setFilteredData] = useState<ProjectRow[]>([]);
  const [pageTableData, setPageTableData] = useState<ProjectRow[]>([]);

  const handleDataReady = useCallback((info: { filtered: ProjectRow[]; pageData: ProjectRow[] }) => {
    setFilteredData(info.filtered);
    setPageTableData(info.pageData);
  }, []);

  const columns: Column<ProjectRow>[] = [
    {
      key: "projects.name",
      label: t("projects.columnName"),
      render: (row) => <span className="text-slate-900 font-medium">{row.projects.name}</span>,
    },
    {
      key: "projects.poNumber",
      label: t("projects.columnPO"),
      render: (row) => <span className="text-sm text-slate-700">{row.projects.poNumber || "-"}</span>,
      hideOnMobile: true,
    },
    {
      key: "customers.name",
      label: t("projects.columnCustomer"),
      render: (row) => row.customers?.name || "-",
      hideOnMobile: true,
    },
    {
      key: "projects.siteAddress",
      label: t("projects.columnSiteAddress"),
      render: (row) => <span className="text-sm text-slate-500">{row.projects.siteAddress || "-"}</span>,
      hideOnMobile: true,
    },
    {
      key: "projects.province",
      label: t("projects.columnProvince"),
      render: (row) => <span className="text-sm text-slate-500">{row.projects.province || "-"}</span>,
      hideOnMobile: true,
    },
    {
      key: "projects.status",
      label: t("projects.columnStatus"),
      render: (row) => {
        const status = row.projects.status;
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] || "bg-slate-100 text-slate-700"}`}>
            {status.replace(/_/g, " ")}
          </span>
        );
      },
    },
    {
      key: "projects.startDate",
      label: t("projects.columnStartDate"),
      render: (row) => <span className="text-sm text-slate-500">{fmtDate(row.projects.startDate)}</span>,
      hideOnMobile: true,
    },
    {
      key: "_actions",
      label: t("projects.columnActions"),
      sortable: false,
      searchable: false,
      render: (row) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => openEdit(row)}
            className="tap-target text-slate-500 hover:text-slate-900"
            aria-label="Edit project"
            title={t("projects.editTooltip")}
          >
            <Pencil size={16} />
          </button>
          <button
            onClick={() => {
              if (confirm(t("projects.deleteConfirm"))) deleteMut.mutate({ id: row.projects.id });
            }}
            className="tap-target text-slate-400 hover:text-[var(--primary)]"
            aria-label="Delete project"
            title={t("projects.deleteTooltip")}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  // ─── Tab config ──────────────────────────────────────────
  const tabs: { key: TabFilter; label: string }[] = [
    { key: "all", label: t("projects.tabAll") },
    { key: "active", label: t("projects.tabActive") },
    { key: "completed", label: t("projects.tabCompleted") },
    { key: "on_hold", label: t("projects.tabOnHold") },
  ];

  // ─── Form fields renderer ──────────────────────────────────
  const renderFormFields = (form: typeof emptyForm, setForm: (f: typeof emptyForm) => void) => (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formCustomer")} <span className="text-[var(--primary)]">*</span></label>
          <select value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
            <option value="">{t("projects.selectCustomerPlaceholder")}</option>
            {(customers || []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formProjectName")} <span className="text-[var(--primary)]">*</span></label>
          <MemoryInput memoryKey="project-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("projects.projectNamePlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formPO")}</label>
          <input value={form.poNumber} onChange={(e) => setForm({ ...form, poNumber: e.target.value })} placeholder={t("projects.poPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formSiteAddress")}</label>
          <MemoryInput memoryKey="project-site-address" value={form.siteAddress} onChange={(e) => setForm({ ...form, siteAddress: e.target.value })} placeholder="123 Main St" className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formCity")}</label>
          <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder={t("projects.formCity")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formProvince")}</label>
          <ProvinceSelect value={form.province} onChange={(v) => setForm({ ...form, province: v })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formPostalCode")}</label>
          <input value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} placeholder={t("projects.placeholderPostalCode")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formContactName")}</label>
          <MemoryInput memoryKey="project-contact-name" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} placeholder={t("projects.formContactName")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formContactPhone")}</label>
          <input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} placeholder="(555) 123-4567" className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formStartDate")}</label>
          <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formEndDate")}</label>
          <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">{t("projects.formNotes")}</label>
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} placeholder={t("projects.notesPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
      </div>
    </div>
  );

  const exportColumns = [
    { key: "name", label: t("projects.columnName") },
    { key: "customer", label: t("projects.columnCustomer") },
    { key: "po", label: t("projects.columnPO") },
    { key: "status", label: t("projects.columnStatus") },
    { key: "city", label: t("projects.formCity") },
    { key: "province", label: t("projects.formProvince") },
  ];

  const mapProjectForExport = (p: ProjectRow) => ({
    name: p.projects.name,
    customer: p.customers?.name || "",
    po: p.projects.poNumber || "",
    status: p.projects.status || "",
    city: p.projects.city || "",
    province: p.projects.province || "",
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("projects.pageTitle")}</h1>
          <div className="flex items-center gap-2">
            <ExportToolbar
              allData={filteredData.map(mapProjectForExport)}
              pageData={pageTableData.map(mapProjectForExport)}
              selectedData={Array.from(selectedKeys).map(k => {
                const r = (projectData || []).find((_, i) => i === k);
                return r ? mapProjectForExport(r) : null;
              }).filter(Boolean) as Record<string, unknown>[]}
              columns={exportColumns}
              fileName="projects"
              title={t("projects.pageTitle")}
            />
            <button onClick={openCreate} className="btn-primary flex items-center gap-2">
              <Plus size={18} /> {t("projects.createButton")}
            </button>
          </div>
        </div>

        {/* Tab Filters */}
        <div className="flex gap-1 border-b border-slate-200">
          {tabs.map((tabItem) => (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === tabItem.key
                  ? "border-[var(--primary)] text-[var(--primary)]"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tabItem.label}
            </button>
          ))}
        </div>

        {/* Table */}
        <DataTable
          data={projectData || []}
          columns={columns}
          isLoading={isLoading}
          onRowClick={(row) => setDetailId(row.projects.id)}
          emptyMessage={t("projects.noProjectsFound")}
          searchPlaceholder={t("projects.searchPlaceholder")}
          selectable
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
          onDataReady={handleDataReady}
        />
      </div>

      {/* ─── Create Dialog ─────────────────────────────────── */}
      {createOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setCreateOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("projects.createDialogTitle")}</h2>
              <button onClick={() => setCreateOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            {renderFormFields(createForm, setCreateForm)}
            <div className="flex justify-end gap-3">
              <button onClick={() => setCreateOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleCreate} disabled={createMut.isPending} className="btn-primary">{t("projects.createDialogTitle")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit Dialog ──────────────────────────────────── */}
      {editOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setEditOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("projects.editDialogTitle")}</h2>
              <button onClick={() => setEditOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            {renderFormFields(editForm, setEditForm)}
            <div className="flex justify-end gap-3">
              <button onClick={() => setEditOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleEdit} disabled={updateMut.isPending} className="btn-primary">{t("projects.saveChanges")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Detail Dialog ─────────────────────────────────── */}
      {detailId && detailData && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={closeDetail}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-4xl p-6 space-y-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex justify-between items-start">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{detailData.projects.name}</h2>
                {detailData.projects.poNumber && (
                  <p className="text-sm text-slate-500">{t("projects.columnPO")} {detailData.projects.poNumber}</p>
                )}
              </div>
              <button onClick={closeDetail} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>

            {/* Project Info */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500">{t("projects.columnCustomer")}</p>
                <p className="text-sm font-medium text-slate-900">{detailData.customers?.name || "-"}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500">{t("projects.columnSiteAddress")}</p>
                <p className="text-sm font-medium text-slate-900">{detailData.projects.siteAddress || "-"}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500">{t("projects.columnStartDate")}</p>
                <p className="text-sm font-medium text-slate-900">{fmtDate(detailData.projects.startDate)}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500">{t("projects.columnStatus")}</p>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[detailData.projects.status] || "bg-slate-100 text-slate-700"}`}>
                  {detailData.projects.status.replace(/_/g, " ")}
                </span>
              </div>
            </div>

            {/* Summary Cards */}
            {summaryData && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-blue-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-blue-600">{t("projects.summaryTotalRentals")}</p>
                  <p className="text-xl font-bold text-blue-700">{summaryData.totalRentals}</p>
                </div>
                <div className="bg-green-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-green-600">{t("projects.summaryTotalRevenue")}</p>
                  <p className="text-xl font-bold text-green-700">{formatCurrency(summaryData.totalRevenue)}</p>
                </div>
                <div className="bg-orange-50 rounded-lg p-3 text-center">
                  <p className="text-xs text-orange-600">{t("projects.summaryActiveRentals")}</p>
                  <p className="text-xl font-bold text-orange-700">{summaryData.activeRentals}</p>
                </div>
              </div>
            )}

            {/* Related Rentals */}
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">{t("projects.relatedRentalsHeading")} ({detailData.rentals?.length || 0})</h3>
              {detailData.rentals && detailData.rentals.length > 0 ? (
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 text-xs">
                      <tr>
                        <th className="px-3 py-2">{t("projects.columnId")}</th>
                        <th className="px-3 py-2">{t("projects.columnCustomer")}</th>
                        <th className="px-3 py-2">{t("projects.columnStatus")}</th>
                        <th className="px-3 py-2">{t("projects.columnDates")}</th>
                        <th className="px-3 py-2">{t("projects.columnTotal")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.rentals.map((r) => (
                        <tr key={r.id} className="border-t border-slate-100">
                          <td className="px-3 py-2 text-slate-900 font-medium">#{r.id}</td>
                          <td className="px-3 py-2 text-slate-700">{r.customerName}</td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[r.status] || "bg-slate-100 text-slate-700"}`}>
                              {t(`status.${r.status}`, { ns: "common", defaultValue: r.status })}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-slate-500 text-xs">{fmtDate(r.startDate)} - {fmtDate(r.endDate)}</td>
                          <td className="px-3 py-2 text-slate-900">{r.totalAmount ? formatCurrency(parseFloat(r.totalAmount)) : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-400">{t("projects.noRentalsLinked")}</p>
              )}
            </div>

            {/* Related Invoices */}
            <div>
              <h3 className="text-sm font-semibold text-slate-700 mb-2">{t("projects.relatedInvoicesHeading")} ({detailData.invoices?.length || 0})</h3>
              {detailData.invoices && detailData.invoices.length > 0 ? (
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 text-slate-500 text-xs">
                      <tr>
                        <th className="px-3 py-2">{t("projects.columnInvoiceNo")}</th>
                        <th className="px-3 py-2">{t("projects.columnStatus")}</th>
                        <th className="px-3 py-2">{t("projects.columnIssueDate")}</th>
                        <th className="px-3 py-2">{t("projects.columnTotal")}</th>
                        <th className="px-3 py-2">{t("projects.columnBalanceDue")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.invoices.map((inv) => (
                        <tr key={inv.id} className="border-t border-slate-100">
                          <td className="px-3 py-2 text-slate-900 font-medium">{inv.invoiceNumber}</td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              inv.status === "paid" ? "bg-green-100 text-green-700" :
                              inv.status === "overdue" ? "bg-red-100 text-red-700" :
                              inv.status === "sent" ? "bg-blue-100 text-blue-700" :
                              "bg-slate-100 text-slate-700"
                            }`}>
                              {translateDynamic(t, `invoices.status${inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}`, { defaultValue: inv.status })}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-slate-500 text-xs">{fmtDate(inv.issueDate)}</td>
                          <td className="px-3 py-2 text-slate-900">{formatCurrency(parseFloat(inv.totalAmount ?? "0"))}</td>
                          <td className="px-3 py-2 text-slate-900">{formatCurrency(parseFloat(inv.balanceDue ?? "0"))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-400">{t("projects.noInvoicesLinked")}</p>
              )}
            </div>

            {/* Close button */}
            <div className="flex justify-end pt-2">
              <button onClick={closeDetail} className="btn-secondary">{t("projects.close")}</button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
