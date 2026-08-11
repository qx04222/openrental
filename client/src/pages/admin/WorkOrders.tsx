import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import DataTable, { Column } from "@/components/DataTable";
import FleetCombobox, { FleetComboboxItem } from "@/components/FleetCombobox";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import {
  Plus,
  Trash2,
  X,
  RefreshCw,
  PlusCircle,
  Clock,
  Printer,
  Pencil,
} from "lucide-react";
import { useFormatCalendarDate, useAppTimezone, formatCalendarDate, formatCalendarDateISO } from "@/lib/dateUtils";
import ExportToolbar from "@/components/ExportToolbar";
import { serverErrorText } from "@/lib/serverError";
import { EDIT_REASONS, EDIT_REASON_REQUIRES_NOTE, type EditReason } from "@shared/editReasons";

type TabFilter = "unfinished" | "all" | "open" | "assigned" | "in_progress" | "on_hold" | "completed" | "cancelled";

/** Anything here still holds its equipment — see server/services/fleetAvailability.ts. */
const UNFINISHED_STATUSES = ["open", "assigned", "in_progress", "on_hold"];

const TYPE_COLORS: Record<string, string> = {
  pm1_250h: "bg-blue-100 text-blue-700",
  pm2_500h: "bg-blue-100 text-blue-700",
  pm3_1000h: "bg-blue-100 text-blue-700",
  pm4_2000h: "bg-blue-100 text-blue-700",
  repair: "bg-red-100 text-red-700",
  inspection: "bg-yellow-100 text-yellow-700",
  other: "bg-slate-100 text-slate-700",
};

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-100 text-slate-700",
  normal: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

const STATUS_COLORS: Record<string, string> = {
  open: "bg-yellow-100 text-yellow-700",
  assigned: "bg-blue-100 text-blue-700",
  in_progress: "bg-indigo-100 text-indigo-700",
  on_hold: "bg-slate-100 text-slate-700",
  completed: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-700",
};

const _WO_TYPE_VALUES = ["pm1_250h", "pm2_500h", "pm3_1000h", "pm4_2000h", "repair", "inspection", "other"] as const;
const _WO_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
const _WO_STATUS_VALUES = ["open", "assigned", "in_progress", "on_hold", "completed", "cancelled"] as const;

type WoType = (typeof _WO_TYPE_VALUES)[number];
type WoPriority = (typeof _WO_PRIORITY_VALUES)[number];
type WoStatus = (typeof _WO_STATUS_VALUES)[number];

type EquipmentSource = "equipment" | "own_fleet" | "other";

const emptyCreateForm = {
  rentalFleetId: "",
  type: "other" as WoType,
  priority: "normal" as WoPriority,
  assignedTo: "",
  estimatedHours: "",
  laborRate: "",
  scheduledDate: "",
  description: "",
  equipmentSource: "equipment" as EquipmentSource,
  customerName: "",
  customerPhone: "",
  plateNumber: "",
  equipmentSourceNote: "",
  meterKms: "",
  meterHours: "",
};

const emptyLaborForm = {
  technicianName: "",
  workDetail: "",
  startAt: "",
  endAt: "",
};

const emptyEditForm = {
  ...emptyCreateForm,
  notes: "",
};

const emptyStatusForm = {
  status: "open" as WoStatus,
  actualHours: "",
  findings: "",
  resolution: "",
};

const emptyEvidence = {
  reason: "" as EditReason | "",
  reasonNote: "",
};

const emptyEditPartForm = {
  id: 0,
  partName: "",
  partNumber: "",
  quantity: "",
  unitCost: "",
  ...emptyEvidence,
};

const emptyEditLaborForm = {
  id: 0,
  technicianName: "",
  workDetail: "",
  startAt: "",
  endAt: "",
  ...emptyEvidence,
};

const emptyPartForm = {
  partName: "",
  partNumber: "",
  quantity: "1",
  unitCost: "",
};

