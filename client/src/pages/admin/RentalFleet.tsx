import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSearch, useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, X, Eye, ImageIcon, ChevronDown, ChevronUp, ArrowUp, ArrowDown, ArrowUpDown, Wrench, RotateCcw } from "lucide-react";
import { fleetStatusColors as statusColors, maintStatusColors } from "@/lib/statusColors";
import FleetDetailDialog from "./FleetDetailDialog";
import { compressImage } from "@/lib/imageUtils";
import { formatCalendarDateISO } from "@/lib/dateUtils";
import CategorySelect from "@/components/CategorySelect";
import { getPositiveSearchParam } from "@/lib/adminSearchNavigation";
import { serverErrorText } from "@/lib/serverError";
import { canUseModulePermission } from "@/lib/modulePermissions";

type FleetCurrentStatus = "available" | "rented" | "maintenance" | "retired";

const emptyForm = {
  brand: "", model: "", category: "", dailyRate: "", weeklyRate: "", monthlyRate: "",
  serialNumber: "", condition: "good" as "excellent" | "good" | "fair" | "poor", year: "", locationId: "",
  division: "", engineHours: "", odometerReading: "", imageUrl: "", notes: "",
  catalogCacheId: null as number | null,
  currentStatus: "available" as FleetCurrentStatus,
  // New fields
  vin: "", purchaseDate: "", purchaseCost: "",
  lastMaintenanceDate: "", nextMaintenanceDate: "",
  lastServiceHours: "", serviceInterval: "250", maintenanceStatus: "ok",
};

