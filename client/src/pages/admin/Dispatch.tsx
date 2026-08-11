import { useState, useCallback, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { Plus, X, Trash2, Pencil, List, Calendar, Columns3, FileDown } from "lucide-react";
import ExportToolbar from "@/components/ExportToolbar";
import { dispatchStatusColors as statusColors } from "@/lib/statusColors";
import type { DispatchStatus } from "@shared/dispatchTransitions";
import { useFormatCalendarDate, useAppTimezone, formatCalendarDate, formatCalendarDateISO } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";
import { canUseModulePermission } from "@/lib/modulePermissions";
import { translateDynamic } from "@/lib/i18nHelpers";

const DispatchCalendarView = lazy(() => import("@/components/dispatch/DispatchCalendarView"));
const DispatchKanbanView = lazy(() => import("@/components/dispatch/DispatchKanbanView"));

const statusOptions = ["pending", "assigned", "in_transit", "delivered", "completed", "cancelled"] as const;
type ViewMode = "list" | "calendar" | "kanban";

const emptyForm = { orderType: "delivery" as "delivery" | "pickup", deliveryAddress: "", pickupAddress: "", scheduledDate: "", scheduledTimeSlot: "", customTime: "", notes: "", assignedDriverId: "", rentalRequestId: "", priority: "normal", shippingCost: "", distance: "" };

const TIME_SLOT_OPTIONS = [
  { value: "", labelKey: "timeSlotPlaceholder" },
  { value: "7:00-9:00", labelKey: "timeSlot.morning" },
  { value: "9:00-12:00", labelKey: "timeSlot.midMorning" },
  { value: "12:00-15:00", labelKey: "timeSlot.afternoon" },
  { value: "15:00-18:00", labelKey: "timeSlot.lateAfternoon" },
  { value: "custom", labelKey: "timeSlot.custom" },
];

export default function Dispatch() {
  const { t } = useTranslation(["dispatch", "common"]);
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const can = (module: Parameters<typeof canUseModulePermission>[1], action: Parameters<typeof canUseModulePermission>[2]) =>
    canUseModulePermission(myPerms, module, action);
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.dispatch.list.useQuery();
  const { data: drivers } = trpc.drivers.list.useQuery();
  const { data: rentals } = trpc.rentals.listForDropdown.useQuery({ activeOnly: true });
  const createMut = trpc.dispatch.create.useMutation({ onSuccess: () => { utils.dispatch.list.invalidate(); setOpen(false); toast.success(t("orderCreated")); }, onError: (err) => toast.error(serverErrorText(err)) });
  const updateMut = trpc.dispatch.update.useMutation({
    onSuccess: () => { utils.dispatch.list.invalidate(); setOpen(false); setEditId(null); toast.success(t("orderUpdated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateStatus = trpc.dispatch.updateStatus.useMutation({ onSuccess: () => { utils.dispatch.list.invalidate(); toast.success(t("statusUpdated")); }, onError: (err) => toast.error(serverErrorText(err)) });
  const deleteMut = trpc.dispatch.delete.useMutation({
    onSuccess: () => { utils.dispatch.list.invalidate(); toast.success(t("orderDeleted")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const generatePDF = trpc.dispatch.generatePDF.useMutation({
    onSuccess: (result) => { window.open(result.url, "_blank"); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  // Which fleet unit a manual dispatch is for, encoded "lineItemId:fleetId".
  // Only meaningful for multi-item orders; single-item orders auto-resolve.
  const [unitKey, setUnitKey] = useState("");
  const closeModal = useCallback(() => setOpen(false), []);
  useEscapeKey(open, closeModal);

  const selectedRentalId = form.rentalRequestId ? Number(form.rentalRequestId) : undefined;
  const { data: fulfillmentUnits } = trpc.rentals.fulfillmentUnits.useQuery(
    { rentalId: selectedRentalId ?? 0 },
    { enabled: !!selectedRentalId && !editId },
  );

  const handleKanbanStatusChange = useCallback(
    (id: number, newStatus: DispatchStatus) => {
      updateStatus.mutate({ id, status: newStatus });
    },
    [updateStatus],
  );

  const handleCardClick = useCallback(
    (orderId: number) => {
      const row = (data || []).find((r) => r.dispatch_orders.id === orderId);
      if (row && ["pending", "assigned"].includes(row.dispatch_orders.status)) {
        openEdit(row.dispatch_orders);
      }
    },
    [data],
  );

  // When a rental is selected, auto-fill addresses based on order type
  const fillAddressesFromRental = (rentalId: string, orderType: "delivery" | "pickup") => {
    const rental = (rentals || []).find((r) => String(r.id) === rentalId);
    if (!rental) return;
    const customerAddress = rental.deliveryAddress || "";
    const equipmentAddress = rental.warehouseAddress || "";

    if (orderType === "delivery") {
      // Delivery: pick up from warehouse, deliver to customer
      setForm((prev) => ({
        ...prev,
        pickupAddress: equipmentAddress || prev.pickupAddress,
        deliveryAddress: customerAddress || prev.deliveryAddress,
      }));
    } else {
      // Pickup/Return: pick up from customer, deliver back to warehouse
      setForm((prev) => ({
        ...prev,
        pickupAddress: customerAddress || prev.pickupAddress,
        deliveryAddress: equipmentAddress || prev.deliveryAddress,
      }));
    }
  };

  const handleRentalSelect = (rentalId: string) => {
    setForm((prev) => ({ ...prev, rentalRequestId: rentalId }));
    setUnitKey("");
    if (!rentalId) return;
    fillAddressesFromRental(rentalId, form.orderType);
  };

  const handleOrderTypeChange = (orderType: "delivery" | "pickup") => {
    setForm((prev) => ({ ...prev, orderType }));
    if (form.rentalRequestId) {
      fillAddressesFromRental(form.rentalRequestId, orderType);
    }
  };

  const openEdit = (d: NonNullable<typeof data>[number]["dispatch_orders"]) => {
    setEditId(d.id);
    const timeSlotVal = (d.scheduledTimeSlot as string) || "";
    const isPreset = TIME_SLOT_OPTIONS.some((o) => o.value === timeSlotVal);
    setForm({
      orderType: d.orderType as "delivery" | "pickup",
      deliveryAddress: d.deliveryAddress || "",
      pickupAddress: d.pickupAddress || "",
      scheduledDate: d.scheduledDate ? formatCalendarDateISO(d.scheduledDate) : "",
      scheduledTimeSlot: isPreset ? timeSlotVal : (timeSlotVal ? "custom" : ""),
      customTime: isPreset ? "" : timeSlotVal,
      notes: d.notes || "",
      assignedDriverId: d.assignedDriverId ? String(d.assignedDriverId) : "",
      rentalRequestId: d.rentalRequestId ? String(d.rentalRequestId) : "",
      priority: d.priority || "normal",
      shippingCost: d.shippingCost || "",
      distance: d.distance || "",
    });
    setOpen(true);
  };

  const resolvedTimeSlot = form.scheduledTimeSlot === "custom" ? form.customTime : form.scheduledTimeSlot;

  const handleSubmit = () => {
    if (editId) {
      updateMut.mutate({
        id: editId,
        deliveryAddress: form.deliveryAddress || undefined,
        pickupAddress: form.pickupAddress || undefined,
        scheduledDate: form.scheduledDate || undefined,
        scheduledTimeSlot: resolvedTimeSlot || undefined,
        notes: form.notes || undefined,
        assignedDriverId: form.assignedDriverId ? Number(form.assignedDriverId) : undefined,
        priority: form.priority || undefined,
        shippingCost: form.shippingCost || undefined,
        distance: form.distance || undefined,
      });
    } else {
      const [unitLineItemId, unitFleetId] = unitKey
        ? unitKey.split(":").map((v) => (v === "null" || v === "" ? undefined : Number(v)))
        : [undefined, undefined];
      createMut.mutate({
        orderType: form.orderType,
        deliveryAddress: form.deliveryAddress || undefined,
        pickupAddress: form.pickupAddress || undefined,
        scheduledDate: form.scheduledDate || undefined,
        scheduledTimeSlot: resolvedTimeSlot || undefined,
        notes: form.notes || undefined,
        assignedDriverId: form.assignedDriverId ? Number(form.assignedDriverId) : undefined,
        rentalRequestId: form.rentalRequestId ? Number(form.rentalRequestId) : undefined,
        rentalLineItemId: unitLineItemId,
        rentalFleetId: unitFleetId,
      });
    }
  };

  const fmtDate = useFormatCalendarDate();
  const tz = useAppTimezone();

  // Already filtered to active-only by backend query
  const linkableRentals = rentals || [];

  const exportColumns = [
    { key: "id", label: "ID" },
    { key: "type", label: t("type") },
    { key: "status", label: t("status", { ns: "common" }) },
    { key: "rental", label: t("rental") + " #" },
    { key: "customer", label: t("customer") },
    { key: "address", label: t("deliveryAddress") },
    { key: "scheduledDate", label: t("scheduled") },
    { key: "driver", label: t("driver") },
  ];

  const mapDispatchForExport = (row: NonNullable<typeof data>[number]) => ({
    id: row.dispatch_orders.id,
    type: row.dispatch_orders.orderType,
    status: row.dispatch_orders.status,
    rental: row.dispatch_orders.rentalRequestId || "",
    customer: row.customers?.name || "",
    address: row.dispatch_orders.deliveryAddress || row.dispatch_orders.pickupAddress || "",
    scheduledDate: row.dispatch_orders.scheduledDate ? formatCalendarDate(row.dispatch_orders.scheduledDate, tz) : "",
    driver: row.driver?.name || "",
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("title")}</h1>
          <div className="flex items-center gap-3">
            <ExportToolbar
              allData={(data || []).map(mapDispatchForExport)}
              pageData={(data || []).map(mapDispatchForExport)}
              selectedData={[]}
              columns={exportColumns}
              fileName="dispatch-orders"
              title={t("title")}
            />
            {/* View mode toggle */}
            <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
              {([
                { mode: "list" as ViewMode, icon: List, label: t("viewMode.list") },
                { mode: "calendar" as ViewMode, icon: Calendar, label: t("viewMode.calendar") },
                { mode: "kanban" as ViewMode, icon: Columns3, label: t("viewMode.kanban") },
              ]).map(({ mode, icon: Icon, label }) => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    viewMode === mode
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <Icon size={16} />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>
            {can('dispatch', 'create') && <button onClick={() => { setEditId(null); setForm(emptyForm); setUnitKey(""); setOpen(true); }} className="btn-primary flex items-center gap-2"><Plus size={18} /> {t("newOrder")}</button>}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12"><div className="spinner" /><span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span></div>
        ) : viewMode === "calendar" ? (
          <Suspense fallback={<div className="flex items-center justify-center py-12"><div className="spinner" /></div>}>
            <DispatchCalendarView data={data || []} onEventClick={handleCardClick} />
          </Suspense>
        ) : viewMode === "kanban" ? (
          <Suspense fallback={<div className="flex items-center justify-center py-12"><div className="spinner" /></div>}>
            <DispatchKanbanView data={data || []} onStatusChange={handleKanbanStatusChange} onCardClick={handleCardClick} />
          </Suspense>
        ) : (
        <>
          {/* Mobile card view (< md) */}
          <div className="md:hidden space-y-2">
            {(data || []).map((row) => {
              const d = row.dispatch_orders;
              const customer = row.customers;
              const fleet = row.rental_fleet;
              const driver = row.driver;
              return (
                <div key={d.id} className="card p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900">#{d.id}</span>
                        <span className="text-xs text-slate-500 capitalize">{t(d.orderType)}</span>
                      </div>
                      <div className="text-sm text-slate-700 truncate mt-0.5">{customer?.name || "-"}</div>
                    </div>
                    <span className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${statusColors[d.status] || ""}`}>
                      {t(`kanban.${d.status === "in_transit" ? "inTransit" : d.status}`)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-slate-600">
                    {fleet && <div className="truncate"><span className="text-slate-400">{t("equipment", { ns: "inspection" })}: </span>{fleet.brand} {fleet.model}</div>}
                    {driver?.name && <div className="truncate"><span className="text-slate-400">{t("driver")}: </span>{driver.name}</div>}
                    {d.scheduledDate && <div className="col-span-2"><span className="text-slate-400">{t("scheduled")}: </span>{fmtDate(d.scheduledDate)}</div>}
                  </div>
                  <div className="flex items-center gap-2 pt-1 border-t border-slate-100">
                    {can('dispatch', 'update') && (
                      <select
                        value={d.status}
                        onChange={(e) => updateStatus.mutate({ id: d.id, status: e.target.value as (typeof statusOptions)[number] })}
                        className="flex-1 bg-slate-100 border border-slate-300 rounded px-2 py-1.5 text-xs text-slate-900"
                      >
                        {statusOptions.map((s) => <option key={s} value={s}>{t(`kanban.${s === "in_transit" ? "inTransit" : s}`)}</option>)}
                      </select>
                    )}
                    <button
                      onClick={() => generatePDF.mutate({ id: d.id })}
                      disabled={generatePDF.isPending}
                      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-500 active:text-slate-900"
                      aria-label="Download PDF"
                    >
                      <FileDown size={18} />
                    </button>
                    {can('dispatch', 'update') && ["pending", "assigned"].includes(d.status) && (
                      <button onClick={() => openEdit(d)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-500 active:text-slate-900" aria-label="Edit">
                        <Pencil size={18} />
                      </button>
                    )}
                    {can('dispatch', 'delete') && (
                      <button
                        onClick={() => { if (confirm(t("deleteConfirm"))) deleteMut.mutate({ id: d.id }); }}
                        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-slate-400 active:text-[var(--primary)]"
                        aria-label="Delete"
                      >
                        <Trash2 size={18} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {data?.length === 0 && <div className="card py-8 text-center text-slate-400">{t("noOrders")}</div>}
          </div>

          {/* Desktop table (>= md) */}
          <div className="card overflow-x-auto hidden md:block">
            <table className="w-full text-sm text-left">
              <thead className="text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4">ID</th>
                  <th className="py-3 px-4">{t("type")}</th>
                  <th className="py-3 px-4">{t("rental")}</th>
                  <th className="py-3 px-4">{t("customer")}</th>
                  <th className="py-3 px-4">{t("equipment", { ns: "inspection" })}</th>
                  <th className="py-3 px-4">{t("driver")}</th>
                  <th className="py-3 px-4">{t("scheduled")}</th>
                  <th className="py-3 px-4">{t("status", { ns: "common" })}</th>
                  <th className="py-3 px-4">{t("actions", { ns: "common" })}</th>
                </tr>
              </thead>
              <tbody>
                {(data || []).map((row) => {
                  const d = row.dispatch_orders;
                  const customer = row.customers;
                  const fleet = row.rental_fleet;
                  const driver = row.driver;
                  return (
                    <tr key={d.id} className="border-b border-slate-200/50 text-slate-600 hover:bg-slate-100/30">
                      <td className="py-3 px-4 text-slate-900 font-medium">#{d.id}</td>
                      <td className="py-3 px-4 capitalize">{t(d.orderType)}</td>
                      <td className="py-3 px-4">{row.rental?.rentalNumber || (d.rentalRequestId ? `#${d.rentalRequestId}` : "-")}</td>
                      <td className="py-3 px-4">{customer?.name || "-"}</td>
                      <td className="py-3 px-4">{fleet ? `${fleet.brand} ${fleet.model}` : "-"}</td>
                      <td className="py-3 px-4">{driver?.name || "-"}</td>
                      <td className="py-3 px-4">{fmtDate(d.scheduledDate)}</td>
                      <td className="py-3 px-4">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${statusColors[d.status] || ""}`}>{t(`kanban.${d.status === "in_transit" ? "inTransit" : d.status}`)}</span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          {can('dispatch', 'update') && (
                            <select value={d.status} onChange={(e) => updateStatus.mutate({ id: d.id, status: e.target.value as (typeof statusOptions)[number] })} className="bg-slate-100 border border-slate-300 rounded px-2 py-1 text-xs text-slate-900">
                              {statusOptions.map((s) => <option key={s} value={s}>{t(`kanban.${s === "in_transit" ? "inTransit" : s}`)}</option>)}
                            </select>
                          )}
                          <button
                            onClick={() => generatePDF.mutate({ id: d.id })}
                            disabled={generatePDF.isPending}
                            className="text-slate-500 hover:text-slate-900"
                            aria-label="Download PDF"
                            title="Download PDF"
                          >
                            <FileDown size={16} />
                          </button>
                          {can('dispatch', 'update') && ["pending", "assigned"].includes(d.status) && (
                            <button onClick={() => openEdit(d)} className="text-slate-500 hover:text-slate-900" aria-label="Edit">
                              <Pencil size={16} />
                            </button>
                          )}
                          {can('dispatch', 'delete') && (
                            <button
                              onClick={() => { if (confirm(t("deleteConfirm"))) deleteMut.mutate({ id: d.id }); }}
                              className="text-slate-400 hover:text-[var(--primary)]"
                              aria-label="Delete"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {data?.length === 0 && <tr><td colSpan={9} className="py-8 text-center text-slate-400">{t("noOrders")}</td></tr>}
              </tbody>
            </table>
          </div>
        </>
        )}
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{editId ? t("editOrder") : t("newOrder")}</h2>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{t("linkToRental")}</label>
                <select value={form.rentalRequestId} onChange={(e) => handleRentalSelect(e.target.value)} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                  <option value="">{t("noLinkedRental")}</option>
                  {linkableRentals.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.rentalNumber || `#${r.id}`} - {r.customerName} {r.fleetBrand ? `(${r.fleetBrand} ${r.fleetModel})` : ""} [{r.status}]
                    </option>
                  ))}
                </select>
              </div>
              {fulfillmentUnits && fulfillmentUnits.length > 1 && (
                <div>
                  <label className="text-xs text-slate-500 mb-1 block">{t("equipmentUnit", "Equipment unit")}</label>
                  <select value={unitKey} onChange={(e) => setUnitKey(e.target.value)} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    <option value="">{t("selectUnit", "Select unit…")}</option>
                    {fulfillmentUnits.filter((u) => u.rentalFleetId).map((u) => (
                      <option key={`${u.lineItemId ?? "x"}:${u.rentalFleetId}`} value={`${u.lineItemId ?? "null"}:${u.rentalFleetId}`}>
                        {u.brand} {u.model}{u.assetNumber ? ` (${u.assetNumber})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <select value={form.orderType} onChange={(e) => handleOrderTypeChange(e.target.value as "delivery" | "pickup")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                <option value="delivery">{t("delivery")}</option>
                <option value="pickup">{t("pickup")}</option>
              </select>
              <select value={form.assignedDriverId} onChange={(e) => setForm({ ...form, assignedDriverId: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                <option value="">{t("assignDriver")}</option>
                {(drivers || []).filter((d) => d.isActive).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <input type="date" value={form.scheduledDate} onChange={(e) => setForm({ ...form, scheduledDate: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{t("timeSlot")}</label>
                <select
                  value={form.scheduledTimeSlot}
                  onChange={(e) => setForm({ ...form, scheduledTimeSlot: e.target.value, customTime: e.target.value === "custom" ? form.customTime : "" })}
                  className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
                >
                  {TIME_SLOT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{translateDynamic(t, opt.labelKey)}</option>
                  ))}
                </select>
                {form.scheduledTimeSlot === "custom" && (
                  <input
                    type="text"
                    placeholder={t("placeholderCustomTime")}
                    value={form.customTime}
                    onChange={(e) => setForm({ ...form, customTime: e.target.value })}
                    className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm mt-2"
                  />
                )}
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{t("pickupAddress")} {form.orderType === "delivery" ? `(${t("warehouseLocation")})` : `(${t("customerSite")})`}</label>
                <input value={form.pickupAddress} onChange={(e) => setForm({ ...form, pickupAddress: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">{t("deliveryAddress")} {form.orderType === "delivery" ? `(${t("customerSite")})` : `(${t("warehouseLocation")})`}</label>
                <input value={form.deliveryAddress} onChange={(e) => setForm({ ...form, deliveryAddress: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <textarea placeholder={t("notes")} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              {editId && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">{t("priority")}</label>
                    <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                      <option value="low">{t("priorityLow")}</option>
                      <option value="normal">{t("priorityNormal")}</option>
                      <option value="high">{t("priorityHigh")}</option>
                      <option value="urgent">{t("priorityUrgent")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-slate-500 mb-1 block">{t("shippingCost")}</label>
                    <input type="number" step="0.01" placeholder="$0.00" value={form.shippingCost} onChange={(e) => setForm({ ...form, shippingCost: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => { setOpen(false); setEditId(null); }} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleSubmit} disabled={createMut.isPending || updateMut.isPending} className="btn-primary">
                {editId ? t("save", { ns: "common" }) : t("create", { ns: "common" })}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