export default function WorkOrders() {
  const { t } = useTranslation("admin");
  const utils = trpc.useUtils();

  const WO_TYPES: { value: WoType; label: string }[] = [
    { value: "pm1_250h", label: t("workOrders.typePm1") },
    { value: "pm2_500h", label: t("workOrders.typePm2") },
    { value: "pm3_1000h", label: t("workOrders.typePm3") },
    { value: "pm4_2000h", label: t("workOrders.typePm4") },
    { value: "repair", label: t("workOrders.typeRepair") },
    { value: "inspection", label: t("workOrders.typeInspection") },
    { value: "other", label: t("workOrders.typeOther") },
  ];

  const WO_PRIORITIES: { value: WoPriority; label: string }[] = [
    { value: "low", label: t("workOrders.priorityLow") },
    { value: "normal", label: t("workOrders.priorityNormal") },
    { value: "high", label: t("workOrders.priorityHigh") },
    { value: "urgent", label: t("workOrders.priorityUrgent") },
  ];

  const WO_STATUSES: { value: WoStatus; label: string }[] = [
    { value: "open", label: t("workOrders.statusOpen") },
    { value: "assigned", label: t("workOrders.statusAssigned") },
    { value: "in_progress", label: t("workOrders.statusInProgress") },
    { value: "on_hold", label: t("workOrders.statusOnHold") },
    { value: "completed", label: t("workOrders.statusCompleted") },
    { value: "cancelled", label: t("workOrders.statusCancelled") },
  ];

  // ─── Data fetching ──────────────────────────────────────────
  // Landing on "all" is what let two open work orders sit unnoticed for two
  // weeks while they quietly held a machine out of the fleet. The default is
  // now the work that is still owed; "all" is one click away.
  const [tab, setTab] = useState<TabFilter>("unfinished");
  const { data: woData, isLoading } = trpc.workOrders.list.useQuery(
    tab === "all" || tab === "unfinished" ? undefined : { status: tab }
  );
  // The unfinished view spans four statuses, which the single-status endpoint
  // cannot express, so it filters the full list client-side.
  const visibleWorkOrders = useMemo(
    () => (tab === "unfinished"
      ? (woData || []).filter((w) => UNFINISHED_STATUSES.includes(String(w.work_orders.status)))
      : woData || []),
    [woData, tab],
  );
  // Shares the sidebar's cached query — no extra request, same source of truth.
  const { data: workQueue } = trpc.reports.internalWorkQueue.useQuery(undefined, {
    staleTime: 60 * 1000,
    retry: false,
  });
  const unfinishedCount = workQueue?.buckets.find((b) => b.kind === "work_order")?.count ?? 0;
  const { data: fleetList } = trpc.rentalFleet.list.useQuery();

  // Combobox items — S/N on its own line; work orders may target any unit,
  // so availability is informational only (allowUnavailable below).
  const fleetItems = useMemo<FleetComboboxItem[]>(() =>
    (Array.isArray(fleetList) ? fleetList : []).map((f) => {
      const item = f.rental_fleet || f;
      return {
        id: item.id,
        brand: item.brand || "",
        model: item.model || "",
        year: item.year,
        category: item.category,
        assetNumber: item.assetNumber,
        serialNumber: item.serialNumber,
        availabilityStatus:
          item.currentStatus === "maintenance" || item.currentStatus === "retired" ? "maintenance"
          : item.currentStatus === "rented" ? "rented"
          : "available",
      };
    }), [fleetList]);

  const fleetComboboxLabels = {
    available: t("management.equipAvailable", "Available"),
    rented: t("management.equipRented", "Rented"),
    maintenance: t("management.equipMaintenance", "Maintenance"),
    until: t("management.equipUntil", "until"),
  };
  const { data: usersList } = trpc.users.list.useQuery();

  // ─── Mutations ──────────────────────────────────────────────
  const createMut = trpc.workOrders.create.useMutation({
    onSuccess: (_result) => {
      utils.workOrders.list.invalidate();
      setCreateOpen(false);
      toast.success(t("workOrders.createSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateStatusMut = trpc.workOrders.updateStatus.useMutation({
    onSuccess: () => {
      utils.workOrders.list.invalidate();
      setStatusOpen(false);
      toast.success(t("workOrders.updateStatusSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const addPartMut = trpc.workOrders.addPart.useMutation({
    onSuccess: () => {
      utils.workOrders.getById.invalidate();
      utils.workOrders.list.invalidate();
      setPartOpen(false);
      toast.success(t("workOrders.addPartSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deleteMut = trpc.workOrders.delete.useMutation({
    onSuccess: () => {
      utils.workOrders.list.invalidate();
      toast.success(t("workOrders.deleteSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const addLaborMut = trpc.workOrders.addLabor.useMutation({
    onSuccess: () => {
      utils.workOrders.getById.invalidate();
      utils.workOrders.list.invalidate();
      setLaborForm(emptyLaborForm);
      toast.success(t("workOrders.addLaborSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deleteLaborMut = trpc.workOrders.deleteLabor.useMutation({
    onSuccess: () => {
      utils.workOrders.getById.invalidate();
      utils.workOrders.list.invalidate();
      setDeletePrompt(null);
      toast.success(t("workOrders.deleteLaborSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updatePartMut = trpc.workOrders.updatePart.useMutation({
    onSuccess: (res) => {
      utils.workOrders.getById.invalidate();
      utils.workOrders.list.invalidate();
      setEditPartOpen(false);
      toast.success(res?.unchanged ? t("workOrders.unchanged") : t("workOrders.editPartSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deletePartMut = trpc.workOrders.deletePart.useMutation({
    onSuccess: () => {
      utils.workOrders.getById.invalidate();
      utils.workOrders.list.invalidate();
      setDeletePrompt(null);
      toast.success(t("workOrders.deletePartSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateLaborMut = trpc.workOrders.updateLabor.useMutation({
    onSuccess: (res) => {
      utils.workOrders.getById.invalidate();
      utils.workOrders.list.invalidate();
      setEditLaborOpen(false);
      toast.success(res?.unchanged ? t("workOrders.unchanged") : t("workOrders.editLaborSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateInfoMut = trpc.workOrders.updateInfo.useMutation({
    onSuccess: () => {
      utils.workOrders.list.invalidate();
      utils.workOrders.getById.invalidate();
      setEditOpen(false);
      toast.success(t("workOrders.editSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const pdfMut = trpc.workOrders.generatePdf.useMutation({
    onSuccess: ({ url }) => {
      window.open(url, "_blank", "noopener");
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Dialog state ──────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);

  const [statusOpen, setStatusOpen] = useState(false);
  const [statusWoId, setStatusWoId] = useState<number | null>(null);
  const [statusForm, setStatusForm] = useState(emptyStatusForm);

  const [partOpen, setPartOpen] = useState(false);
  const [partWoId, setPartWoId] = useState<number | null>(null);
  const [partForm, setPartForm] = useState(emptyPartForm);
  const { data: partWoDetail } = trpc.workOrders.getById.useQuery(
    { id: partWoId ?? 0 },
    { enabled: partOpen && partWoId != null }
  );

  // Correcting an already-recorded line always carries a reason (evidence chain)
  const [editPartOpen, setEditPartOpen] = useState(false);
  const [editPartForm, setEditPartForm] = useState(emptyEditPartForm);
  const [editLaborOpen, setEditLaborOpen] = useState(false);
  const [editLaborForm, setEditLaborForm] = useState(emptyEditLaborForm);
  const [deletePrompt, setDeletePrompt] = useState<
    { kind: "part" | "labor"; id: number; reason: EditReason | ""; reasonNote: string } | null
  >(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editWoId, setEditWoId] = useState<number | null>(null);
  const [editWoNumber, setEditWoNumber] = useState("");
  const [editForm, setEditForm] = useState(emptyEditForm);

  const [laborOpen, setLaborOpen] = useState(false);
  const [laborWoId, setLaborWoId] = useState<number | null>(null);
  const [laborForm, setLaborForm] = useState(emptyLaborForm);
  const { data: laborWoDetail } = trpc.workOrders.getById.useQuery(
    { id: laborWoId ?? 0 },
    { enabled: laborOpen && laborWoId != null }
  );

  const closeCreate = useCallback(() => setCreateOpen(false), []);
  const closeStatus = useCallback(() => setStatusOpen(false), []);
  const closePart = useCallback(() => setPartOpen(false), []);
  const closeLabor = useCallback(() => setLaborOpen(false), []);
  const closeEdit = useCallback(() => setEditOpen(false), []);
  useEscapeKey(createOpen, closeCreate);
  useEscapeKey(statusOpen, closeStatus);
  useEscapeKey(partOpen, closePart);
  useEscapeKey(laborOpen, closeLabor);
  useEscapeKey(editOpen, closeEdit);
  const closeEditPart = useCallback(() => setEditPartOpen(false), []);
  const closeEditLabor = useCallback(() => setEditLaborOpen(false), []);
  const closeDeletePrompt = useCallback(() => setDeletePrompt(null), []);
  useEscapeKey(editPartOpen, closeEditPart);
  useEscapeKey(editLaborOpen, closeEditLabor);
  useEscapeKey(deletePrompt != null, closeDeletePrompt);

  // ─── Handlers ──────────────────────────────────────────────
  const openCreate = () => {
    setCreateForm(emptyCreateForm);
    setCreateOpen(true);
  };

  const handleCreate = () => {
    const isFleetUnit = createForm.equipmentSource === "equipment";
    const rentalFleetId = parseInt(createForm.rentalFleetId, 10);
    if (isFleetUnit && (!rentalFleetId || isNaN(rentalFleetId))) return toast.error(t("workOrders.selectEquipment"));
    if (createForm.equipmentSource === "other" && !createForm.customerName.trim()) return toast.error(t("workOrders.customerNameRequired"));
    const assignedTo = parseInt(createForm.assignedTo, 10);
    const estimatedHours = parseFloat(createForm.estimatedHours);
    const laborRate = parseFloat(createForm.laborRate);
    const meterKms = parseInt(createForm.meterKms, 10);
    const meterHours = parseFloat(createForm.meterHours);
    createMut.mutate({
      rentalFleetId: isFleetUnit ? rentalFleetId : undefined,
      type: createForm.type,
      priority: createForm.priority,
      assignedTo: assignedTo && !isNaN(assignedTo) ? assignedTo : undefined,
      estimatedHours: estimatedHours && !isNaN(estimatedHours) ? estimatedHours : undefined,
      laborRate: laborRate && !isNaN(laborRate) ? laborRate : undefined,
      scheduledDate: createForm.scheduledDate || undefined,
      description: createForm.description || undefined,
      equipmentSource: createForm.equipmentSource,
      customerName: createForm.customerName.trim() || undefined,
      customerPhone: createForm.customerPhone.trim() || undefined,
      plateNumber: createForm.plateNumber.trim() || undefined,
      equipmentSourceNote: createForm.equipmentSourceNote.trim() || undefined,
      meterKms: !isNaN(meterKms) && meterKms >= 0 ? meterKms : undefined,
      meterHours: !isNaN(meterHours) && meterHours >= 0 ? meterHours : undefined,
    });
  };

  const openUpdateStatus = (woId: number, currentStatus: string) => {
    setStatusWoId(woId);
    setStatusForm({ ...emptyStatusForm, status: currentStatus as WoStatus });
    setStatusOpen(true);
  };

  const handleUpdateStatus = () => {
    if (!statusWoId) return;
    const actualHours = parseFloat(statusForm.actualHours);
    updateStatusMut.mutate({
      id: statusWoId,
      status: statusForm.status,
      actualHours: actualHours && !isNaN(actualHours) ? actualHours : undefined,
      findings: statusForm.findings || undefined,
      resolution: statusForm.resolution || undefined,
    });
  };

  const openAddPart = (woId: number) => {
    setPartWoId(woId);
    setPartForm(emptyPartForm);
    setPartOpen(true);
  };

  const openEdit = (wo: WoRow["work_orders"]) => {
    setEditWoId(wo.id);
    setEditWoNumber(wo.workOrderNumber);
    setEditForm({
      rentalFleetId: wo.rentalFleetId ? String(wo.rentalFleetId) : "",
      type: wo.type as WoType,
      priority: wo.priority as WoPriority,
      assignedTo: wo.assignedTo ? String(wo.assignedTo) : "",
      estimatedHours: wo.estimatedHours ? String(parseFloat(wo.estimatedHours)) : "",
      laborRate: wo.laborRate ? String(parseFloat(wo.laborRate)) : "",
      scheduledDate: wo.scheduledDate ? formatCalendarDateISO(wo.scheduledDate, tz) : "",
      description: wo.description || "",
      equipmentSource: (wo.equipmentSource as EquipmentSource) || (wo.rentalFleetId ? "equipment" : "other"),
      customerName: wo.customerName || "",
      customerPhone: wo.customerPhone || "",
      plateNumber: wo.plateNumber || "",
      equipmentSourceNote: wo.equipmentSourceNote || "",
      meterKms: wo.meterKms != null ? String(wo.meterKms) : "",
      meterHours: wo.meterHours != null ? String(parseFloat(wo.meterHours)) : "",
      notes: wo.notes || "",
    });
    setEditOpen(true);
  };

  const handleEdit = () => {
    if (!editWoId) return;
    const isFleetUnit = editForm.equipmentSource === "equipment";
    const rentalFleetId = parseInt(editForm.rentalFleetId, 10);
    if (isFleetUnit && (!rentalFleetId || isNaN(rentalFleetId))) return toast.error(t("workOrders.selectEquipment"));
    if (editForm.equipmentSource === "other" && !editForm.customerName.trim()) return toast.error(t("workOrders.customerNameRequired"));
    const assignedTo = parseInt(editForm.assignedTo, 10);
    const estimatedHours = parseFloat(editForm.estimatedHours);
    const laborRate = parseFloat(editForm.laborRate);
    const meterKms = parseInt(editForm.meterKms, 10);
    const meterHours = parseFloat(editForm.meterHours);
    updateInfoMut.mutate({
      id: editWoId,
      rentalFleetId: isFleetUnit ? rentalFleetId : null,
      type: editForm.type,
      priority: editForm.priority,
      assignedTo: assignedTo && !isNaN(assignedTo) ? assignedTo : null,
      estimatedHours: estimatedHours && !isNaN(estimatedHours) ? estimatedHours : undefined,
      laborRate: laborRate >= 0 && !isNaN(laborRate) ? laborRate : undefined,
      scheduledDate: editForm.scheduledDate || null,
      description: editForm.description,
      notes: editForm.notes,
      equipmentSource: editForm.equipmentSource,
      customerName: editForm.customerName.trim(),
      customerPhone: editForm.customerPhone.trim(),
      plateNumber: editForm.plateNumber.trim(),
      equipmentSourceNote: editForm.equipmentSourceNote.trim(),
      meterKms: !isNaN(meterKms) && meterKms >= 0 ? meterKms : null,
      meterHours: !isNaN(meterHours) && meterHours >= 0 ? meterHours : null,
    });
  };

  const openLabor = (woId: number) => {
    setLaborWoId(woId);
    setLaborForm(emptyLaborForm);
    setLaborOpen(true);
  };

  const handleAddLabor = () => {
    if (!laborWoId) return;
    if (!laborForm.technicianName.trim()) return toast.error(t("workOrders.technicianRequired"));
    if (!laborForm.startAt) return toast.error(t("workOrders.startTimeRequired"));
    addLaborMut.mutate({
      workOrderId: laborWoId,
      technicianName: laborForm.technicianName.trim(),
      workDetail: laborForm.workDetail.trim() || undefined,
      startAt: laborForm.startAt,
      endAt: laborForm.endAt || undefined,
    });
  };

  const handleAddPart = () => {
    if (!partWoId) return;
    if (!partForm.partName.trim()) return toast.error(t("workOrders.partNameRequired"));
    const quantity = parseFloat(partForm.quantity);
    const unitCost = parseFloat(partForm.unitCost);
    if (!quantity || quantity <= 0) return toast.error(t("workOrders.validQuantity"));
    if (isNaN(unitCost) || unitCost < 0) return toast.error(t("workOrders.validUnitCost"));
    addPartMut.mutate({
      workOrderId: partWoId,
      partName: partForm.partName,
      partNumber: partForm.partNumber || undefined,
      quantity,
      unitCost,
    });
  };

  // ─── Line corrections (parts / labour) ─────────────────────
  // Every one of these carries a reason; the server refuses the edit without it
  // and records old→new + why in the audit log.
  const REASON_LABELS: Record<EditReason, string> = {
    wrong_amount: t("editReason.wrong_amount", { ns: "common" }),
    customer_agreed: t("editReason.customer_agreed", { ns: "common" }),
    duplicate: t("editReason.duplicate", { ns: "common" }),
    wrong_document: t("editReason.wrong_document", { ns: "common" }),
    waived: t("editReason.waived", { ns: "common" }),
    other: t("editReason.other", { ns: "common" }),
  };

  /** Reason picker shared by every line correction dialog. */
  const renderReasonFields = (
    value: { reason: EditReason | ""; reasonNote: string },
    onChange: (patch: { reason?: EditReason | ""; reasonNote?: string }) => void,
  ) => (
    <div className="space-y-2 border-t border-slate-200 pt-3">
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          {t("editReason.label", { ns: "common" })} <span className="text-[var(--primary)]">*</span>
        </label>
        <select
          value={value.reason}
          onChange={(e) => onChange({ reason: e.target.value as EditReason | "" })}
          className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
        >
          <option value="">{t("editReason.required", { ns: "common" })}</option>
          {EDIT_REASONS.map((r) => (
            <option key={r} value={r}>{REASON_LABELS[r]}</option>
          ))}
        </select>
      </div>
      <div>
        <textarea
          value={value.reasonNote}
          onChange={(e) => onChange({ reasonNote: e.target.value })}
          rows={2}
          maxLength={500}
          placeholder={t("editReason.notePlaceholder", { ns: "common" })}
          className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
        />
      </div>
    </div>
  );

  /** Client-side mirror of assertEditReason — the server still enforces it. */
  const validEvidence = (reason: EditReason | "", note: string) => {
    if (!reason) {
      toast.error(t("editReason.required", { ns: "common" }));
      return null;
    }
    if (EDIT_REASON_REQUIRES_NOTE.includes(reason) && !note.trim()) {
      toast.error(t("errors.edit.noteRequired", { ns: "common" }));
      return null;
    }
    return { reason, reasonNote: note.trim() || undefined };
  };

  const openEditPart = (part: { id: number; partName: string; partNumber: string | null; quantity: string; unitCost: string }) => {
    setEditPartForm({
      ...emptyEditPartForm,
      id: part.id,
      partName: part.partName,
      partNumber: part.partNumber || "",
      quantity: part.quantity,
      unitCost: part.unitCost,
    });
    setEditPartOpen(true);
  };

  const handleUpdatePart = () => {
    const evidence = validEvidence(editPartForm.reason, editPartForm.reasonNote);
    if (!evidence) return;
    if (!editPartForm.partName.trim()) return toast.error(t("workOrders.partNameRequired"));
    const quantity = parseFloat(editPartForm.quantity);
    const unitCost = parseFloat(editPartForm.unitCost);
    if (!quantity || quantity <= 0) return toast.error(t("workOrders.validQuantity"));
    if (isNaN(unitCost) || unitCost < 0) return toast.error(t("workOrders.validUnitCost"));
    updatePartMut.mutate({
      id: editPartForm.id,
      partName: editPartForm.partName.trim(),
      partNumber: editPartForm.partNumber.trim() || null,
      quantity,
      unitCost,
      ...evidence,
    });
  };

  const openEditLabor = (entry: { id: number; technicianName: string; workDetail: string | null; startAt: string | Date; endAt: string | Date | null }) => {
    setEditLaborForm({
      ...emptyEditLaborForm,
      id: entry.id,
      technicianName: entry.technicianName,
      workDetail: entry.workDetail || "",
      startAt: toDateTimeLocal(entry.startAt),
      endAt: entry.endAt ? toDateTimeLocal(entry.endAt) : "",
    });
    setEditLaborOpen(true);
  };

  const handleUpdateLabor = () => {
    const evidence = validEvidence(editLaborForm.reason, editLaborForm.reasonNote);
    if (!evidence) return;
    if (!editLaborForm.technicianName.trim()) return toast.error(t("workOrders.technicianRequired"));
    if (!editLaborForm.startAt) return toast.error(t("workOrders.startTimeRequired"));
    updateLaborMut.mutate({
      id: editLaborForm.id,
      technicianName: editLaborForm.technicianName.trim(),
      workDetail: editLaborForm.workDetail.trim() || null,
      startAt: editLaborForm.startAt,
      endAt: editLaborForm.endAt || null,
      ...evidence,
    });
  };

  const handleConfirmDelete = () => {
    if (!deletePrompt) return;
    const evidence = validEvidence(deletePrompt.reason, deletePrompt.reasonNote);
    if (!evidence) return;
    if (deletePrompt.kind === "part") deletePartMut.mutate({ id: deletePrompt.id, ...evidence });
    else deleteLaborMut.mutate({ id: deletePrompt.id, ...evidence });
  };

  // ─── Helpers ──────────────────────────────────────────────
  const fmtDate = useFormatCalendarDate();
  const tz = useAppTimezone();

  /** ISO/Date → "YYYY-MM-DDTHH:mm" in the app timezone, for datetime-local inputs. */
  const toDateTimeLocal = (value: string | Date) => {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(d).reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };

  const fmtNum = (v: string | number | null | undefined) => {
    const n = typeof v === "string" ? parseFloat(v) : v;
    return n != null && !isNaN(n) ? formatCurrency(n) : "-";
  };

  // ─── Table data ──────────────────────────────────────────
  type WoRow = NonNullable<typeof woData>[number];

  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set());
  const [filteredData, setFilteredData] = useState<WoRow[]>([]);
  const [pageTableData, setPageTableData] = useState<WoRow[]>([]);

  const handleDataReady = useCallback((info: { filtered: WoRow[]; pageData: WoRow[] }) => {
    setFilteredData(info.filtered);
    setPageTableData(info.pageData);
  }, []);

  const columns: Column<WoRow>[] = [
    {
      key: "work_orders.workOrderNumber",
      label: t("workOrders.columnWONo"),
      render: (row) => (
        <button
          onClick={(e) => { e.stopPropagation(); openEdit(row.work_orders); }}
          className="text-[var(--primary)] font-medium hover:underline"
          title={t("workOrders.editTooltip")}
        >
          {row.work_orders.workOrderNumber}
        </button>
      ),
    },
    {
      key: "rental_fleet.brand",
      label: t("workOrders.columnEquipment"),
      render: (row) => row.rental_fleet
        ? `${row.rental_fleet.brand || ""} ${row.rental_fleet.model || ""}`.trim() || "-"
        : row.work_orders.plateNumber || row.work_orders.customerName || "-",
      hideOnMobile: true,
    },
    {
      key: "rental_fleet.category",
      label: t("workOrders.columnEquipmentCategory"),
      render: (row) => row.rental_fleet?.category || "-",
      hideOnMobile: true,
    },
    {
      key: "rental_fleet.serialNumber",
      label: t("workOrders.columnSerialNo"),
      render: (row) => row.rental_fleet?.serialNumber
        ? <span className="text-slate-500 text-xs font-mono">{row.rental_fleet.serialNumber}</span>
        : <span className="text-slate-400">-</span>,
      hideOnMobile: true,
    },
    {
      key: "work_orders.type",
      label: t("workOrders.columnType"),
      render: (row) => {
        const tp = row.work_orders.type;
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[tp] || "bg-slate-100 text-slate-700"}`}>
            {WO_TYPES.find((t) => t.value === tp)?.label || tp.replace(/_/g, " ")}
          </span>
        );
      },
    },
    {
      key: "work_orders.priority",
      label: t("workOrders.columnPriority"),
      render: (row) => {
        const p = row.work_orders.priority;
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_COLORS[p] || "bg-slate-100 text-slate-700"}`}>
            {WO_PRIORITIES.find((pr) => pr.value === p)?.label || p}
          </span>
        );
      },
      hideOnMobile: true,
    },
    {
      key: "work_orders.status",
      label: t("workOrders.columnStatus"),
      render: (row) => {
        const s = row.work_orders.status;
        return (
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[s] || "bg-slate-100 text-slate-700"}`}>
            {WO_STATUSES.find((st) => st.value === s)?.label || s.replace(/_/g, " ")}
          </span>
        );
      },
    },
    {
      key: "users.name",
      label: t("workOrders.columnAssignedTo"),
      render: (row) => <span className="text-sm text-slate-700">{row.users?.name || "-"}</span>,
      hideOnMobile: true,
    },
    {
      key: "work_orders.scheduledDate",
      label: t("workOrders.columnScheduled"),
      render: (row) => <span className="text-sm text-slate-500">{fmtDate(row.work_orders.scheduledDate)}</span>,
      hideOnMobile: true,
    },
    {
      key: "work_orders.totalCost",
      label: t("workOrders.columnTotalCost"),
      render: (row) => <span className="text-sm font-medium text-slate-900">{fmtNum(row.work_orders.totalCost)}</span>,
      hideOnMobile: true,
    },
    {
      key: "_actions",
      label: t("workOrders.columnActions"),
      sortable: false,
      searchable: false,
      render: (row) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => openUpdateStatus(row.work_orders.id, row.work_orders.status)}
            className="text-slate-500 hover:text-blue-600"
            aria-label={t("workOrders.updateStatusTooltip")}
            title={t("workOrders.updateStatusTooltip")}
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => openAddPart(row.work_orders.id)}
            className="text-slate-500 hover:text-green-600"
            aria-label={t("workOrders.partsTooltip")}
            title={t("workOrders.partsTooltip")}
          >
            <PlusCircle size={16} />
          </button>
          <button
            onClick={() => openLabor(row.work_orders.id)}
            className="text-slate-500 hover:text-indigo-600"
            aria-label={t("workOrders.laborTooltip")}
            title={t("workOrders.laborTooltip")}
          >
            <Clock size={16} />
          </button>
          <button
            onClick={() => pdfMut.mutate({ id: row.work_orders.id })}
            disabled={pdfMut.isPending}
            className="text-slate-500 hover:text-blue-600 disabled:opacity-40"
            aria-label={t("workOrders.printTooltip")}
            title={t("workOrders.printTooltip")}
          >
            <Printer size={16} />
          </button>
          {row.work_orders.status !== "completed" && (
            <button
              onClick={() => {
                if (confirm(t("workOrders.deleteConfirm"))) deleteMut.mutate({ id: row.work_orders.id });
              }}
              className="text-slate-400 hover:text-[var(--primary)]"
              aria-label="Delete work order"
              title="Delete"
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // ─── Tab config ──────────────────────────────────────────
  const tabs: { key: TabFilter; label: string }[] = [
    { key: "unfinished", label: t("workOrders.tabUnfinished") },
    { key: "all", label: t("workOrders.tabAll") },
    { key: "open", label: t("workOrders.tabOpen") },
    { key: "assigned", label: t("workOrders.tabAssigned") },
    { key: "in_progress", label: t("workOrders.tabInProgress") },
    { key: "on_hold", label: t("workOrders.tabOnHold") },
    { key: "completed", label: t("workOrders.tabCompleted") },
    { key: "cancelled", label: t("workOrders.tabCancelled") },
  ];

  const exportColumns = [
    { key: "woNumber", label: t("workOrders.columnWONo") },
    { key: "equipment", label: t("workOrders.columnEquipment") },
    { key: "equipmentCategory", label: t("workOrders.columnEquipmentCategory") },
    { key: "serialNumber", label: t("workOrders.columnSerialNo") },
    { key: "type", label: t("workOrders.columnType") },
    { key: "priority", label: t("workOrders.columnPriority") },
    { key: "status", label: t("workOrders.columnStatus") },
    { key: "assignedTo", label: t("workOrders.columnAssignedTo") },
    { key: "scheduledDate", label: t("workOrders.columnScheduled") },
    { key: "totalCost", label: t("workOrders.columnTotalCost") },
  ];

  const mapWoForExport = (wo: WoRow) => ({
    woNumber: wo.work_orders.workOrderNumber,
    equipment: wo.rental_fleet ? `${wo.rental_fleet.brand || ""} ${wo.rental_fleet.model || ""}`.trim() : "",
    equipmentCategory: wo.rental_fleet?.category || "",
    serialNumber: wo.rental_fleet?.serialNumber || "",
    type: wo.work_orders.type,
    priority: wo.work_orders.priority,
    status: wo.work_orders.status,
    assignedTo: wo.users?.name || "",
    scheduledDate: wo.work_orders.scheduledDate ? formatCalendarDate(wo.work_orders.scheduledDate, tz) : "",
    totalCost: wo.work_orders.totalCost || "",
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("workOrders.pageTitle")}</h1>
          <div className="flex items-center gap-2">
            <ExportToolbar
              allData={filteredData.map(mapWoForExport)}
              pageData={pageTableData.map(mapWoForExport)}
              selectedData={Array.from(selectedKeys).map(k => {
                const r = visibleWorkOrders.find((_, i) => i === k);
                return r ? mapWoForExport(r) : null;
              }).filter(Boolean) as Record<string, unknown>[]}
              columns={exportColumns}
              fileName="work-orders"
              title={t("workOrders.pageTitle")}
            />
            <button onClick={openCreate} className="btn-primary flex items-center gap-2">
              <Plus size={18} /> {t("workOrders.createButton")}
            </button>
          </div>
        </div>

        {/* Tab Filters */}
        <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => { setTab(tb.key); setSelectedKeys(new Set()); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === tb.key
                  ? "border-[var(--primary)] text-[var(--primary)]"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {tb.label}
              {tb.key === "unfinished" && unfinishedCount > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold tabular-nums bg-red-100 text-red-700">
                  {unfinishedCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Table */}
        <DataTable
          data={visibleWorkOrders}
          columns={columns}
          isLoading={isLoading}
          emptyMessage={t("workOrders.noWorkOrdersFound")}
          searchPlaceholder={t("workOrders.searchPlaceholder")}
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
              <h2 className="text-lg font-bold text-slate-900">{t("workOrders.createDialogTitle")}</h2>
              <button onClick={() => setCreateOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formEquipmentSource")}</label>
                  <select value={createForm.equipmentSource} onChange={(e) => setCreateForm({ ...createForm, equipmentSource: e.target.value as EquipmentSource })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    <option value="equipment">{t("workOrders.sourceEquipment")}</option>
                    <option value="own_fleet">{t("workOrders.sourceOwnFleet")}</option>
                    <option value="other">{t("workOrders.sourceOther")}</option>
                  </select>
                </div>
                {createForm.equipmentSource === "equipment" ? (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formEquipment")} <span className="text-[var(--primary)]">*</span></label>
                    <FleetCombobox
                      items={fleetItems}
                      value={createForm.rentalFleetId}
                      onChange={(id) => setCreateForm({ ...createForm, rentalFleetId: id })}
                      allowUnavailable
                      placeholder={t("workOrders.selectEquipmentPlaceholder")}
                      labels={fleetComboboxLabels}
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formPlateNumber")}</label>
                    <input value={createForm.plateNumber} onChange={(e) => setCreateForm({ ...createForm, plateNumber: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                )}
              </div>
              {createForm.equipmentSource === "other" && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formCustomerName")} <span className="text-[var(--primary)]">*</span></label>
                    <input value={createForm.customerName} onChange={(e) => setCreateForm({ ...createForm, customerName: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formCustomerPhone")}</label>
                    <input value={createForm.customerPhone} onChange={(e) => setCreateForm({ ...createForm, customerPhone: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formSourceNote")}</label>
                    <input value={createForm.equipmentSourceNote} onChange={(e) => setCreateForm({ ...createForm, equipmentSourceNote: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formMeterKms")}</label>
                  <input type="number" min="0" placeholder="KMS" value={createForm.meterKms} onChange={(e) => setCreateForm({ ...createForm, meterKms: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formMeterHours")}</label>
                  <input type="number" step="0.1" min="0" placeholder="HRS" value={createForm.meterHours} onChange={(e) => setCreateForm({ ...createForm, meterHours: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formType")}</label>
                  <select value={createForm.type} onChange={(e) => setCreateForm({ ...createForm, type: e.target.value as WoType })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    {WO_TYPES.map((tp) => (
                      <option key={tp.value} value={tp.value}>{tp.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formPriority")}</label>
                  <select value={createForm.priority} onChange={(e) => setCreateForm({ ...createForm, priority: e.target.value as WoPriority })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    {WO_PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formAssignedTo")}</label>
                  <select value={createForm.assignedTo} onChange={(e) => setCreateForm({ ...createForm, assignedTo: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    <option value="">{t("workOrders.unassignedOption")}</option>
                    {(Array.isArray(usersList) ? usersList : []).map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formEstimatedHours")}</label>
                  <input type="number" step="0.5" min="0" placeholder="0" value={createForm.estimatedHours} onChange={(e) => setCreateForm({ ...createForm, estimatedHours: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formLaborRate")}</label>
                  <input type="number" step="0.01" min="0" placeholder="0.00" value={createForm.laborRate} onChange={(e) => setCreateForm({ ...createForm, laborRate: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formScheduledDate")}</label>
                  <input type="date" value={createForm.scheduledDate} onChange={(e) => setCreateForm({ ...createForm, scheduledDate: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formDescription")}</label>
                <textarea value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} rows={3} placeholder={t("workOrders.descriptionPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setCreateOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleCreate} disabled={createMut.isPending} className="btn-primary">{t("workOrders.createButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Update Status Dialog ──────────────────────────── */}
      {statusOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setStatusOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("workOrders.updateStatusDialogTitle")}</h2>
              <button onClick={() => setStatusOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formStatus")} <span className="text-[var(--primary)]">*</span></label>
                <select value={statusForm.status} onChange={(e) => setStatusForm({ ...statusForm, status: e.target.value as WoStatus })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                  {WO_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              {statusForm.status === "completed" && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formActualHours")}</label>
                  <input type="number" step="0.5" min="0" placeholder="0" value={statusForm.actualHours} onChange={(e) => setStatusForm({ ...statusForm, actualHours: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formFindings")}</label>
                <textarea value={statusForm.findings} onChange={(e) => setStatusForm({ ...statusForm, findings: e.target.value })} rows={2} placeholder={t("workOrders.findingsPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formResolution")}</label>
                <textarea value={statusForm.resolution} onChange={(e) => setStatusForm({ ...statusForm, resolution: e.target.value })} rows={2} placeholder={t("workOrders.resolutionPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setStatusOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleUpdateStatus} disabled={updateStatusMut.isPending} className="btn-primary">{t("workOrders.updateStatusButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Add Part Dialog ───────────────────────────────── */}
      {partOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setPartOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("workOrders.partsDialogTitle")}</h2>
              <button onClick={() => setPartOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>

            {/* Recorded parts — editable/removable while the work order is open */}
            <div className="space-y-2">
              {(partWoDetail?.parts || []).length === 0 ? (
                <p className="text-sm text-slate-500">{t("workOrders.noParts")}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                      <th className="py-1 pr-2">{t("workOrders.partsColumnName")}</th>
                      <th className="py-1 pr-2">{t("workOrders.partsColumnNumber")}</th>
                      <th className="py-1 pr-2 text-right">{t("workOrders.partsColumnQuantity")}</th>
                      <th className="py-1 pr-2 text-right">{t("workOrders.partsColumnUnitCost")}</th>
                      <th className="py-1 pr-2 text-right">{t("workOrders.partsColumnTotal")}</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(partWoDetail?.parts || []).map((part) => (
                      <tr key={part.id} className="border-b border-slate-100">
                        <td className="py-1.5 pr-2 text-slate-900">{part.partName}</td>
                        <td className="py-1.5 pr-2 text-slate-600">{part.partNumber || "-"}</td>
                        <td className="py-1.5 pr-2 text-right text-slate-600">{parseFloat(part.quantity).toFixed(2)}</td>
                        <td className="py-1.5 pr-2 text-right text-slate-600">{fmtNum(part.unitCost)}</td>
                        <td className="py-1.5 pr-2 text-right text-slate-900">{fmtNum(part.totalCost)}</td>
                        <td className="py-1.5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => openEditPart(part)}
                              className="text-slate-400 hover:text-indigo-600"
                              aria-label={t("workOrders.editPartTooltip")}
                              title={t("workOrders.editPartTooltip")}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => setDeletePrompt({ kind: "part", id: part.id, reason: "", reasonNote: "" })}
                              disabled={deletePartMut.isPending}
                              className="text-slate-400 hover:text-[var(--primary)]"
                              aria-label={t("workOrders.deletePartTooltip")}
                              title={t("workOrders.deletePartTooltip")}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="space-y-3 border-t border-slate-200 pt-3">
              <h3 className="text-sm font-semibold text-slate-700">{t("workOrders.addPartSectionTitle")}</h3>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formPartName")} <span className="text-[var(--primary)]">*</span></label>
                <input value={partForm.partName} onChange={(e) => setPartForm({ ...partForm, partName: e.target.value })} placeholder={t("workOrders.partNamePlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formPartNumber")}</label>
                <input value={partForm.partNumber} onChange={(e) => setPartForm({ ...partForm, partNumber: e.target.value })} placeholder={t("workOrders.partNumberPlaceholder")} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formQuantity")} <span className="text-[var(--primary)]">*</span></label>
                  <input type="number" step="0.01" min="0.01" value={partForm.quantity} onChange={(e) => setPartForm({ ...partForm, quantity: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formUnitCost")} <span className="text-[var(--primary)]">*</span></label>
                  <input type="number" step="0.01" min="0" placeholder="0.00" value={partForm.unitCost} onChange={(e) => setPartForm({ ...partForm, unitCost: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setPartOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleAddPart} disabled={addPartMut.isPending} className="btn-primary">{t("workOrders.addPartButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit Dialog ───────────────────────────────────── */}
      {editOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setEditOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("workOrders.editDialogTitle")} — {editWoNumber}</h2>
              <button onClick={() => setEditOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formEquipmentSource")}</label>
                  <select value={editForm.equipmentSource} onChange={(e) => setEditForm({ ...editForm, equipmentSource: e.target.value as EquipmentSource })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    <option value="equipment">{t("workOrders.sourceEquipment")}</option>
                    <option value="own_fleet">{t("workOrders.sourceOwnFleet")}</option>
                    <option value="other">{t("workOrders.sourceOther")}</option>
                  </select>
                </div>
                {editForm.equipmentSource === "equipment" ? (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formEquipment")} <span className="text-[var(--primary)]">*</span></label>
                    <FleetCombobox
                      items={fleetItems}
                      value={editForm.rentalFleetId}
                      onChange={(id) => setEditForm({ ...editForm, rentalFleetId: id })}
                      allowUnavailable
                      placeholder={t("workOrders.selectEquipmentPlaceholder")}
                      labels={fleetComboboxLabels}
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formPlateNumber")}</label>
                    <input value={editForm.plateNumber} onChange={(e) => setEditForm({ ...editForm, plateNumber: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                )}
              </div>
              {editForm.equipmentSource === "other" && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formCustomerName")} <span className="text-[var(--primary)]">*</span></label>
                    <input value={editForm.customerName} onChange={(e) => setEditForm({ ...editForm, customerName: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formCustomerPhone")}</label>
                    <input value={editForm.customerPhone} onChange={(e) => setEditForm({ ...editForm, customerPhone: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formSourceNote")}</label>
                    <input value={editForm.equipmentSourceNote} onChange={(e) => setEditForm({ ...editForm, equipmentSourceNote: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formMeterKms")}</label>
                  <input type="number" min="0" placeholder="KMS" value={editForm.meterKms} onChange={(e) => setEditForm({ ...editForm, meterKms: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formMeterHours")}</label>
                  <input type="number" step="0.1" min="0" placeholder="HRS" value={editForm.meterHours} onChange={(e) => setEditForm({ ...editForm, meterHours: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formType")}</label>
                  <select value={editForm.type} onChange={(e) => setEditForm({ ...editForm, type: e.target.value as WoType })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    {WO_TYPES.map((tp) => (
                      <option key={tp.value} value={tp.value}>{tp.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formPriority")}</label>
                  <select value={editForm.priority} onChange={(e) => setEditForm({ ...editForm, priority: e.target.value as WoPriority })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    {WO_PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formAssignedTo")}</label>
                  <select value={editForm.assignedTo} onChange={(e) => setEditForm({ ...editForm, assignedTo: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                    <option value="">{t("workOrders.unassignedOption")}</option>
                    {(Array.isArray(usersList) ? usersList : []).map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.email}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formScheduledDate")}</label>
                  <input type="date" value={editForm.scheduledDate} onChange={(e) => setEditForm({ ...editForm, scheduledDate: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formEstimatedHours")}</label>
                  <input type="number" step="0.5" min="0" placeholder="0" value={editForm.estimatedHours} onChange={(e) => setEditForm({ ...editForm, estimatedHours: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formLaborRate")}</label>
                  <input type="number" step="0.01" min="0" placeholder="0.00" value={editForm.laborRate} onChange={(e) => setEditForm({ ...editForm, laborRate: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formDescription")}</label>
                <textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={3} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formNotes")}</label>
                <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} rows={2} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setEditOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleEdit} disabled={updateInfoMut.isPending} className="btn-primary">{t("workOrders.saveButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Labor Tracking Dialog ─────────────────────────── */}
      {laborOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setLaborOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">
                {t("workOrders.laborDialogTitle")}
                {laborWoDetail?.work_orders?.workOrderNumber ? ` — ${laborWoDetail.work_orders.workOrderNumber}` : ""}
              </h2>
              <button onClick={() => setLaborOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>

            {/* Existing entries */}
            <div className="space-y-2">
              {(laborWoDetail?.labor || []).length === 0 ? (
                <p className="text-sm text-slate-500">{t("workOrders.noLaborEntries")}</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                      <th className="py-1 pr-2">{t("workOrders.laborTechnician")}</th>
                      <th className="py-1 pr-2">{t("workOrders.laborWorkDetail")}</th>
                      <th className="py-1 pr-2">{t("workOrders.laborStart")}</th>
                      <th className="py-1 pr-2">{t("workOrders.laborEnd")}</th>
                      <th className="py-1 pr-2 text-right">{t("workOrders.laborHours")}</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(laborWoDetail?.labor || []).map((entry) => {
                      const start = entry.startAt ? new Date(entry.startAt) : null;
                      const end = entry.endAt ? new Date(entry.endAt) : null;
                      const fmtTs = (d: Date | null) => d
                        ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d)
                        : "-";
                      const hrs = start && end ? Math.max(0, (end.getTime() - start.getTime()) / 3_600_000) : null;
                      return (
                        <tr key={entry.id} className="border-b border-slate-100">
                          <td className="py-1.5 pr-2 text-slate-900">{entry.technicianName}</td>
                          <td className="py-1.5 pr-2 text-slate-600">{entry.workDetail || "-"}</td>
                          <td className="py-1.5 pr-2 text-slate-600">{fmtTs(start)}</td>
                          <td className="py-1.5 pr-2 text-slate-600">{fmtTs(end)}</td>
                          <td className="py-1.5 pr-2 text-right text-slate-900">{hrs != null ? hrs.toFixed(2) : "-"}</td>
                          <td className="py-1.5 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => openEditLabor(entry)}
                                className="text-slate-400 hover:text-indigo-600"
                                aria-label={t("workOrders.editLaborTooltip")}
                                title={t("workOrders.editLaborTooltip")}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                onClick={() => setDeletePrompt({ kind: "labor", id: entry.id, reason: "", reasonNote: "" })}
                                disabled={deleteLaborMut.isPending}
                                className="text-slate-400 hover:text-[var(--primary)]"
                                aria-label={t("workOrders.deleteLaborTooltip")}
                                title={t("workOrders.deleteLaborTooltip")}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {laborWoDetail?.work_orders?.actualHours && (
                <p className="text-sm font-medium text-slate-700 text-right">
                  {t("workOrders.laborTotalHours")}: {parseFloat(laborWoDetail.work_orders.actualHours).toFixed(2)}
                </p>
              )}
            </div>

            {/* Add entry */}
            <div className="border-t border-slate-200 pt-3 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.laborTechnician")} <span className="text-[var(--primary)]">*</span></label>
                  <input list="wo-technicians" value={laborForm.technicianName} onChange={(e) => setLaborForm({ ...laborForm, technicianName: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                  <datalist id="wo-technicians">
                    {(Array.isArray(usersList) ? usersList : []).map((u) => (
                      <option key={u.id} value={u.name || u.email || ""} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.laborWorkDetail")}</label>
                  <input value={laborForm.workDetail} onChange={(e) => setLaborForm({ ...laborForm, workDetail: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.laborStart")} <span className="text-[var(--primary)]">*</span></label>
                  <input type="datetime-local" value={laborForm.startAt} onChange={(e) => setLaborForm({ ...laborForm, startAt: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.laborEnd")}</label>
                  <input type="datetime-local" value={laborForm.endAt} onChange={(e) => setLaborForm({ ...laborForm, endAt: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => setLaborOpen(false)} className="btn-secondary">{t("close", { ns: "common" })}</button>
                <button onClick={handleAddLabor} disabled={addLaborMut.isPending} className="btn-primary">{t("workOrders.addLaborButton")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* ─── Edit Part Dialog ──────────────────────────────── */}
      {editPartOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setEditPartOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("workOrders.editPartDialogTitle")}</h2>
              <button onClick={() => setEditPartOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formPartName")} <span className="text-[var(--primary)]">*</span></label>
                <input value={editPartForm.partName} onChange={(e) => setEditPartForm({ ...editPartForm, partName: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formPartNumber")}</label>
                <input value={editPartForm.partNumber} onChange={(e) => setEditPartForm({ ...editPartForm, partNumber: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formQuantity")} <span className="text-[var(--primary)]">*</span></label>
                  <input type="number" step="0.01" min="0.01" value={editPartForm.quantity} onChange={(e) => setEditPartForm({ ...editPartForm, quantity: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.formUnitCost")} <span className="text-[var(--primary)]">*</span></label>
                  <input type="number" step="0.01" min="0" value={editPartForm.unitCost} onChange={(e) => setEditPartForm({ ...editPartForm, unitCost: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              {renderReasonFields(editPartForm, (patch) => setEditPartForm({ ...editPartForm, ...patch }))}
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setEditPartOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleUpdatePart} disabled={updatePartMut.isPending} className="btn-primary">{t("workOrders.saveButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Edit Labour Entry Dialog ──────────────────────── */}
      {editLaborOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setEditLaborOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("workOrders.editLaborDialogTitle")}</h2>
              <button onClick={() => setEditLaborOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.laborTechnician")} <span className="text-[var(--primary)]">*</span></label>
                <input value={editLaborForm.technicianName} onChange={(e) => setEditLaborForm({ ...editLaborForm, technicianName: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.laborWorkDetail")}</label>
                <input value={editLaborForm.workDetail} onChange={(e) => setEditLaborForm({ ...editLaborForm, workDetail: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.laborStart")} <span className="text-[var(--primary)]">*</span></label>
                  <input type="datetime-local" value={editLaborForm.startAt} onChange={(e) => setEditLaborForm({ ...editLaborForm, startAt: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">{t("workOrders.laborEnd")}</label>
                  <input type="datetime-local" value={editLaborForm.endAt} onChange={(e) => setEditLaborForm({ ...editLaborForm, endAt: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              {renderReasonFields(editLaborForm, (patch) => setEditLaborForm({ ...editLaborForm, ...patch }))}
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setEditLaborOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleUpdateLabor} disabled={updateLaborMut.isPending} className="btn-primary">{t("workOrders.saveButton")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Delete-with-reason Dialog (part / labour) ─────── */}
      {deletePrompt && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setDeletePrompt(null)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">
                {deletePrompt.kind === "part" ? t("workOrders.deletePartConfirmTitle") : t("workOrders.deleteLaborConfirmTitle")}
              </h2>
              <button onClick={() => setDeletePrompt(null)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            {renderReasonFields(deletePrompt, (patch) => setDeletePrompt({ ...deletePrompt, ...patch }))}
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeletePrompt(null)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button
                onClick={handleConfirmDelete}
                disabled={deletePartMut.isPending || deleteLaborMut.isPending}
                className="btn-primary"
              >
                {t("delete", { ns: "common" })}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