export default function RentalFleet() {
  const { t } = useTranslation(["fleet", "common"]);
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const can = (module: Parameters<typeof canUseModulePermission>[1], action: Parameters<typeof canUseModulePermission>[2]) =>
    canUseModulePermission(myPerms, module, action);
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.rentalFleet.list.useQuery();
  const { data: usageData } = trpc.rentalFleet.usageStats.useQuery();
  type UsageRow = NonNullable<typeof usageData>[number];
  const usageMap = useMemo(() => {
    const m = new Map<number, UsageRow>();
    (usageData || []).forEach((u) => m.set(u.fleetId, u));
    return m;
  }, [usageData]);
  // `currentStatus` is physical possession only. A unit can read "available"
  // here while an open work order or an unfinished return makes it unpickable
  // in the order form — so mark that on the badge instead of letting the two
  // pages contradict each other.
  const { data: blocksData } = trpc.rentalFleet.operationalBlocks.useQuery();
  const blockMap = useMemo(() => {
    const m = new Map<number, NonNullable<typeof blocksData>[number]>();
    (blocksData || []).forEach((b) => m.set(b.fleetId, b));
    return m;
  }, [blocksData]);
  const { data: warehouses } = trpc.warehouses.list.useQuery();
  const { data: catalog } = trpc.catalogSync.getCatalog.useQuery();
  const { data: modelsData } = trpc.equipmentModels.list.useQuery();
  const createMut = trpc.rentalFleet.create.useMutation({ onSuccess: () => { utils.rentalFleet.list.invalidate(); utils.rentalFleet.usageStats.invalidate(); setOpen(false); toast.success(t("assetCreated")); }, onError: (err) => toast.error(serverErrorText(err)) });
  const updateMut = trpc.rentalFleet.update.useMutation({ onSuccess: () => { utils.rentalFleet.list.invalidate(); utils.rentalFleet.usageStats.invalidate(); setOpen(false); toast.success(t("assetUpdated")); }, onError: (err) => toast.error(serverErrorText(err)) });
  const deleteMut = trpc.rentalFleet.delete.useMutation({ onSuccess: () => { utils.rentalFleet.list.invalidate(); utils.rentalFleet.usageStats.invalidate(); toast.success(t("assetDeleted")); }, onError: (err) => toast.error(serverErrorText(err)) });
  const fleetImageMut = trpc.rentalFleet.uploadImage.useMutation();

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [_selectedModelId, setSelectedModelId] = useState<string>("");
  const [internalOpen, setInternalOpen] = useState(false);
  const [detailFleet, setDetailFleet] = useState<{ id: number; label: string } | null>(null);
  const [imageCompressing, setImageCompressing] = useState(false);
  const [priceOverrideEnabled, setPriceOverrideEnabled] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeModal = useCallback(() => setOpen(false), []);
  useEscapeKey(open, closeModal);

  type FleetListItem = NonNullable<typeof data>[number];
  type CatalogItem = NonNullable<typeof catalog>[number];
  type WarehouseItem = NonNullable<typeof warehouses>[number];

  type SortKey =
    | "serialNumber" | "brand" | "model" | "year" | "category" | "location"
    | "status" | "maintStatus" | "rentedDays" | "hours" | "revenue" | "payback"
    | "daily" | "weekly" | "monthly";
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };
  const getSortValue = (item: FleetListItem, key: SortKey): string | number | null => {
    const f = item.rental_fleet;
    const wh = item.warehouses;
    switch (key) {
      case "serialNumber": return f.serialNumber || "";
      case "brand": return f.brand || "";
      case "model": return f.model || "";
      case "year": return f.year ?? null;
      case "category": return f.category || "";
      case "location": return wh?.name || "";
      case "status": return f.currentStatus || "";
      case "maintStatus": return f.maintenanceStatus || "";
      case "rentedDays": return usageMap.get(f.id)?.totalRentedDays ?? null;
      case "hours": {
        const u = usageMap.get(f.id);
        return u?.hasHoursData ? u.totalOperatingHours : null;
      }
      case "revenue": return usageMap.get(f.id)?.lifetimeRevenue ?? null;
      case "payback": return usageMap.get(f.id)?.paybackProgress ?? null;
      case "daily": { const v = item.resolvedDailyRate; return v && v !== "0" ? Number(v) : null; }
      case "weekly": { const v = item.resolvedWeeklyRate; return v && v !== "0" ? Number(v) : null; }
      case "monthly": { const v = item.resolvedMonthlyRate; return v && v !== "0" ? Number(v) : null; }
    }
  };
  // Deep-link filters: ?status= narrows by fleet status; ?filter=no-cost
  // narrows to assets without purchaseCost so the Dashboard ROI banner can
  // land users on a focused fix list.
  const search = useSearch();
  const [, navigate] = useLocation();
  const linkedFleetId = getPositiveSearchParam(search, "fleetId");
  useEffect(() => {
    if (!linkedFleetId) return;
    const match = data?.find((item) => item.rental_fleet.id === linkedFleetId)?.rental_fleet;
    setDetailFleet({
      id: linkedFleetId,
      label: match ? `${match.brand} ${match.model}` : `#${linkedFleetId}`,
    });
  }, [data, linkedFleetId]);
  const closeFleetDetail = useCallback(() => {
    setDetailFleet(null);
    if (linkedFleetId) navigate("/admin/rental-fleet");
  }, [linkedFleetId, navigate]);
  const statusFilter = useMemo(() => {
    const v = new URLSearchParams(search).get("status");
    return v && (["available", "rented", "maintenance", "retired"] as const).includes(v as FleetCurrentStatus)
      ? (v as FleetCurrentStatus)
      : null;
  }, [search]);
  const noCostFilter = useMemo(() => {
    return new URLSearchParams(search).get("filter") === "no-cost";
  }, [search]);
  const filteredData = useMemo(() => {
    let rows = data || [];
    if (statusFilter) rows = rows.filter((it) => it.rental_fleet.currentStatus === statusFilter);
    if (noCostFilter) rows = rows.filter((it) => {
      const c = it.rental_fleet.purchaseCost;
      return c == null || c === "" || Number(c) === 0;
    });
    return rows;
  }, [data, statusFilter, noCostFilter]);
  const clearFilters = () => navigate("/admin/rental-fleet");

  const sortedData = sortKey
    ? [...filteredData].sort((a, b) => {
        const va = getSortValue(a, sortKey);
        const vb = getSortValue(b, sortKey);
        const aEmpty = va == null || va === "";
        const bEmpty = vb == null || vb === "";
        if (aEmpty && bEmpty) return 0;
        if (aEmpty) return 1;
        if (bEmpty) return -1;
        const cmp = typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
        return sortDir === "asc" ? cmp : -cmp;
      })
    : filteredData;
  const SortIcon = ({ k }: { k: SortKey }) =>
    sortKey === k
      ? (sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
      : <ArrowUpDown size={12} className="opacity-30" />;
  const sortBtnCls = "flex items-center gap-1 hover:text-slate-700 cursor-pointer select-none";

  const openAdd = () => { setEditId(null); setForm(emptyForm); setSelectedModelId(""); setPriceOverrideEnabled(false); setOpen(true); };
  const openEdit = (item: FleetListItem) => {
    const f = item.rental_fleet;
    setEditId(f.id);
    setForm({
      brand: f.brand,
      model: f.model,
      category: f.category || "",
      dailyRate: f.dailyRate || "",
      weeklyRate: f.weeklyRate || "",
      monthlyRate: f.monthlyRate || "",
      serialNumber: f.serialNumber || "",
      condition: f.condition || "good",
      year: f.year ? String(f.year) : "",
      locationId: f.locationId ? String(f.locationId) : "",
      division: f.division || "",
      engineHours: f.engineHours ? String(f.engineHours) : "",
      odometerReading: f.odometerReading ? String(f.odometerReading) : "",
      imageUrl: f.imageUrl || "",
      notes: f.notes || "",
      catalogCacheId: f.catalogCacheId,
      currentStatus: (f.currentStatus as FleetCurrentStatus) || "available",
      vin: f.vin || "",
      purchaseDate: f.purchaseDate ? formatCalendarDateISO(f.purchaseDate) : "",
      purchaseCost: f.purchaseCost || "",
      lastMaintenanceDate: f.lastMaintenanceDate ? formatCalendarDateISO(f.lastMaintenanceDate) : "",
      nextMaintenanceDate: f.nextMaintenanceDate ? formatCalendarDateISO(f.nextMaintenanceDate) : "",
      lastServiceHours: f.lastServiceHours ? String(f.lastServiceHours) : "",
      serviceInterval: f.serviceInterval ? String(f.serviceInterval) : "250",
      maintenanceStatus: f.maintenanceStatus || "ok",
    });
    // If fleet has explicit rates set, enable override mode
    setPriceOverrideEnabled(!!(f.dailyRate || f.weeklyRate || f.monthlyRate));
    setOpen(true);
  };

  // Find category-level pricing: pick first non-empty rate across all models in the category
  const inheritedRates = (() => {
    if (!form.category || !modelsData) return null;
    const categoryModels = modelsData.filter((m) => m.category === form.category);
    if (categoryModels.length === 0) return null;
    let daily = "", weekly = "", monthly = "";
    for (const m of categoryModels) {
      if (!daily && m.dailyRate) daily = m.dailyRate;
      if (!weekly && m.weeklyRate) weekly = m.weeklyRate;
      if (!monthly && m.monthlyRate) monthly = m.monthlyRate;
    }
    return (daily || weekly || monthly) ? { daily, weekly, monthly } : null;
  })();

  const handleQuickEntry = (catalogId: string) => {
    if (!catalogId) return;
    const item = (catalog || []).find((c: CatalogItem) => c.id === Number(catalogId));
    if (item) {
      setForm((prev) => ({
        ...prev,
        catalogCacheId: item.id,
        brand: item.brand,
        model: item.model,
        category: item.category || prev.category,
        year: item.modelYear ? String(item.modelYear) : prev.year,
        imageUrl: item.imageUrl || prev.imageUrl,
      }));
    }
  };

  const processImageFile = (file: File | null | undefined) => {
    // Android/Huawei camera intents occasionally return no file or an empty file
    if (!file || file.size === 0) {
      toast.error(t("imageUploadFailed"));
      return;
    }
    setImageCompressing(true);
    let done = false;
    const finish = (errMsg?: string) => {
      if (done) return;
      done = true;
      window.clearTimeout(watchdog);
      setImageCompressing(false);
      if (errMsg) toast.error(errMsg);
    };
    const watchdog = window.setTimeout(() => finish(t("imageUploadFailed")), 20000);
    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result !== "string") return finish(t("imageUploadFailed"));
      try {
        const compressed = await compressImage(reader.result);
        const { url } = await fleetImageMut.mutateAsync({ base64Image: compressed });
        setForm((prev) => ({ ...prev, imageUrl: url }));
        finish();
      } catch (err) {
        finish(err instanceof Error ? err.message : t("imageUploadFailed"));
      }
    };
    reader.onerror = () => finish(t("imageUploadFailed"));
    reader.readAsDataURL(file);
  };

  const handleSubmit = () => {
    if (imageCompressing) return toast.error(t("photoStillSaving"));
    // For new assets, require catalog selection
    if (!editId && !form.catalogCacheId) return toast.error(t("catalogRequired"));
    if (!form.division) return toast.error(t("divisionRequired"));
    if (!form.brand || !form.model) return toast.error(t("brandModelRequired"));
    const payload: Parameters<typeof createMut.mutate>[0] = {
      brand: form.brand,
      model: form.model,
      category: form.category || undefined,
      dailyRate: priceOverrideEnabled ? (form.dailyRate || undefined) : undefined,
      weeklyRate: priceOverrideEnabled ? (form.weeklyRate || undefined) : undefined,
      monthlyRate: priceOverrideEnabled ? (form.monthlyRate || undefined) : undefined,
      serialNumber: form.serialNumber || undefined,
      condition: form.condition,
      year: form.year ? Number(form.year) : undefined,
      locationId: form.locationId ? Number(form.locationId) : undefined,
      division: form.division || undefined,
      engineHours: form.engineHours ? Number(form.engineHours) : undefined,
      odometerReading: form.odometerReading ? Number(form.odometerReading) : undefined,
      imageUrl: form.imageUrl || undefined,
      notes: form.notes || undefined,
      catalogCacheId: form.catalogCacheId,
      ...(editId && form.currentStatus !== "rented" ? { currentStatus: form.currentStatus } : {}),
      vin: form.vin || undefined,
      purchaseDate: form.purchaseDate || undefined,
      purchaseCost: form.purchaseCost || undefined,
      lastMaintenanceDate: form.lastMaintenanceDate || undefined,
      nextMaintenanceDate: form.nextMaintenanceDate || undefined,
      lastServiceHours: form.lastServiceHours ? Number(form.lastServiceHours) : undefined,
      serviceInterval: form.serviceInterval ? Number(form.serviceInterval) : undefined,
      maintenanceStatus: form.maintenanceStatus || undefined,
    };
    if (editId) updateMut.mutate({ id: editId, ...payload });
    else createMut.mutate(payload);
  };

  const inputClass = "bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full";

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("title")}</h1>
          {can('fleet', 'create') && <button onClick={openAdd} className="btn-primary flex items-center gap-2"><Plus size={18} /> {t("addAsset")}</button>}
        </div>

        {(statusFilter || noCostFilter) && (
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--primary)]/10 text-[var(--primary)] text-sm font-medium">
            <span>{t("filterActive")}: {statusFilter ? t(`fleetStatus.${statusFilter}`) : t("filterNoCost")}</span>
            <button onClick={clearFilters} className="hover:text-[var(--primary)]/70" aria-label="Clear filter"><X size={14} /></button>
          </div>
        )}

        <div className="card overflow-x-auto">
          {isLoading ? <div className="flex items-center justify-center py-12"><div className="spinner" /><span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span></div> : (
            <table className="w-full text-sm text-left">
              <thead className="text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4 hidden md:table-cell">
                    <button onClick={() => toggleSort("serialNumber")} className={sortBtnCls}>{t("serialNumber")} <SortIcon k="serialNumber" /></button>
                  </th>
                  <th className="py-3 px-4">
                    <button onClick={() => toggleSort("brand")} className={sortBtnCls}>{t("brand")} <SortIcon k="brand" /></button>
                  </th>
                  <th className="py-3 px-4">
                    <button onClick={() => toggleSort("model")} className={sortBtnCls}>{t("model")} <SortIcon k="model" /></button>
                  </th>
                  <th className="py-3 px-4 hidden md:table-cell">
                    <button onClick={() => toggleSort("year")} className={sortBtnCls}>{t("year")} <SortIcon k="year" /></button>
                  </th>
                  <th className="py-3 px-4 hidden md:table-cell">
                    <button onClick={() => toggleSort("category")} className={sortBtnCls}>{t("category")} <SortIcon k="category" /></button>
                  </th>
                  <th className="py-3 px-4 hidden md:table-cell">
                    <button onClick={() => toggleSort("location")} className={sortBtnCls}>{t("location")} <SortIcon k="location" /></button>
                  </th>
                  <th className="py-3 px-4">
                    <button onClick={() => toggleSort("status")} className={sortBtnCls}>{t("status", { ns: "common" })} <SortIcon k="status" /></button>
                  </th>
                  <th className="py-3 px-4 hidden md:table-cell">
                    <button onClick={() => toggleSort("maintStatus")} className={sortBtnCls}>{t("maintStatus")} <SortIcon k="maintStatus" /></button>
                  </th>
                  <th className="py-3 px-4 hidden md:table-cell whitespace-nowrap">
                    <button onClick={() => toggleSort("revenue")} className={sortBtnCls}>{t("usage.column")} / {t("section.revenue")} <SortIcon k="revenue" /></button>
                  </th>
                  <th className="py-3 px-4 hidden lg:table-cell">
                    <button onClick={() => toggleSort("daily")} className={sortBtnCls}>{t("daily")} <SortIcon k="daily" /></button>
                  </th>
                  <th className="py-3 px-4 hidden lg:table-cell">
                    <button onClick={() => toggleSort("weekly")} className={sortBtnCls}>{t("weekly")} <SortIcon k="weekly" /></button>
                  </th>
                  <th className="py-3 px-4 hidden lg:table-cell">
                    <button onClick={() => toggleSort("monthly")} className={sortBtnCls}>{t("monthly")} <SortIcon k="monthly" /></button>
                  </th>
                  <th className="py-3 px-4">{t("actions", { ns: "common" })}</th>
                </tr>
              </thead>
              <tbody>
                {sortedData.map((item: FleetListItem) => {
                  const f = item.rental_fleet;
                  const wh = item.warehouses;
                  return (
                    <tr key={f.id} className="border-b border-slate-200/50 text-slate-600 hover:bg-slate-100/30">
                      <td className="py-3 px-4 text-slate-500 text-xs font-mono hidden md:table-cell">{f.serialNumber || "-"}</td>
                      <td className="py-3 px-4 text-slate-900 font-medium">{f.brand}</td>
                      <td className="py-3 px-4">{f.model}</td>
                      <td className="py-3 px-4 hidden md:table-cell">{f.year || "-"}</td>
                      <td className="py-3 px-4 hidden md:table-cell">{f.category || "-"}</td>
                      <td className="py-3 px-4 hidden md:table-cell">{wh?.name || "-"}</td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${statusColors[f.currentStatus] || ""}`}>{t(`fleetStatus.${f.currentStatus}`)}</span>
                        {(() => {
                          // Only worth flagging when the badge claims the unit is
                          // free — a "rented" badge on a live rental is not news.
                          const block = blockMap.get(f.id);
                          if (!block || f.currentStatus !== "available") return null;
                          const refs = block.refs.join(", ");
                          const label = block.reason === "rental"
                            ? t("blockedByRental")
                            : block.reason === "return"
                              ? t("blockedByReturn")
                              : t("blockedByWorkOrder");
                          return (
                            <div className="text-[11px] text-amber-600 mt-1 whitespace-nowrap" title={refs || undefined}>
                              ⚠ {label}{refs ? ` · ${refs}` : ""}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-3 px-4 hidden md:table-cell">
                        <span className={`text-xs font-medium ${maintStatusColors[f.maintenanceStatus ?? ""] || "text-slate-400"}`}>{t(f.maintenanceStatus === "due_soon" ? "maintDueSoon" : f.maintenanceStatus === "overdue" ? "maintOverdue" : "maintOk")}</span>
                      </td>
                      <td className="py-3 px-4 hidden md:table-cell whitespace-nowrap">
                        {(() => {
                          const u = usageMap.get(f.id);
                          if (!u) return <span className="text-slate-400">{t("usage.noData")}</span>;
                          const days = u.totalRentedDays;
                          const hasHours = u.hasHoursData;
                          const revenue = u.lifetimeRevenue;
                          const perDay = u.revenuePerDay;
                          const payback = u.paybackProgress;
                          return (
                            <div className="leading-tight space-y-0.5 min-w-[120px]">
                              <div className="text-slate-900 font-medium">
                                {days} {t("usage.daysShort")}
                                <span className="text-slate-400 mx-1">·</span>
                                <span className="text-emerald-700">${Math.round(revenue).toLocaleString()}</span>
                              </div>
                              <div className="text-[11px] text-slate-400">
                                {perDay != null ? `$${Math.round(perDay)}/${t("usage.daysShort")}` : t("usage.noData")}
                                <span className="mx-1">·</span>
                                {hasHours ? `${u.totalOperatingHours}${t("usage.hoursShort")}` : t("usage.noData")}
                              </div>
                              {payback != null && (
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <div className="flex-1 bg-slate-200 h-1 rounded-full overflow-hidden max-w-[80px]">
                                    <div
                                      className={`h-full rounded-full ${u.isPaidBack ? "bg-emerald-500" : "bg-blue-500"}`}
                                      style={{ width: `${Math.min(payback * 100, 100)}%` }}
                                    />
                                  </div>
                                  <span className={`text-[10px] font-medium ${u.isPaidBack ? "text-emerald-700" : "text-slate-500"}`}>
                                    {Math.round(payback * 100)}%
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="py-3 px-4 hidden lg:table-cell">{item.resolvedDailyRate && item.resolvedDailyRate !== "0" ? `$${item.resolvedDailyRate}` : "-"}</td>
                      <td className="py-3 px-4 hidden lg:table-cell">{item.resolvedWeeklyRate && item.resolvedWeeklyRate !== "0" ? `$${item.resolvedWeeklyRate}` : "-"}</td>
                      <td className="py-3 px-4 hidden lg:table-cell">{item.resolvedMonthlyRate && item.resolvedMonthlyRate !== "0" ? `$${item.resolvedMonthlyRate}` : "-"}</td>
                      <td className="py-3 px-4 flex gap-2">
                        <button onClick={() => setDetailFleet({ id: f.id, label: `${f.brand} ${f.model}` })} className="text-slate-500 hover:text-blue-600" aria-label="View details"><Eye size={16} /></button>
                        {can('fleet', 'update') && <button onClick={() => openEdit(item)} className="text-slate-500 hover:text-slate-900" aria-label="Edit asset"><Pencil size={16} /></button>}
                        {can('fleet', 'update') && f.currentStatus === "available" && (
                          <button
                            onClick={() => updateMut.mutate({ id: f.id, currentStatus: "maintenance" })}
                            disabled={updateMut.isPending}
                            className="text-slate-500 hover:text-amber-600 disabled:opacity-50"
                            aria-label="Mark unavailable"
                            title={t("markUnavailable")}
                          ><Wrench size={16} /></button>
                        )}
                        {can('fleet', 'update') && f.currentStatus === "maintenance" && (
                          <button
                            onClick={() => updateMut.mutate({ id: f.id, currentStatus: "available" })}
                            disabled={updateMut.isPending}
                            className="text-slate-500 hover:text-green-600 disabled:opacity-50"
                            aria-label="Mark available"
                            title={t("markAvailable")}
                          ><RotateCcw size={16} /></button>
                        )}
                        {can('fleet', 'delete') && <button onClick={() => { if (confirm(t("deleteConfirm"))) deleteMut.mutate({ id: f.id }); }} className="text-slate-500 hover:text-[var(--primary)]" aria-label="Delete asset"><Trash2 size={16} /></button>}
                      </td>
                    </tr>
                  );
                })}
                {sortedData.length === 0 && <tr><td colSpan={13} className="py-8 text-center text-slate-400">{t("noAssets")}</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-3xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{editId ? t("editAsset") : t("addAsset")}</h2>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>

            <div className="space-y-4">
              {/* ═══ CUSTOMER-VISIBLE SECTION ═══ */}
              <div className="border border-green-200 rounded-lg p-4 bg-green-50/30 space-y-4">
                <p className="text-sm font-semibold text-green-700">{t("customerVisible")}</p>

                {/* Division + Catalog Selection */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("division")} *</label>
                    <select
                      value={form.division}
                      onChange={(e) => {
                        const next = e.target.value;
                        if (form.division && form.division !== next) {
                          // Switching between non-empty divisions: reset catalog tie
                          setForm({ ...form, division: next, catalogCacheId: null, brand: "", model: "", category: "", year: "" });
                        } else {
                          // Filling empty -> value, keep existing brand/model intact
                          setForm({ ...form, division: next });
                        }
                      }}
                      disabled={!!editId && !!form.division}
                      className={inputClass}
                    >
                      <option value="">{t("selectDivision")}</option>
                      <option value="industrial">{t("divIndustrial")}</option>
                      <option value="powersports">{t("divPowersports")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{editId ? t("quickEntry") : t("selectCatalog") + " *"}</label>
                    <select onChange={(e) => handleQuickEntry(e.target.value)} className={inputClass} value={form.catalogCacheId ? String(form.catalogCacheId) : ""}>
                      <option value="">{t("selectFromCatalog")}</option>
                      {(catalog || []).map((c: CatalogItem) => (
                        <option key={c.id} value={c.id}>{c.brand} {c.model} {c.modelYear ? `(${c.modelYear})` : ""}</option>
                      ))}
                    </select>
                    {!editId && !form.catalogCacheId && (
                      <p className="text-xs text-[var(--primary)] mt-1">{t("catalogRequired")}</p>
                    )}
                  </div>
                </div>

                {/* Equipment Details — read-only when catalog selected */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(form.catalogCacheId || editId) ? (
                    <>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("brand")}</label>
                        <input value={form.brand} disabled className={`${inputClass} bg-slate-200 text-slate-500`} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("model")}</label>
                        <input value={form.model} disabled className={`${inputClass} bg-slate-200 text-slate-500`} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("year")}</label>
                        <input value={form.year} disabled className={`${inputClass} bg-slate-200 text-slate-500`} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("category")}</label>
                        <CategorySelect value={form.category} onChange={(v) => setForm({ ...form, category: v })} className={inputClass} />
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("brandRequired")}</label>
                        <input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("modelRequired")}</label>
                        <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("year")} *</label>
                        <input type="number" value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("category")}</label>
                        <CategorySelect value={form.category} onChange={(v) => setForm({ ...form, category: v })} className={inputClass} />
                      </div>
                    </>
                  )}
                </div>

                {/* Warehouse */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("selectWarehouse")}</label>
                    <select value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} className={inputClass}>
                      <option value="">{t("selectWarehouse")}</option>
                      {(warehouses || []).filter((w: WarehouseItem) => w.isActive).map((w: WarehouseItem) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("currentStatus")}</label>
                    <select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value as "excellent" | "good" | "fair" | "poor" })} className={inputClass}>
                      <option value="excellent">{t("condition.excellent", { ns: "common" })}</option>
                      <option value="good">{t("condition.good", { ns: "common" })}</option>
                      <option value="fair">{t("condition.fair", { ns: "common" })}</option>
                      <option value="poor">{t("condition.poor", { ns: "common" })}</option>
                    </select>
                  </div>
                </div>

                {editId && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("rentalStatus")}</label>
                      {form.currentStatus === "rented" ? (
                        <input value={`${t("fleetStatus.rented")} ${t("statusRentedHint")}`} disabled className={`${inputClass} bg-slate-200 text-slate-500`} />
                      ) : (
                        <select
                          value={form.currentStatus}
                          onChange={(e) => {
                            const v = e.target.value as FleetCurrentStatus;
                            if (v === "retired" && !confirm(t("confirmRetire"))) return;
                            setForm({ ...form, currentStatus: v });
                          }}
                          className={inputClass}
                        >
                          <option value="available">{t("fleetStatus.available")}</option>
                          <option value="maintenance">{t("fleetStatus.maintenance")}</option>
                          <option value="retired">{t("fleetStatus.retired")}</option>
                        </select>
                      )}
                    </div>
                  </div>
                )}

                {/* Pricing */}
                <div>
                  <p className="text-sm font-medium text-slate-700 mb-2">{t("pricing")}</p>

                  {/* Inherited pricing display */}
                  {inheritedRates && (inheritedRates.daily || inheritedRates.weekly || inheritedRates.monthly) ? (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 mb-3">
                      <p className="text-xs text-blue-700 font-medium mb-1">
                        {t("pricing.inherited")} [{form.category || "—"}]
                      </p>
                      <p className="text-sm text-blue-900">
                        {inheritedRates.daily ? `$${inheritedRates.daily}/${t("daily").toLowerCase()}` : ""}
                        {inheritedRates.weekly ? ` · $${inheritedRates.weekly}/${t("weekly").toLowerCase()}` : ""}
                        {inheritedRates.monthly ? ` · $${inheritedRates.monthly}/${t("monthly").toLowerCase()}` : ""}
                      </p>
                    </div>
                  ) : (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3">
                      <p className="text-xs text-slate-500">{t("pricing.noCategoryRates")}</p>
                    </div>
                  )}

                  {/* Override toggle */}
                  <label className="flex items-center gap-2 mb-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={priceOverrideEnabled}
                      onChange={(e) => {
                        setPriceOverrideEnabled(e.target.checked);
                        if (!e.target.checked) {
                          setForm({ ...form, dailyRate: "", weeklyRate: "", monthlyRate: "" });
                        }
                      }}
                      className="rounded border-slate-300 text-[var(--primary)] focus:ring-[var(--primary)]"
                    />
                    <span className="text-xs text-slate-600">{t("pricing.override")}</span>
                  </label>
                  <p className="text-xs text-slate-400 mb-2">{t("pricing.overrideHint")}</p>

                  {priceOverrideEnabled && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("dailyRate")}</label>
                        <input value={form.dailyRate} onChange={(e) => setForm({ ...form, dailyRate: e.target.value })} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("weeklyRate")}</label>
                        <input value={form.weeklyRate} onChange={(e) => setForm({ ...form, weeklyRate: e.target.value })} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("monthlyRate")}</label>
                        <input value={form.monthlyRate} onChange={(e) => setForm({ ...form, monthlyRate: e.target.value })} className={inputClass} />
                      </div>
                    </div>
                  )}
                </div>

                {/* Image */}
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("assetImage")}</label>
                  {form.imageUrl ? (
                    <div className="relative inline-block">
                      <img
                        src={form.imageUrl}
                        alt="Asset"
                        className="h-32 w-32 object-cover rounded-lg border border-slate-300"
                      />
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, imageUrl: "" })}
                        className="absolute -top-2 -right-2 bg-[var(--primary)] text-white rounded-full p-1 hover:bg-[var(--accent-hover)] shadow"
                        title={t("removeImage")}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div
                      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const file = e.dataTransfer.files?.[0];
                        if (file && !file.type.startsWith("image/")) return;
                        processImageFile(file);
                      }}
                      onClick={() => fileInputRef.current?.click()}
                      className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors"
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          processImageFile(file);
                        }}
                      />
                      {imageCompressing ? (
                        <div className="flex flex-col items-center gap-2 text-slate-400">
                          <div className="animate-spin h-6 w-6 border-2 border-blue-500 border-t-transparent rounded-full" />
                          <span className="text-xs">{t("uploadingImage")}</span>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-slate-400">
                          <ImageIcon size={24} />
                          <span className="text-xs">{t("dragDropImage")}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ═══ INTERNAL MANAGEMENT SECTION (collapsed by default) ═══ */}
              <div className="border border-slate-200 rounded-lg">
                <button
                  type="button"
                  onClick={() => setInternalOpen(!internalOpen)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-600 hover:text-slate-800"
                >
                  {t("internalManagement")}
                  {internalOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {internalOpen && (
                  <div className="px-4 pb-4 space-y-4">
                    {/* Identification */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("vinLabel")}</label>
                        <input value={form.vin} onChange={(e) => setForm({ ...form, vin: e.target.value })} maxLength={17} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("serialNumber")}</label>
                        <input value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("purchaseDate")}</label>
                        <input type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                          {t("purchaseCost")}
                          <span className="text-[10px] font-normal text-slate-400">— {t("payback.noCostBody")}</span>
                        </label>
                        <input value={form.purchaseCost} onChange={(e) => setForm({ ...form, purchaseCost: e.target.value })} className={inputClass} placeholder="0.00" />
                      </div>
                    </div>

                    {/* Usage */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("engineHours")}</label>
                        <input type="number" value={form.engineHours} onChange={(e) => setForm({ ...form, engineHours: e.target.value })} className={inputClass} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("mileage")}</label>
                        <input type="number" value={form.odometerReading} onChange={(e) => setForm({ ...form, odometerReading: e.target.value })} className={inputClass} />
                      </div>
                    </div>

                    {/* Maintenance */}
                    <div>
                      <p className="text-sm font-medium text-slate-700 mb-2">{t("maintenanceSection")}</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("lastMaintDate")}</label>
                          <input type="date" value={form.lastMaintenanceDate} onChange={(e) => setForm({ ...form, lastMaintenanceDate: e.target.value })} className={inputClass} />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("nextMaintDate")}</label>
                          <input type="date" value={form.nextMaintenanceDate} onChange={(e) => setForm({ ...form, nextMaintenanceDate: e.target.value })} className={inputClass} />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("lastSvcHours")}</label>
                          <input type="number" value={form.lastServiceHours} onChange={(e) => setForm({ ...form, lastServiceHours: e.target.value })} className={inputClass} />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("svcInterval")}</label>
                          <input type="number" value={form.serviceInterval} onChange={(e) => setForm({ ...form, serviceInterval: e.target.value })} className={inputClass} />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("maintStatus")}</label>
                          <select value={form.maintenanceStatus} onChange={(e) => setForm({ ...form, maintenanceStatus: e.target.value })} className={inputClass}>
                            <option value="ok">{t("maintOk")}</option>
                            <option value="due_soon">{t("maintDueSoon")}</option>
                            <option value="overdue">{t("maintOverdue")}</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Notes */}
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("notes")}</label>
                      <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={inputClass} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3">
              <button onClick={() => setOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleSubmit} disabled={createMut.isPending || updateMut.isPending || imageCompressing} className="btn-primary">{editId ? t("update", { ns: "common" }) : t("create", { ns: "common" })}</button>
            </div>
          </div>
        </div>
      )}
      {detailFleet && (
        <FleetDetailDialog
          fleetId={detailFleet.id}
          fleetLabel={detailFleet.label}
          onClose={closeFleetDetail}
        />
      )}
    </DashboardLayout>
  );
}
