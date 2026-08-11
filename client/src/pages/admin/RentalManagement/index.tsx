import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSearch, useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import DataTable, { Column } from "@/components/DataTable";
import BatchActionBar from "@/components/BatchActionBar";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { formatCurrency, calculateRentalPrice, calculateDaysBetween } from "@/lib/pricing";
import { Plus, X, Trash2, CheckCircle, XCircle, ShieldAlert, Copy, MessageCircle, AlertTriangle, CalendarClock } from "lucide-react";
import { copyFinanceRowTSV, copyWeChatDispatch } from "@/lib/financeRow";
import { rentalStatusColors as statusColors } from "@/lib/statusColors";
import { derivePaymentState } from "@shared/paymentStatus";
import { calculateOrderDeposit } from "@shared/deposit";
import { overrideFieldNames } from "./overrideSummary";
import PaymentBadge from "@/components/PaymentBadge";
import RentalDetailDialog from "./RentalDetailDialog";
import ProvinceSelect from "@/components/ProvinceSelect";
import FleetCombobox from "@/components/FleetCombobox";
import { ConflictWarningBanner } from "@/components/ConflictWarningBanner";
import { useAuth } from "@/hooks/useAuth";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { translateDynamic } from "@/lib/i18nHelpers";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { OPEN_ENDED_END_DATE } from "@shared/creditOrders";
import { deriveRentalRollingListState } from "@shared/rentalRollingListState";
import { buildRentalSearchText } from "./rentalSearch";
import { getPositiveSearchParam } from "@/lib/adminSearchNavigation";
import { directRentalStatusOptions, rentalStatusOptions } from "@/lib/rentalStatusActions";
import { serverErrorText } from "@/lib/serverError";

const tabs = ["all", "pending", "approved", "active", "completed", "cancelled"] as const;

const emptyOrderForm = {
  customerId: "", customerName: "", customerEmail: "", customerPhone: "", customerCompany: "",
  customerDiscountPercent: "", customerCreditLimit: "",
  // Equipment is chosen by CATEGORY (e.g. "2 Ton Mini Excavator") — one entry per
  // category even when it spans several brand-models (ER620H + AX18). The system
  // then auto-assigns any available unit in the category. equipmentModelId holds a
  // representative model of the category (for rate/label lookup).
  equipmentCategory: "",
  equipmentModelId: "",
  rentalFleetId: "", equipmentDescription: "",
  startDate: "", endDate: "",
  deliveryMethod: "pickup" as const,
  deliveryAddress: "", deliveryProvince: "ON",
  scheduledDeliveryTime: "", scheduledPickupTime: "",
  // Insurance is REQUIRED by default (basic). Waiving to "none" is only allowed
  // when a detailed insurance certificate is on file (insuranceDocsReceived).
  insuranceType: "basic" as "none" | "basic" | "full",
  insuranceDocsReceived: false,
  rentalFee: "", freightCost: "", insuranceCost: "", taxAmount: "",
  depositAmount: "", totalAmount: "",
  projectDescription: "", adminNotes: "",
  projectId: "", referralCode: "",
  isCreditOrder: false,
  financialOrderNumber: "", cardLast4: "",
  priceMatchEnabled: false, priceMatchCompetitor: "", priceMatchAmount: "", priceMatchNote: "",
  // Additional equipment lines for one-order-multiple-units. Empty = single-unit
  // order (legacy adminCreate path); 1+ rows route to adminCreateWithItems.
  extraItems: [] as { equipmentCategory: string; equipmentModelId: string; rentalFleetId: string; quantity: number; startDate: string; endDate: string }[],
};

const TIME_OPTIONS = [
  { value: "", labelKey: "management.timePlaceholder" },
  { value: "07:00", label: "7:00" },
  { value: "08:00", label: "8:00" },
  { value: "09:00", label: "9:00" },
  { value: "10:00", label: "10:00" },
  { value: "11:00", label: "11:00" },
  { value: "12:00", label: "12:00" },
  { value: "13:00", label: "13:00" },
  { value: "14:00", label: "14:00" },
  { value: "15:00", label: "15:00" },
  { value: "16:00", label: "16:00" },
  { value: "17:00", label: "17:00" },
];

// Inline-editable 财务单号 (financialOrderNumber) cell for the rental list.
// Saves on blur / Enter only when the value actually changed. Stops click
// propagation so editing doesn't open the row's detail dialog.
function FinanceOrderCell({ id, value, onSave }: { id: number; value: string; onSave: (id: number, v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={() => { const tv = v.trim(); if (tv !== value) onSave(id, tv); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      placeholder="—"
      maxLength={40}
      className="w-28 bg-transparent hover:bg-slate-100 focus:bg-white border border-transparent hover:border-slate-300 focus:border-[var(--primary)] rounded px-1.5 py-1 text-sm text-slate-900 outline-none transition-colors"
    />
  );
}

export default function RentalManagement() {
  const { t } = useTranslation(["rental", "common"]);
  const utils = trpc.useUtils();
  // Copy one rental as a Transportation Log row (TSV → clipboard). Fetches the
  // hydrated order (incl. inspection / prepayment summaries) so the row matches
  // the detail-dialog output exactly.
  const copyFinanceRow = async (id: number) => {
    try {
      const data = await utils.rentals.getById.fetch({ id });
      if (!data) throw new Error("not found");
      await copyFinanceRowTSV(data);
      toast.success(t("management.financeRowCopied"));
    } catch {
      toast.error(t("management.copyFinanceRow"));
    }
  };
  // Copy a short dispatch block for the WeChat group (address / phone / time /
  // machine + serial / delivery note), one field per line.
  const copyWeChat = async (id: number) => {
    try {
      const data = await utils.rentals.getById.fetch({ id });
      if (!data) throw new Error("not found");
      await copyWeChatDispatch(data);
      toast.success(t("management.weChatCopied"));
    } catch {
      toast.error(t("management.copyWeChat"));
    }
  };
  const batchEnabled = useFeatureFlag("batch_operations");
  const { user } = useAuth();
  const creditFlagEnabled = useFeatureFlag("credit_limit");
  const creditOrdersEnabled = useFeatureFlag("credit_orders");
  const rollingOperationsEnabled = useFeatureFlag("rolling_renewal_operations");
  const isSuperAdmin = user?.role === "super_admin";

  // Tab state seeded from `?tab=` so Dashboard widgets can deep-link.
  // We only read on mount / URL change; clicking a tab updates local state
  // without writing back, to avoid disturbing browser history.
  const search = useSearch();
  const [, navigate] = useLocation();
  const urlTab = useMemo(() => {
    const candidate = new URLSearchParams(search).get("tab");
    return (tabs as readonly string[]).includes(candidate ?? "") ? (candidate as typeof tabs[number]) : null;
  }, [search]);
  const [tab, setTab] = useState<typeof tabs[number]>(urlTab ?? "all");
  // Dashboard "today" deep-links: ?today=deliveries|returns|starting|ending
  // narrow the list to that schedule bucket (otherwise the full list showed).
  const todayFilter = useMemo(() => {
    const v = new URLSearchParams(search).get("today");
    return (["deliveries", "returns", "starting", "ending"].includes(v ?? "") ? v : null) as
      "deliveries" | "returns" | "starting" | "ending" | null;
  }, [search]);
  const rollingFilter = useMemo(() => new URLSearchParams(search).get("rolling") === "all", [search]);
  useEffect(() => {
    if (urlTab) setTab(urlTab);
  }, [urlTab]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const linkedRentalId = getPositiveSearchParam(search, "rentalId");
  useEffect(() => {
    if (linkedRentalId) setSelectedId(linkedRentalId);
  }, [linkedRentalId]);
  const closeRentalDetail = useCallback(() => {
    setSelectedId(null);
    if (linkedRentalId) navigate("/admin/rental-management");
  }, [linkedRentalId, navigate]);
  const [createOpen, setCreateOpen] = useState(false);
  const [orderForm, setOrderForm] = useState(emptyOrderForm);

  type PhoneMatch = {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    address: string | null;
    province: string | null;
    isBlacklisted: boolean;
    discountPercent: string | null;
    creditLimit: string | null;
  };
  const [phoneMatches, setPhoneMatches] = useState<PhoneMatch[]>([]);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const phoneSearchSeq = useRef(0);
  // Name/company match search (mirrors phone). Picking either dropdown binds the
  // order to an existing customer id so the backend reuses it instead of creating
  // a duplicate — the root-cause fix for the duplicate-customer problem.
  const [nameMatches, setNameMatches] = useState<PhoneMatch[]>([]);
  const [nameOpen, setNameOpen] = useState(false);
  const nameSearchSeq = useRef(0);

  // Debounced phone search → dropdown of matches
  useEffect(() => {
    const raw = orderForm.customerPhone || "";
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 3) {
      setPhoneMatches([]);
      return;
    }
    const seq = ++phoneSearchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const rows = await utils.customers.searchByPhone.fetch({ phone: digits });
        if (seq !== phoneSearchSeq.current) return; // stale
        setPhoneMatches(rows || []);
      } catch {
        if (seq === phoneSearchSeq.current) setPhoneMatches([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [orderForm.customerPhone, utils]);

  // Debounced name/company search → dropdown of matches
  useEffect(() => {
    const q = (orderForm.customerName || "").trim();
    if (q.length < 2) {
      setNameMatches([]);
      return;
    }
    const seq = ++nameSearchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const rows = await utils.customers.searchForOrder.fetch({ query: q });
        if (seq !== nameSearchSeq.current) return; // stale
        setNameMatches(rows || []);
      } catch {
        if (seq === nameSearchSeq.current) setNameMatches([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [orderForm.customerName, utils]);

  const pickCustomerMatch = (m: PhoneMatch) => {
    // Picking a match replaces all customer-tied fields wholesale, including
    // clearing them when the matched record has no value. Otherwise stale
    // data from a previous match would leak across customers. customerId binds
    // the order to this existing record so the backend never creates a dup.
    setOrderForm((prev) => ({
      ...prev,
      customerId: String(m.id),
      customerName: m.name || "",
      customerEmail: m.email || "",
      customerPhone: m.phone || prev.customerPhone,
      customerCompany: m.company || "",
      customerDiscountPercent: m.discountPercent && parseFloat(m.discountPercent) > 0 ? String(parseFloat(m.discountPercent)) : "",
      customerCreditLimit: m.creditLimit && parseFloat(m.creditLimit) > 0 ? String(parseFloat(m.creditLimit)) : "",
      deliveryAddress: m.address || "",
      deliveryProvince: m.province || "ON",
    }));
    setPhoneOpen(false);
    setPhoneMatches([]);
    setNameOpen(false);
    setNameMatches([]);
    if (m.isBlacklisted) {
      toast.warning(t("management.phoneAutofillBlacklisted", { name: m.name }));
    } else {
      toast.success(t("management.phoneAutofillMatched", { name: m.name }));
    }
  };

  const resetCustomerFields = () => {
    setOrderForm((prev) => ({
      ...prev,
      customerId: "",
      customerName: "",
      customerEmail: "",
      customerPhone: "",
      customerCompany: "",
      customerDiscountPercent: "",
      customerCreditLimit: "",
      deliveryAddress: "",
      deliveryProvince: "ON",
    }));
    setPhoneMatches([]);
    setPhoneOpen(false);
    setNameMatches([]);
    setNameOpen(false);
  };

  // Credit block dialog state
  type AdminCreateInput = {
    customerName: string;
    customerEmail?: string;
    customerPhone?: string;
    customerCompany?: string;
    rentalFleetId?: number;
    equipmentModelId?: number;
    equipmentDescription?: string;
    startDate: string;
    endDate?: string;
    isCreditOrder?: boolean;
    deliveryMethod?: "pickup" | "delivery" | "delivery_and_return";
    deliveryAddress?: string;
    deliveryProvince?: string;
    insuranceType?: "none" | "basic" | "full";
    rentalFee?: string;
    freightCost?: string;
    insuranceCost?: string;
    taxAmount?: string;
    depositAmount?: string;
    totalAmount?: string;
    projectDescription?: string;
    adminNotes?: string;
    projectId?: number;
    referralCode?: string;
    scheduledDeliveryTime?: string;
    scheduledPickupTime?: string;
    creditOverride?: boolean;
  };
  const [creditBlock, setCreditBlock] = useState<{
    message: string;
    code: "blacklisted" | "over_limit";
    pendingPayload: AdminCreateInput | null;
  } | null>(null);
  const { data, isLoading } = trpc.rentals.list.useQuery(tab === "all" ? undefined : { status: tab as "pending" | "approved" | "rejected" | "active" | "completed" | "cancelled" });
  // Operational anomalies — orders whose status implies a business object that
  // wasn't generated (failed side effect / bypassed batch op). Surfaced so ops
  // can fix-forward instead of the gap staying invisible.
  const { data: opHealth } = trpc.reports.operationalHealth.useQuery();
  // Today-schedule deep-link: fetch the bucket and restrict the rows to its ids.
  const { data: todaySched } = trpc.dashboard.todaySchedule.useQuery(undefined, { enabled: !!todayFilter });
  const todayIdSet = useMemo(() => {
    if (!todayFilter || !todaySched) return null;
    const bucket = ({ deliveries: "deliveriesDue", returns: "returnsDue", starting: "startingToday", ending: "endingToday" } as const)[todayFilter];
    return new Set((todaySched[bucket] ?? []).map((o) => o.id));
  }, [todayFilter, todaySched]);
  const [overrideOnly, setOverrideOnly] = useState(false);
  const displayData = useMemo(() => {
    let base = data ?? [];
    if (todayIdSet) base = base.filter((row) => todayIdSet.has(row.rental_requests.id));
    if (rollingOperationsEnabled && rollingFilter) {
      const now = new Date();
      base = base.filter((row) => deriveRentalRollingListState({
        rentalStatus: row.rental_requests.status,
        endDate: new Date(row.rental_requests.endDate),
        rollingStatus: row.rental_rolling_terms?.status ?? null,
        isCreditOrder: row.rental_requests.isCreditOrder,
        now,
      }) !== null);
    }
    if (overrideOnly) base = base.filter((row) => row.rental_requests.priceMatchEnabled);
    return base;
  }, [data, todayIdSet, rollingOperationsEnabled, rollingFilter, overrideOnly]);
  const { data: paymentMapData } = trpc.rentals.paymentStatusMap.useQuery();
  const paymentMap = useMemo(() => {
    const m = new Map<number, { total: number; prepaid: number }>();
    for (const p of paymentMapData ?? []) m.set(p.id, { total: p.total, prepaid: p.prepaid });
    return m;
  }, [paymentMapData]);
  const { data: fleetData } = trpc.rentalFleet.listForDropdown.useQuery();
  // Availability-aware fleet list: only queries when both dates are set.
  // Credit (挂账) orders are open-ended — use the sentinel end so the bin is
  // checked as occupied for the whole open period.
  const effectiveEndDate = orderForm.isCreditOrder ? OPEN_ENDED_END_DATE : orderForm.endDate;
  const datesSelected = !!(orderForm.startDate && effectiveEndDate && orderForm.startDate < effectiveEndDate);
  const { data: fleetAvailabilityData } = trpc.rentalFleet.listWithAvailability.useQuery(
    { startDate: orderForm.startDate, endDate: effectiveEndDate },
    { enabled: datesSelected },
  );
  const { data: modelsData } = trpc.equipmentModels.list.useQuery({ onlyWithAssets: true });
  const { data: projectsData } = trpc.projects.list.useQuery();
  const updateStatus = trpc.rentals.updateStatus.useMutation({
    onSuccess: (result) => {
      utils.rentals.list.invalidate();
      utils.rentals.getById.invalidate();
      utils.reports.operationalHealth.invalidate();
      if (result.failures.length > 0) {
        toast.warning(t("management.statusUpdatedWithGaps", {
          kinds: Array.from(new Set(result.failures.map((failure) => failure.kind))).join(", "),
        }));
      } else {
        toast.success(t("management.statusUpdated"));
      }
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteMut = trpc.rentals.delete.useMutation({
    onSuccess: () => { utils.rentals.list.invalidate(); utils.reports.operationalHealth.invalidate(); toast.success(t("management.rentalDeleted")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  // Inline-edit 财务单号 straight from the list.
  const updateFinanceNumber = trpc.rentals.update.useMutation({
    onSuccess: () => { utils.rentals.list.invalidate(); utils.rentals.getById.invalidate(); toast.success(t("management.saved", "已保存")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const saveFinanceNumber = (id: number, financialOrderNumber: string) =>
    updateFinanceNumber.mutate({ id, financialOrderNumber });
  const adminCreateMut = trpc.rentals.adminCreate.useMutation({
    onSuccess: () => {
      utils.rentals.list.invalidate();
      utils.reports.operationalHealth.invalidate();
      setCreateOpen(false);
      setOrderForm(emptyOrderForm);
      setPhoneMatches([]);
      setPhoneOpen(false);
      setCreditBlock(null);
      toast.success(t("management.orderCreated"));
    },
    onError: (err, variables) => {
      if (creditFlagEnabled && err.data?.code === "FORBIDDEN" && err.message) {
        const isCreditError =
          err.message.includes("blacklisted") ||
          err.message.includes("Credit limit");
        if (isCreditError) {
          const code = err.message.includes("blacklisted") ? "blacklisted" : "over_limit";
          setCreditBlock({ message: err.message, code, pendingPayload: variables });
          return;
        }
      }
      toast.error(serverErrorText(err));
    },
  });
  // One-order-multiple-units submit. Same success/error UX as adminCreateMut.
  const adminCreateWithItemsMut = trpc.rentals.adminCreateWithItems.useMutation({
    onSuccess: () => {
      utils.rentals.list.invalidate();
      utils.reports.operationalHealth.invalidate();
      setCreateOpen(false);
      setOrderForm(emptyOrderForm);
      setPhoneMatches([]);
      setPhoneOpen(false);
      setNameMatches([]);
      setNameOpen(false);
      setCreditBlock(null);
      toast.success(t("management.orderCreated"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // ─── Batch operations ─────────────────────────────────────
  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set());
  const batchUpdateStatus = trpc.rentals.batchUpdateStatus.useMutation({
    onSuccess: (result) => {
      utils.rentals.list.invalidate();
      utils.reports.operationalHealth.invalidate();
      setSelectedKeys(new Set());
      const msg = result.failedIds.length > 0
        ? `${result.successIds.length} updated, ${result.failedIds.length} failed`
        : `${result.successIds.length} updated`;
      toast.success(msg);
      // Surface best-effort side-effect gaps (contract/quotation/invoice/fleet
      // not generated) so a batch approval that "succeeded" but left missing
      // business objects doesn't look fully clean.
      const withGaps = (result.details ?? []).filter((d) => d.failures.length > 0);
      if (withGaps.length > 0) {
        const kinds = Array.from(new Set(withGaps.flatMap((d) => d.failures.map((f) => f.kind))));
        toast.warning(`${withGaps.length} order(s) have missing objects: ${kinds.join(", ")}`);
      }
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // Inline project creation
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectForm, setNewProjectForm] = useState({ name: "", poNumber: "", siteAddress: "", contactName: "", contactPhone: "" });
  const { data: customersData } = trpc.customers.list.useQuery();
  const autoCreateCustomerMut = trpc.customers.create.useMutation({
    onSuccess: () => utils.customers.list.invalidate(),
  });
  const createProjectMut = trpc.projects.create.useMutation({
    onSuccess: (result) => {
      utils.projects.list.invalidate();
      setNewProjectOpen(false);
      setOrderForm((prev) => ({ ...prev, projectId: String(result.id), deliveryAddress: newProjectForm.siteAddress || prev.deliveryAddress }));
      setNewProjectForm({ name: "", poNumber: "", siteAddress: "", contactName: "", contactPhone: "" });
      toast.success(t("management.projectCreated"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // Sorted fleet items: available first, then rented, then held, then maintenance
  const sortedFleetItems = useMemo(() => {
    if (!fleetAvailabilityData) return [];
    const order = { available: 0, rented: 1, blocked: 2, maintenance: 3 };
    return [...fleetAvailabilityData].sort((a, b) => order[a.availabilityStatus] - order[b.availabilityStatus]);
  }, [fleetAvailabilityData]);

  // Per-model availability derived from the SAME date-aware per-unit data the
  // picker shows (fleetAvailabilityData). Single source of truth so the dropdown
  // count, the "X of Y available" line, and the per-unit list always agree — a
  // unit counts as available only when not in maintenance and free for the dates.
  // The static equipmentModels.availableAssets (currentStatus column) drifts and
  // is date-blind, so we only fall back to it before dates are picked.
  const availByModel = useMemo(() => {
    const m = new Map<number, { available: number; total: number }>();
    for (const f of fleetAvailabilityData ?? []) {
      if (f.equipmentModelId == null) continue;
      const cur = m.get(f.equipmentModelId) ?? { available: 0, total: 0 };
      cur.total += 1;
      if (f.availabilityStatus === "available") cur.available += 1;
      m.set(f.equipmentModelId, cur);
    }
    return m;
  }, [fleetAvailabilityData]);

  // Availability counts to show for a model option: date-aware when dates are set,
  // else the static fallback carried on the model row.
  const modelCounts = (m: { id: number; availableAssets: number; totalAssets: number }) => {
    const live = datesSelected ? availByModel.get(m.id) : undefined;
    return live ?? { available: m.availableAssets, total: m.totalAssets };
  };

  // Equipment is picked by CATEGORY, not by brand-model. Several brand-models can
  // share one category (e.g. "2 Ton Mini Excavator" = SDLG ER620H + ARCPATH AX18);
  // they're interchangeable for rental, so the dropdown shows ONE entry per
  // category with combined availability — matching the category-pricing page — and
  // the system auto-assigns any available unit in that category.
  const categoryOptions = useMemo(() => {
    const map = new Map<string, { category: string; available: number; total: number }>();
    for (const m of modelsData ?? []) {
      if (!m.category) continue;
      const e = map.get(m.category) ?? { category: m.category, available: 0, total: 0 };
      const c = modelCounts(m);
      e.available += c.available;
      e.total += c.total;
      map.set(m.category, e);
    }
    return Array.from(map.values()).sort((a, b) => a.category.localeCompare(b.category));
  }, [modelsData, availByModel, datesSelected]);

  // A representative model for a category — any one works for rate/label lookup
  // (they share the category rate); prefer one that currently has availability.
  const representativeModelId = (category: string): string => {
    const models = (modelsData ?? []).filter((m) => m.category === category);
    if (models.length === 0) return "";
    const withAvail = models.find((m) => modelCounts(m).available > 0);
    return String((withAvail ?? models[0]).id);
  };

  // Candidate fleet pool for a category: all its non-retired units (any brand-model
  // in the category). The server picks units free for each line's own dates.
  const fleetIdsForCategory = (category: string) =>
    (fleetAvailabilityData || []).filter((f) => f.category === category).map((f) => f.id);

  // Specific-asset picker is scoped to the chosen category — every unit across the
  // category's brand-models. No category picked → show everything.
  const fleetItemsForPrimary = useMemo(() => {
    if (!orderForm.equipmentCategory) return sortedFleetItems;
    return sortedFleetItems.filter((f) => f.category === orderForm.equipmentCategory);
  }, [sortedFleetItems, orderForm.equipmentCategory]);

  // Selected fleet item (prefer availability data for richer info, fallback to dropdown data)
  const selectedFleet = useMemo(() => {
    if (!orderForm.rentalFleetId) return null;
    const fromAvail = (fleetAvailabilityData || []).find((f) => String(f.id) === orderForm.rentalFleetId);
    if (fromAvail) return fromAvail;
    return (fleetData || []).find((f) => String(f.id) === orderForm.rentalFleetId) || null;
  }, [orderForm.rentalFleetId, fleetData, fleetAvailabilityData]);

  // Feature flag: conflict warning banner
  const conflictWarningEnabled = useFeatureFlag("conflict_warning");

  // Model availability query — includes conflict details when a specific asset is selected
  const modelIdNum = orderForm.equipmentModelId ? Number(orderForm.equipmentModelId) : 0;
  const fleetIdForConflict = orderForm.rentalFleetId ? Number(orderForm.rentalFleetId) : undefined;
  const conflictQueryEnabled = modelIdNum > 0 && datesSelected && !!fleetIdForConflict;
  const { data: modelAvailability } = trpc.rentals.modelAvailability.useQuery(
    {
      equipmentModelId: modelIdNum,
      startDate: orderForm.startDate || undefined,
      endDate: orderForm.endDate || undefined,
      rentalFleetId: fleetIdForConflict,
    },
    { enabled: modelIdNum > 0 },
  );

  // Derived conflict state
  const conflictingRentals = conflictQueryEnabled && conflictWarningEnabled
    ? (modelAvailability?.conflictingRentals ?? [])
    : [];
  const conflictAlternatives = conflictQueryEnabled && conflictWarningEnabled
    ? (modelAvailability?.alternatives ?? [])
    : [];
  const hasConflict = conflictingRentals.length > 0;

  // Auto-calculated rental price (DP algorithm)
  // Use resolvedDailyRate (includes category-level fallback) instead of fleet's own dailyRate
  const autoRentalPrice = useMemo(() => {
    if (!orderForm.startDate || !orderForm.endDate) return null;
    const start = new Date(orderForm.startDate);
    const end = new Date(orderForm.endDate);
    if (end <= start) return null;
    // Prefer the specific unit's resolved rate; when only a MODEL is picked
    // (auto-assign, no specific asset), fall back to a representative unit of that
    // model so the order still prices — otherwise a model-only order showed $0.
    let rates = selectedFleet;
    if (!rates && orderForm.equipmentModelId) {
      const mid = Number(orderForm.equipmentModelId);
      rates = (fleetAvailabilityData || []).find((f) => f.equipmentModelId === mid) ?? null;
    }
    if (!rates) return null;
    const daily = parseFloat(rates.resolvedDailyRate || rates.dailyRate || "0");
    if (!daily) return null;
    const weekly = parseFloat(rates.resolvedWeeklyRate || rates.weeklyRate || "0") || daily * 5;
    const monthly = parseFloat(rates.resolvedMonthlyRate || rates.monthlyRate || "0") || daily * 20;
    const days = calculateDaysBetween(start, end);
    return { ...calculateRentalPrice(days, daily, weekly, monthly), days };
  }, [selectedFleet, orderForm.equipmentModelId, orderForm.startDate, orderForm.endDate, fleetAvailabilityData]);

  // Customer-level discount (big-customer tier), auto-pulled when a customer is
  // picked and locked to that customer. Applies to the rental fee; insurance/tax
  // follow the discounted fee.
  const customerDiscountPct = Math.max(0, Math.min(100, parseFloat(orderForm.customerDiscountPercent || "0") || 0));
  const discountedRentalTotal = autoRentalPrice
    ? Math.round(autoRentalPrice.total * (1 - customerDiscountPct / 100) * 100) / 100
    : null;

  // ─── One-order-multiple-units ──────────────────────────────────────
  // Candidate fleet pool is taken per CATEGORY (all its non-retired units across
  // every brand-model) — NOT pre-filtered by order-date availability — so the
  // server can pick units free for each line's OWN dates (extra lines may have
  // different rental periods). The server enforces date availability per line.
  const isMultiItem = orderForm.extraItems.length > 0;

  // Build the combined items[] (primary line + extra lines) for the multi-item
  // submit / live preview. Returns null when the primary line has no equipment.
  // Extra lines carry their own startDate/endDate when set (different rental
  // periods in one order); the primary line always uses the order dates.
  const buildOrderItems = () => {
    const primaryCategory = orderForm.equipmentCategory || null;
    const primaryModelId = orderForm.equipmentModelId ? Number(orderForm.equipmentModelId) : null;
    const primaryFleetId = orderForm.rentalFleetId ? Number(orderForm.rentalFleetId) : null;
    if (!primaryCategory && !primaryFleetId) return null;
    const primary = {
      equipmentModelId: primaryModelId,
      availableFleetIds: primaryFleetId
        ? [primaryFleetId]
        : (primaryCategory ? fleetIdsForCategory(primaryCategory) : []),
      itemType: "machine" as const,
      quantity: 1,
      startDate: null as string | null,
      endDate: null as string | null,
    };
    const extras = orderForm.extraItems
      .filter((it) => it.equipmentCategory || it.rentalFleetId)
      .map((it) => {
        const mid = it.equipmentModelId ? Number(it.equipmentModelId) : null;
        const fid = it.rentalFleetId ? Number(it.rentalFleetId) : null;
        const hasDates = !!(it.startDate && it.endDate);
        return {
          equipmentModelId: mid,
          // A specific asset pins the line to that one unit (qty 1); otherwise
          // the category's whole pool is the candidate set (server picks per dates).
          availableFleetIds: fid ? [fid] : (it.equipmentCategory ? fleetIdsForCategory(it.equipmentCategory) : []),
          itemType: "machine" as const,
          quantity: fid ? 1 : Math.max(1, it.quantity || 1),
          startDate: hasDates ? it.startDate : null,
          endDate: hasDates ? it.endDate : null,
        };
      });
    return [primary, ...extras];
  };

  const multiItems = isMultiItem ? buildOrderItems() : null;

  // Live multi-item quote preview (server is the source of truth on submit).
  const { data: multiQuote } = trpc.rentals.previewMultiItemQuote.useQuery(
    {
      startDate: orderForm.startDate,
      endDate: effectiveEndDate,
      deliveryMethod: orderForm.deliveryMethod,
      deliveryAddress: orderForm.deliveryAddress || undefined,
      taxProvince: orderForm.deliveryProvince || undefined,
      insuranceType: orderForm.insuranceType,
      items: (multiItems || []).map((i) => ({
        equipmentModelId: i.equipmentModelId,
        fleetIds: i.availableFleetIds,
        itemType: i.itemType,
        quantity: i.quantity,
        startDate: i.startDate,
        endDate: i.endDate,
      })),
    },
    { enabled: !!multiItems && multiItems.length > 0 && datesSelected && !orderForm.priceMatchEnabled },
  );

  const addExtraItem = () =>
    setOrderForm((prev) => ({ ...prev, extraItems: [...prev.extraItems, { equipmentCategory: "", equipmentModelId: "", rentalFleetId: "", quantity: 1, startDate: "", endDate: "" }] }));
  const updateExtraItem = (idx: number, patch: Partial<{ equipmentCategory: string; equipmentModelId: string; rentalFleetId: string; quantity: number; startDate: string; endDate: string }>) =>
    setOrderForm((prev) => ({ ...prev, extraItems: prev.extraItems.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));
  const removeExtraItem = (idx: number) =>
    setOrderForm((prev) => ({ ...prev, extraItems: prev.extraItems.filter((_, i) => i !== idx) }));

  // Reactive tRPC queries for auto-calculation
  const fleetIdNum = orderForm.rentalFleetId ? Number(orderForm.rentalFleetId) : 0;

  // Smart shipping: use distance-based calc when address is provided, else fallback to tier baseFee
  const hasDeliveryAddress = (orderForm.deliveryAddress || "").trim().length > 5;
  const needsShipping = orderForm.deliveryMethod !== "pickup";

  const { data: shippingSmartData } = trpc.shipping.calculateCostSmart.useQuery(
    { rentalFleetId: fleetIdNum, deliveryAddress: orderForm.deliveryAddress, deliveryMethod: orderForm.deliveryMethod },
    { enabled: fleetIdNum > 0 && needsShipping && hasDeliveryAddress },
  );

  const { data: shippingFallbackData } = trpc.shipping.calculateCostFallback.useQuery(
    { rentalFleetId: fleetIdNum, deliveryMethod: orderForm.deliveryMethod },
    { enabled: fleetIdNum > 0 && needsShipping && !hasDeliveryAddress },
  );

  const shippingData = hasDeliveryAddress ? shippingSmartData : shippingFallbackData;

  const { data: insuranceOptions } = trpc.rentalSettings.getInsuranceOptions.useQuery();

  // Compute insurance cost from rental fee + insurance type + insurance options
  const autoInsuranceCost = useMemo(() => {
    if (orderForm.insuranceType === "none" || discountedRentalTotal == null || !insuranceOptions) return 0;
    const opt = insuranceOptions[orderForm.insuranceType as keyof typeof insuranceOptions];
    if (!opt || !("costPercentage" in opt)) return 0;
    return discountedRentalTotal * (opt.costPercentage as number);
  }, [orderForm.insuranceType, discountedRentalTotal, insuranceOptions]);

  // Freight cost
  const autoFreightCost = useMemo(() => {
    if (orderForm.deliveryMethod === "pickup") return 0;
    return shippingData?.totalCost ?? 0;
  }, [orderForm.deliveryMethod, shippingData]);

  // Deposit: 1.5× after-tax (rent+insurance+freight), rounded up to $50.
  // Account/credit customers (creditLimit > 0) are waived to $0.
  const customerCreditLimit = parseFloat(orderForm.customerCreditLimit || "0") || 0;
  const autoDeposit = useMemo(() => {
    const afterTax = (parseFloat(orderForm.rentalFee) || 0)
      + (parseFloat(orderForm.insuranceCost) || 0)
      + (parseFloat(orderForm.freightCost) || 0)
      + (parseFloat(orderForm.taxAmount) || 0);
    return calculateOrderDeposit(afterTax, { creditLimit: customerCreditLimit });
  }, [orderForm.rentalFee, orderForm.insuranceCost, orderForm.freightCost, orderForm.taxAmount, customerCreditLimit]);

  // Tax query
  const rentalFeeNum = parseFloat(orderForm.rentalFee) || 0;
  const freightNum = parseFloat(orderForm.freightCost) || 0;
  const insuranceNum = parseFloat(orderForm.insuranceCost) || 0;
  const provinceValid = orderForm.deliveryProvince.length === 2;

  const { data: taxData } = trpc.rentalSettings.calculateTaxForProvince.useQuery(
    {
      province: orderForm.deliveryProvince,
      rentalAmount: rentalFeeNum,
      shippingAmount: freightNum,
      ldwAmount: insuranceNum,
      depositAmount: 0,
    },
    { enabled: provinceValid && rentalFeeNum > 0 },
  );

  const autoTax = useMemo(() => {
    if (taxData?.totalTax) return taxData.totalTax;
    // Fallback: ON HST 13% when tax query hasn't fired or returned no data
    const taxBase = rentalFeeNum + freightNum + insuranceNum;
    if (taxBase > 0) return Math.round(taxBase * 0.13 * 100) / 100;
    return 0;
  }, [taxData, rentalFeeNum, freightNum, insuranceNum]);

  // Credit (挂账) orders have a TBD amount settled at swap/close-out — skip all
  // auto-pricing so the form never fills (and never clobbers) money fields.
  // Auto-fill rental fee when fleet/dates change
  useEffect(() => {
    if (orderForm.isCreditOrder || orderForm.priceMatchEnabled) return;
    if (autoRentalPrice && discountedRentalTotal != null) {
      setOrderForm((prev) => ({ ...prev, rentalFee: discountedRentalTotal.toFixed(2) }));
    }
  }, [discountedRentalTotal, autoRentalPrice, orderForm.isCreditOrder, orderForm.priceMatchEnabled]);

  // Auto-fill freight when shipping data changes
  useEffect(() => {
    if (orderForm.isCreditOrder || orderForm.priceMatchEnabled) return;
    setOrderForm((prev) => ({ ...prev, freightCost: autoFreightCost ? autoFreightCost.toFixed(2) : "0" }));
  }, [autoFreightCost, orderForm.isCreditOrder, orderForm.priceMatchEnabled]);

  // Auto-fill insurance cost
  useEffect(() => {
    if (orderForm.isCreditOrder || orderForm.priceMatchEnabled) return;
    setOrderForm((prev) => ({ ...prev, insuranceCost: autoInsuranceCost ? autoInsuranceCost.toFixed(2) : "0" }));
  }, [autoInsuranceCost, orderForm.isCreditOrder, orderForm.priceMatchEnabled]);

  // Auto-fill deposit
  useEffect(() => {
    if (orderForm.isCreditOrder || orderForm.priceMatchEnabled) return;
    setOrderForm((prev) => ({ ...prev, depositAmount: autoDeposit ? autoDeposit.toFixed(2) : "0" }));
  }, [autoDeposit, orderForm.isCreditOrder, orderForm.priceMatchEnabled]);

  // Auto-fill tax
  useEffect(() => {
    if (orderForm.isCreditOrder || orderForm.priceMatchEnabled) return;
    setOrderForm((prev) => ({ ...prev, taxAmount: autoTax ? autoTax.toFixed(2) : "0" }));
  }, [autoTax, orderForm.isCreditOrder, orderForm.priceMatchEnabled]);

  // Update form field and trigger recalculation
  const updateField = (updates: Partial<typeof orderForm>) => {
    setOrderForm((prev) => ({ ...prev, ...updates }));
  };

  const calcOrderTotal = () => {
    // Deposit is a refundable liability, NOT billed revenue — it must be excluded
    // from the order total (matches multiItemPricing.ts:299 and useRentalRequest.ts:138;
    // see shared/deposit.ts). Total = rent + freight + insurance + tax.
    return [orderForm.rentalFee, orderForm.freightCost, orderForm.insuranceCost, orderForm.taxAmount]
      .reduce((acc, val) => acc + (parseFloat(val) || 0), 0);
  };

  const handleCreateOrder = () => {
    const needsEndDate = !orderForm.isCreditOrder;
    if (!orderForm.customerName || !orderForm.startDate || (needsEndDate && !orderForm.endDate)) {
      return toast.error(t("management.requiredFields"));
    }
    if (!orderForm.customerPhone || !orderForm.customerPhone.trim()) {
      return toast.error(t("management.phoneRequired"));
    }
    // Insurance is required unless a detailed certificate is on file.
    if (orderForm.insuranceType === "none" && !orderForm.insuranceDocsReceived) {
      return toast.error(t("management.insuranceWaiverRequiresDocs"));
    }
    // Money fields are locked to the system-computed values; the Override toggle
    // unlocks them but a reason is mandatory.
    if (orderForm.priceMatchEnabled && !orderForm.priceMatchNote.trim()) {
      return toast.error(t("management.overrideReasonRequired"));
    }
    // Overriding the auto-computed freight or deposit (e.g. a bundled discount,
    // a >75km manual quote, or a credit waiver) requires an explanation note.
    if (!orderForm.isCreditOrder && !orderForm.priceMatchEnabled) {
      const freightOverridden = Math.abs((parseFloat(orderForm.freightCost) || 0) - autoFreightCost) > 1;
      const depositOverridden = Math.abs((parseFloat(orderForm.depositAmount) || 0) - autoDeposit) > 1;
      if ((freightOverridden || depositOverridden) && !orderForm.adminNotes.trim()) {
        return toast.error(t("management.overrideNeedsNote"));
      }
    }
    // Conflict warning confirmation step: warn admin about double-booking
    if (hasConflict) {
      const firstConflict = conflictingRentals[0];
      const rentalRef = firstConflict.rentalNumber ? `#${firstConflict.rentalNumber}` : `#${firstConflict.id}`;
      const ok = window.confirm(t("rentalMgmt.confirmOccupiedSlot", {
        ns: "admin",
        equipment: orderForm.equipmentDescription || "",
        rental: rentalRef,
      }));
      if (!ok) return;
    }
    // Safety check: verify selected equipment is available for the date range
    if (orderForm.rentalFleetId && fleetAvailabilityData) {
      const selected = fleetAvailabilityData.find(f => String(f.id) === orderForm.rentalFleetId);
      if (selected && selected.availabilityStatus !== 'available') {
        const name = `${selected.brand} ${selected.model}`;
        if (selected.availabilityStatus === 'rented') {
          return toast.error(
            t("management.equipNotAvailableError",
              `Equipment ${name} is not available from ${orderForm.startDate} to ${orderForm.endDate}. It is currently rented until ${selected.conflictingRentalEnd || 'unknown'}.`,
              { name, startDate: orderForm.startDate, endDate: orderForm.endDate, returnDate: selected.conflictingRentalEnd || 'unknown' }
            )
          );
        }
        if (selected.availabilityStatus === 'blocked') {
          // Point at the document to close, not at a customer who does not have it.
          return toast.error(
            t("management.equipBlockedError", {
              name,
              refs: (selected.blockRefs || []).join(", ") || t("management.equipBlockedNoRef"),
            })
          );
        }
        return toast.error(
          t("management.equipMaintenanceError",
            `Equipment ${name} is currently under maintenance and cannot be rented.`,
            { name }
          )
        );
      }
    }
    const credit = orderForm.isCreditOrder;
    const total = calcOrderTotal().toFixed(2);

    // One-order-multiple-units path: route to adminCreateWithItems.
    if (isMultiItem) {
      if (credit) {
        return toast.error(t("management.multiUnitNoCredit", "Credit orders must be single-unit."));
      }
      // Per-line dates must be complete (both or neither) and valid (start < end).
      for (const it of orderForm.extraItems) {
        if (!it.equipmentCategory) continue;
        if (!!it.startDate !== !!it.endDate) {
          return toast.error(t("management.lineDatesIncomplete"));
        }
        if (it.startDate && it.endDate && it.startDate >= it.endDate) {
          return toast.error(t("management.lineDatesInvalid"));
        }
      }
      const items = buildOrderItems();
      if (!items || items.some((it) => it.itemType === "machine" && it.availableFleetIds.length === 0)) {
        return toast.error(t("management.multiUnitNoUnits", "Some equipment has no available units for the selected dates."));
      }
      const pm = orderForm.priceMatchEnabled;
      adminCreateWithItemsMut.mutate({
        customerId: orderForm.customerId ? Number(orderForm.customerId) : undefined,
        customerDiscountPercent: customerDiscountPct > 0 ? customerDiscountPct : undefined,
        customerName: orderForm.customerName,
        customerEmail: orderForm.customerEmail || undefined,
        customerPhone: orderForm.customerPhone || undefined,
        customerCompany: orderForm.customerCompany || undefined,
        startDate: orderForm.startDate,
        endDate: orderForm.endDate,
        deliveryMethod: orderForm.deliveryMethod,
        deliveryAddress: orderForm.deliveryAddress || undefined,
        deliveryProvince: orderForm.deliveryProvince || undefined,
        insuranceType: orderForm.insuranceType,
        insuranceDocsReceived: orderForm.insuranceDocsReceived,
        projectDescription: orderForm.projectDescription || undefined,
        adminNotes: orderForm.adminNotes || undefined,
        projectId: orderForm.projectId ? Number(orderForm.projectId) : undefined,
        scheduledDeliveryTime: orderForm.scheduledDeliveryTime || undefined,
        scheduledPickupTime: orderForm.scheduledPickupTime || undefined,
        financialOrderNumber: orderForm.financialOrderNumber || undefined,
        cardLast4: orderForm.cardLast4 || undefined,
        priceMatchEnabled: pm || undefined,
        priceMatchCompetitor: pm ? (orderForm.priceMatchCompetitor || undefined) : undefined,
        priceMatchAmount: pm ? (orderForm.priceMatchAmount || undefined) : undefined,
        priceMatchNote: pm ? (orderForm.priceMatchNote || undefined) : undefined,
        rentalFee: pm ? (orderForm.rentalFee || undefined) : undefined,
        freightCost: pm ? (orderForm.freightCost || undefined) : undefined,
        insuranceCost: pm ? (orderForm.insuranceCost || undefined) : undefined,
        taxAmount: pm ? (orderForm.taxAmount || undefined) : undefined,
        depositAmount: pm ? (orderForm.depositAmount || undefined) : undefined,
        totalAmount: pm ? (total !== "0.00" ? total : undefined) : undefined,
        items,
      });
      return;
    }

    // Category auto-assign for the single-item path: when no specific unit is
    // chosen, resolve a concrete available unit from the whole category (any
    // brand-model) here, so the server isn't limited to one model's pool. The
    // recorded model follows the assigned unit.
    let resolvedFleetId = orderForm.rentalFleetId ? Number(orderForm.rentalFleetId) : undefined;
    if (!resolvedFleetId && orderForm.equipmentCategory) {
      const pick = fleetItemsForPrimary.find((f) => f.availabilityStatus === "available");
      if (!pick) {
        return toast.error(t("management.multiUnitNoUnits", "Some equipment has no available units for the selected dates."));
      }
      resolvedFleetId = pick.id;
    }
    const resolvedUnit = resolvedFleetId ? (fleetAvailabilityData || []).find((f) => f.id === resolvedFleetId) : null;
    const resolvedModelId = resolvedUnit?.equipmentModelId ?? (orderForm.equipmentModelId ? Number(orderForm.equipmentModelId) : undefined);

    adminCreateMut.mutate({
      customerId: orderForm.customerId ? Number(orderForm.customerId) : undefined,
      customerDiscountPercent: customerDiscountPct > 0 ? customerDiscountPct : undefined,
      customerName: orderForm.customerName,
      customerEmail: orderForm.customerEmail || undefined,
      customerPhone: orderForm.customerPhone || undefined,
      customerCompany: orderForm.customerCompany || undefined,
      rentalFleetId: resolvedFleetId,
      equipmentModelId: resolvedModelId,
      equipmentDescription: orderForm.equipmentDescription || undefined,
      startDate: orderForm.startDate,
      // Credit orders are open-ended (server stores the sentinel) with a TBD amount.
      endDate: credit ? undefined : orderForm.endDate,
      isCreditOrder: credit || undefined,
      deliveryMethod: orderForm.deliveryMethod,
      deliveryAddress: orderForm.deliveryAddress || undefined,
      deliveryProvince: orderForm.deliveryProvince || undefined,
      insuranceType: orderForm.insuranceType,
      insuranceDocsReceived: orderForm.insuranceDocsReceived,
      rentalFee: credit ? undefined : orderForm.rentalFee || undefined,
      freightCost: credit ? undefined : orderForm.freightCost || undefined,
      insuranceCost: credit ? undefined : orderForm.insuranceCost || undefined,
      taxAmount: credit ? undefined : orderForm.taxAmount || undefined,
      depositAmount: credit ? undefined : orderForm.depositAmount || undefined,
      totalAmount: credit ? undefined : (total !== "0.00" ? total : undefined),
      projectDescription: orderForm.projectDescription || undefined,
      adminNotes: orderForm.adminNotes || undefined,
      projectId: orderForm.projectId ? Number(orderForm.projectId) : undefined,
      referralCode: orderForm.referralCode || undefined,
      scheduledDeliveryTime: orderForm.scheduledDeliveryTime || undefined,
      scheduledPickupTime: orderForm.scheduledPickupTime || undefined,
      financialOrderNumber: orderForm.financialOrderNumber || undefined,
      cardLast4: orderForm.cardLast4 || undefined,
      priceMatchEnabled: orderForm.priceMatchEnabled || undefined,
      priceMatchCompetitor: orderForm.priceMatchEnabled ? (orderForm.priceMatchCompetitor || undefined) : undefined,
      priceMatchAmount: orderForm.priceMatchEnabled ? (orderForm.priceMatchAmount || undefined) : undefined,
      priceMatchNote: orderForm.priceMatchEnabled ? (orderForm.priceMatchNote || undefined) : undefined,
    });
  };

  const fmtDate = useFormatCalendarDate();

  type RentalListRow = NonNullable<typeof data>[number];
  const getRentalSearchText = useCallback((row: RentalListRow) => buildRentalSearchText(row, {
    statusLabel: t(`status.${row.rental_requests.status}`, { ns: "common" }),
    formatDate: fmtDate,
  }), [fmtDate, t]);
  const columns: Column<RentalListRow>[] = [
    {
      key: "rental_requests.id",
      label: t("management.id"),
      render: (row) => (
        <span className="text-slate-900 font-medium">
          {row.rental_requests.rentalNumber || `#${row.rental_requests.id}`}
          {rollingOperationsEnabled && (() => {
            const rollingState = deriveRentalRollingListState({
              rentalStatus: row.rental_requests.status,
              endDate: new Date(row.rental_requests.endDate),
              rollingStatus: row.rental_rolling_terms?.status ?? null,
              isCreditOrder: row.rental_requests.isCreditOrder,
            });
            if (!rollingState) return null;
            const badge = {
              active: { label: t("rolling.list.active"), className: "bg-blue-100 text-blue-800 ring-blue-200" },
              ending: { label: t("rolling.list.ending"), className: "bg-orange-100 text-orange-800 ring-orange-200" },
              candidate: { label: t("rolling.list.candidate"), className: "bg-amber-50 text-amber-800 ring-amber-300" },
            }[rollingState];
            return (
              <span className={`ml-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ring-inset ${badge.className}`}>
                <CalendarClock size={11} aria-hidden="true" />
                {badge.label}
              </span>
            );
          })()}
          {row.rental_requests.isCreditOrder && (
            <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-100 text-amber-700">
              {t("management.creditOrderBadge", "挂账")}
            </span>
          )}
          {row.rental_requests.priceMatchEnabled && (() => {
            const names = overrideFieldNames(row.rental_requests.priceMatchFields, t);
            const note = row.rental_requests.priceMatchNote ?? "";
            const tip = [names && `${t("management.overrideChanged")}: ${names}`, note].filter(Boolean).join(" · ");
            return (
              <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-orange-100 text-orange-700" title={tip}>
                {t("management.overrideBadge", "改价")}{names ? `: ${names}` : ""}
              </span>
            );
          })()}
          {row.rental_requests.deliveryMethod !== "pickup" && !row.rental_requests.deliveryAddress?.trim() ? (
            <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700" title={t("management.freightNoAddressWarning")}>
              ⚠ {t("management.addressMissingShort")}
            </span>
          ) : row.rental_requests.freightEstimated && (
            <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-700" title={t("management.freightEstimatedWarning")}>
              ⚠ {t("management.overrideField.freightCost")}?
            </span>
          )}
        </span>
      ),
    },
    {
      key: "rental_requests.financialOrderNumber",
      label: t("management.financialOrderNumberShort"),
      render: (row) => (
        <FinanceOrderCell
          id={row.rental_requests.id}
          value={row.rental_requests.financialOrderNumber ?? ""}
          onSave={saveFinanceNumber}
        />
      ),
    },
    {
      key: "rental_requests.customerName",
      label: t("management.customer"),
      render: (row) => (
        <div>
          <div className="text-slate-900">{row.rental_requests.customerName}</div>
          <div className="text-xs text-slate-400">{row.rental_requests.customerEmail}</div>
        </div>
      ),
    },
    {
      key: "rental_fleet.brand",
      label: t("management.equipment"),
      hideOnMobile: true,
      render: (row) => {
        const fleet = row.rental_fleet;
        const r = row.rental_requests;
        if (!fleet) return r.equipmentDescription || "-";
        return (
          <div>
            <div>{fleet.brand} {fleet.model}</div>
            {fleet.serialNumber && (
              <div className="text-xs text-slate-400 font-mono">S/N: {fleet.serialNumber}</div>
            )}
          </div>
        );
      },
    },
    {
      key: "rental_requests.startDate",
      label: t("management.dates"),
      hideOnMobile: true,
      render: (row) => (
        <div className="text-xs">{fmtDate(row.rental_requests.startDate)} - {fmtDate(row.rental_requests.endDate)}</div>
      ),
    },
    {
      key: "rental_requests.totalAmount",
      label: t("management.total"),
      hideOnMobile: true,
      render: (row) => {
        const r = row.rental_requests;
        if (r.isCreditOrder && !r.creditFinalizedAt) {
          return <span className="text-amber-600">{t("management.amountTBD", "TBD")}</span>;
        }
        const pay = paymentMap.get(r.id);
        const showBadge = pay && pay.total > 0;
        return (
          <div className="flex flex-col items-start gap-1">
            <span>{r.totalAmount ? formatCurrency(parseFloat(r.totalAmount)) : "-"}</span>
            {showBadge && <PaymentBadge state={derivePaymentState(pay.total, pay.prepaid)} />}
          </div>
        );
      },
    },
    {
      key: "rental_requests.status",
      label: t("status", { ns: "common" }),
      render: (row) => (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${statusColors[row.rental_requests.status] || ""}`}>
          {t(`status.${row.rental_requests.status}`, { ns: "common" })}
        </span>
      ),
    },
    {
      key: "_actions",
      label: t("actions", { ns: "common" }),
      sortable: false,
      searchable: false,
      render: (row) => (
        <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
          <div className="flex items-center gap-2 md:hidden">
            <select
              value={row.rental_requests.status}
              onChange={(e) => updateStatus.mutate({
                id: row.rental_requests.id,
                status: e.target.value as typeof rentalStatusOptions[number],
              })}
              className="max-w-28 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-900"
              aria-label={t("status", { ns: "common" })}
            >
              {directRentalStatusOptions(row.rental_requests.status).map((s) => <option key={s} value={s}>{t(`status.${s}`, { ns: "common" })}</option>)}
            </select>
            <details className="rounded border border-slate-200 bg-white px-2 py-1.5 text-xs">
              <summary className="cursor-pointer font-bold text-slate-700">{t("management.more")}</summary>
              <div className="mt-2 flex min-w-40 flex-col gap-1.5 border-t border-slate-100 pt-2">
                <button onClick={() => copyFinanceRow(row.rental_requests.id)} className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-50">
                  <Copy size={14} /> {t("management.copyFinanceRow")}
                </button>
                <button onClick={() => copyWeChat(row.rental_requests.id)} className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-50">
                  <MessageCircle size={14} /> {t("management.copyWeChat")}
                </button>
                <button
                  onClick={() => {
                    if (confirm(t("management.deleteConfirmDetailed", {
                      rental: row.rental_requests.rentalNumber || `#${row.rental_requests.id}`,
                      customer: row.rental_requests.customerName,
                    }))) deleteMut.mutate({ id: row.rental_requests.id });
                  }}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-left font-bold text-red-700 hover:bg-red-50"
                >
                  <Trash2 size={14} /> {t("delete", { ns: "common" })}
                </button>
              </div>
            </details>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <select
              value={row.rental_requests.status}
              onChange={(e) => updateStatus.mutate({
                id: row.rental_requests.id,
                status: e.target.value as typeof rentalStatusOptions[number],
              })}
              className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-900"
            >
              {directRentalStatusOptions(row.rental_requests.status).map((s) => <option key={s} value={s}>{t(`status.${s}`, { ns: "common" })}</option>)}
            </select>
            <button onClick={() => copyFinanceRow(row.rental_requests.id)} className="text-slate-400 hover:text-[var(--primary)]" aria-label={t("management.copyFinanceRow")} title={t("management.copyFinanceRow")}><Copy size={16} /></button>
            <button onClick={() => copyWeChat(row.rental_requests.id)} className="text-slate-400 hover:text-[var(--primary)]" aria-label={t("management.copyWeChat")} title={t("management.copyWeChat")}><MessageCircle size={16} /></button>
            <button
              onClick={() => {
                if (confirm(t("management.deleteConfirmDetailed", {
                  rental: row.rental_requests.rentalNumber || `#${row.rental_requests.id}`,
                  customer: row.rental_requests.customerName,
                }))) deleteMut.mutate({ id: row.rental_requests.id });
              }}
              className="text-slate-400 hover:text-[var(--primary)]"
              aria-label={t("delete", { ns: "common" })}
            ><Trash2 size={16} /></button>
          </div>
        </div>
      ),
    },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("management.title")}</h1>
          <button onClick={() => setCreateOpen(true)} className="btn-primary flex items-center gap-2">
            <Plus size={18} /> {t("management.createOrder")}
          </button>
        </div>

        {/* Operational anomalies — orders whose state implies a business object
            that wasn't generated. Grouped by issue with a plain-language
            explanation + the concrete next action, so it reads as a to-do. */}
        {opHealth && opHealth.count > 0 && (() => {
          // issue → { what it means, what to do }. Order numbers listed per group.
          const ISSUE_META: Record<string, { label: string; action: string }> = {
            no_dispatch: {
              label: t("management.anomalies.no_dispatch", "No dispatch order — a driver won't be scheduled to deliver/collect"),
              action: t("management.anomalies.no_dispatch_fix", "Create a dispatch order on the Dispatch page."),
            },
            no_contract: {
              label: t("management.anomalies.no_contract", "No rental contract was generated"),
              action: t("management.anomalies.no_contract_fix", "Re-approve the order or regenerate the contract."),
            },
            no_invoice: {
              label: t("management.anomalies.no_invoice", "Order is completed but has no invoice"),
              action: t("management.anomalies.no_invoice_fix", "Generate an invoice for the order."),
            },
            fleet_not_rented: {
              label: t("management.anomalies.fleet_not_rented", "Order is active but its equipment isn't marked rented (it may be double-booked)"),
              action: t("management.anomalies.fleet_not_rented_fix", "Re-activate the order so the equipment status syncs."),
            },
          };
          const groups = Array.from(new Set(opHealth.items.map((i) => i.issue))).map((issue) => ({
            issue,
            meta: ISSUE_META[issue] ?? { label: issue, action: "" },
            orders: opHealth.items.filter((i) => i.issue === issue).map((i) => i.orderNo),
          }));
          return (
            <div className="bg-red-50 border-l-4 border-red-500 rounded-lg p-4">
              <div className="flex items-center gap-2">
                <AlertTriangle size={18} className="text-red-600 shrink-0" />
                <h2 className="text-sm font-bold text-red-800">
                  {t("management.anomalies.title", { count: opHealth.count, defaultValue: "Action needed: {{count}} order(s) are missing a required step" })}
                </h2>
              </div>
              <ul className="mt-3 space-y-2.5">
                {groups.map((g) => (
                  <li key={g.issue} className="text-sm">
                    <div className="font-semibold text-red-800">{g.meta.label}</div>
                    <div className="text-xs text-red-700 mt-0.5">
                      {t("management.anomalies.affected", "Affected")}: <span className="font-mono">{g.orders.join(", ")}</span>
                    </div>
                    {g.meta.action && <div className="text-xs text-slate-600 mt-0.5">→ {g.meta.action}</div>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}

        <div className="flex gap-2 flex-wrap items-center">
          {tabs.map((tabKey) => (
            <button key={tabKey} onClick={() => setTab(tabKey)} className={`px-4 py-2 rounded-lg text-sm font-medium ${tab === tabKey ? "bg-[var(--primary)]/10 text-[var(--primary)] font-bold" : "text-slate-500 hover:bg-slate-100"}`}>
              {tabKey === "all" ? t("management.filterAll") : t(`status.${tabKey}`, { ns: "common" })}
            </button>
          ))}
          <button
            onClick={() => setOverrideOnly((v) => !v)}
            className={`px-4 py-2 rounded-lg text-sm font-medium ml-auto ${overrideOnly ? "bg-orange-100 text-orange-700 font-bold" : "text-slate-500 hover:bg-slate-100"}`}
          >
            {t("management.overrideOnly", "只看改价单")}
          </button>
        </div>

        {todayFilter && (
          <div className="flex items-center gap-3 bg-[var(--primary)]/5 border border-[var(--primary)]/20 rounded-lg px-4 py-2 text-sm">
            <span className="font-medium text-[var(--on-surface)]">
              {t(`management.today.${todayFilter}`)} · {displayData.length}
            </span>
            <button onClick={() => navigate("/admin/rental-management")} className="ml-auto text-xs font-medium text-[var(--primary)] hover:underline">
              {t("management.today.clear")}
            </button>
          </div>
        )}

        {rollingOperationsEnabled && rollingFilter && (
          <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900">
            <CalendarClock size={16} className="text-blue-700" aria-hidden="true" />
            <span className="font-medium">{t("rolling.list.filterSummary", { count: displayData.length })}</span>
            <button onClick={() => navigate("/admin/rental-management")} className="ml-auto text-xs font-bold text-blue-700 hover:underline">
              {t("management.today.clear")}
            </button>
          </div>
        )}

        <div>
          <DataTable
            data={displayData}
            columns={columns}
            isLoading={isLoading}
            onRowClick={(row) => setSelectedId(row.rental_requests.id)}
            emptyMessage={t("management.noRentals")}
            searchPlaceholder={t("management.searchRentals")}
            selectable={batchEnabled}
            selectedKeys={batchEnabled ? selectedKeys : undefined}
            onSelectionChange={batchEnabled ? setSelectedKeys : undefined}
            rowKey={(row) => row.rental_requests.id}
            getSearchText={getRentalSearchText}
          />
          {batchEnabled && (
            <BatchActionBar
              selectedCount={selectedKeys.size}
              onClear={() => setSelectedKeys(new Set())}
            >
              <button
                type="button"
                onClick={() => {
                  const ids = Array.from(selectedKeys).map(Number);
                  batchUpdateStatus.mutate({ ids, status: "approved" });
                }}
                disabled={batchUpdateStatus.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                <CheckCircle size={14} aria-hidden="true" />
                {t("management.approveAll")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const ids = Array.from(selectedKeys).map(Number);
                  if (!confirm(t("management.cancelAllConfirm", { count: ids.length }))) return;
                  batchUpdateStatus.mutate({ ids, status: "cancelled" });
                }}
                disabled={batchUpdateStatus.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                <XCircle size={14} aria-hidden="true" />
                {t("management.cancelAll")}
              </button>
            </BatchActionBar>
          )}
        </div>
      </div>

      {/* Create Order Modal */}
      {createOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setCreateOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-3xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{t("management.createOrder")}</h2>
              <button onClick={() => setCreateOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label={t("close", { ns: "common" })}><X size={20} /></button>
            </div>

            <div className="space-y-4">
              {/* 0. Credit (挂账) order toggle — feature-gated */}
              {creditOrdersEnabled && (
                <label className="flex items-center gap-2 cursor-pointer bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  <input
                    type="checkbox"
                    checked={orderForm.isCreditOrder}
                    onChange={(e) => updateField({ isCreditOrder: e.target.checked, ...(e.target.checked ? { endDate: "" } : {}) })}
                    className="h-4 w-4"
                  />
                  <span className="text-sm font-medium text-slate-700">{t("management.creditOrder", "Credit order (挂账)")}</span>
                </label>
              )}

              {/* 1. Rental Period (dates first) */}
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">{t("management.rentalPeriod")} <span className="text-xs text-slate-400 font-normal ml-1">— {t("management.selectDatesFirst", "Select dates first to check equipment availability")}</span></p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.start")} *</label>
                    <input type="date" value={orderForm.startDate} onChange={(e) => updateField({ startDate: e.target.value, rentalFleetId: "" })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                  </div>
                  {orderForm.isCreditOrder ? (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("management.end")}</label>
                      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-700">
                        {t("management.creditOrderHint", "Open-ended — amount is set at bin-swap / close-out.")}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("management.end")} *</label>
                      <input type="date" value={orderForm.endDate} onChange={(e) => updateField({ endDate: e.target.value, rentalFleetId: "" })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                    </div>
                  )}
                </div>
              </div>

              {/* 2. Equipment (with availability status) */}
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">{t("management.equipment")}</p>
                {!datesSelected ? (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
                    {t("management.selectDatesForAvailability", "Please select valid rental dates above to check equipment availability.")}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Equipment Category Selector — one entry per category, even
                        when it spans several brand-models (auto-assigns any unit). */}
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("management.equipmentModel")}</label>
                      <select
                        value={orderForm.equipmentCategory}
                        onChange={(e) => {
                          const cat = e.target.value;
                          updateField({
                            equipmentCategory: cat,
                            equipmentModelId: cat ? representativeModelId(cat) : "",
                            rentalFleetId: "",
                            equipmentDescription: cat,
                          });
                        }}
                        className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full"
                      >
                        <option value="">{t("management.selectByCategoryPlaceholder")}</option>
                        {categoryOptions.map(c => (
                          <option key={c.category} value={c.category}>
                            {c.category} {t("management.availableCount", { available: c.available, total: c.total })}
                          </option>
                        ))}
                      </select>
                      {orderForm.equipmentCategory && (() => {
                        const c = categoryOptions.find(x => x.category === orderForm.equipmentCategory);
                        if (!c) return null;
                        return (
                        <p className={`text-xs mt-1 ${c.available > 0 ? "text-green-600" : "text-red-600"}`}>
                          {t("management.unitsAvailable", { available: c.available, total: c.total })}
                          {orderForm.startDate && orderForm.endDate ? t("management.forSelectedDates") : ""}
                        </p>
                        );
                      })()}
                    </div>
                    {/* Specific Asset with availability indicators */}
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("management.specificAsset")}</label>
                      <FleetCombobox
                        items={fleetItemsForPrimary}
                        value={orderForm.rentalFleetId}
                        onChange={(val) => updateField({ rentalFleetId: val })}
                        placeholder={orderForm.equipmentCategory ? t("management.autoAssignFromModel") : t("management.selectEquipment")}
                        searchPlaceholder={t("management.searchEquipmentPlaceholder", "Search by S/N, asset #, brand or model...")}
                        noResultsLabel={t("management.noMatchingEquipment", "No matching equipment")}
                        labels={{
                          available: t("management.equipAvailable", "Available"),
                          rented: t("management.equipRented", "Rented"),
                          maintenance: t("management.equipMaintenance", "Maintenance"),
                          until: t("management.equipUntil", "until"),
                          blockedWorkOrder: t("management.equipBlockedWorkOrder"),
                          blockedReturn: t("management.equipBlockedReturn"),
                        }}
                      />
                      {orderForm.equipmentCategory && !orderForm.rentalFleetId && (
                        <p className="text-xs text-slate-400 mt-1">{t("management.assetAutoAssignHint")}</p>
                      )}
                      {/* Availability summary (scoped to the selected model) */}
                      {fleetItemsForPrimary.length > 0 && (
                        <p className="text-xs mt-1 text-slate-500">
                          <span className="text-green-600 font-medium">{fleetItemsForPrimary.filter(f => f.availabilityStatus === 'available').length}</span> {t("management.equipAvailableSuffix", "available")}
                          {fleetItemsForPrimary.some(f => f.availabilityStatus === 'rented') && (
                            <> · <span className="text-red-500 font-medium">{fleetItemsForPrimary.filter(f => f.availabilityStatus === 'rented').length}</span> {t("management.equipRentedSuffix", "rented")}</>
                          )}
                          {fleetItemsForPrimary.some(f => f.availabilityStatus === 'blocked') && (
                            <> · <span className="text-amber-600 font-medium">{fleetItemsForPrimary.filter(f => f.availabilityStatus === 'blocked').length}</span> {t("management.equipBlockedSuffix")}</>
                          )}
                          {fleetItemsForPrimary.some(f => f.availabilityStatus === 'maintenance') && (
                            <> · <span className="text-amber-500 font-medium">{fleetItemsForPrimary.filter(f => f.availabilityStatus === 'maintenance').length}</span> {t("management.equipMaintenanceSuffix", "maintenance")}</>
                          )}
                          {" "}{t("management.equipOfTotal", { total: fleetItemsForPrimary.length, defaultValue: `of ${fleetItemsForPrimary.length} total` })}
                        </p>
                      )}
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs text-slate-500 mb-1">{t("management.orDescription")}</label>
                      <input value={orderForm.equipmentDescription} onChange={(e) => setOrderForm({ ...orderForm, equipmentDescription: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" placeholder={t("management.equipDescPlaceholder")} />
                    </div>
                  </div>
                )}
                {/* Additional equipment — one order, multiple units. Each extra
                    line auto-assigns from the model's available units; pricing is
                    computed for all units together (see preview below). */}
                {datesSelected && (
                  <div className="mt-3 border-t border-slate-200 pt-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-medium text-slate-600">{t("management.additionalEquipment")}</p>
                      <button type="button" onClick={addExtraItem} className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-600 whitespace-nowrap">
                        <Plus size={12} className="inline -mt-0.5 mr-0.5" />{t("management.addEquipment")}
                      </button>
                    </div>
                    {orderForm.extraItems.map((it, idx) => {
                      const customPeriod = !!(it.startDate || it.endDate);
                      const lineFleetItems = it.equipmentCategory
                        ? sortedFleetItems.filter((f) => f.category === it.equipmentCategory)
                        : [];
                      const hasSpecificAsset = !!it.rentalFleetId;
                      return (
                      <div key={idx} className="mb-2 rounded-lg border border-slate-200 p-2 space-y-2">
                        <div className="flex gap-2 items-center">
                          <select
                            value={it.equipmentCategory}
                            onChange={(e) => {
                              const cat = e.target.value;
                              updateExtraItem(idx, { equipmentCategory: cat, equipmentModelId: cat ? representativeModelId(cat) : "", rentalFleetId: "" });
                            }}
                            className="flex-1 bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
                          >
                            <option value="">{t("management.selectByCategoryPlaceholder")}</option>
                            {categoryOptions.map((c) => (
                              <option key={c.category} value={c.category}>
                                {c.category} {t("management.availableCount", { available: c.available, total: c.total })}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min={1}
                            value={hasSpecificAsset ? 1 : it.quantity}
                            disabled={hasSpecificAsset}
                            title={hasSpecificAsset ? t("management.qtyLockedToAsset") : undefined}
                            onChange={(e) => updateExtraItem(idx, { quantity: Math.max(1, parseInt(e.target.value) || 1) })}
                            className="w-16 bg-slate-100 border border-slate-300 rounded-lg px-2 py-2 text-slate-900 text-sm text-center disabled:opacity-50"
                          />
                          <button type="button" onClick={() => removeExtraItem(idx)} className="shrink-0 text-slate-400 hover:text-[var(--primary)] p-1" aria-label={t("common:delete", "Delete")}>
                            <X size={16} />
                          </button>
                        </div>
                        {/* Specific asset for this line (scoped to the chosen category) — same as
                            the main order. Blank = auto-assign from the category pool. */}
                        {it.equipmentCategory && (
                          <FleetCombobox
                            items={lineFleetItems}
                            value={it.rentalFleetId}
                            onChange={(val) => updateExtraItem(idx, { rentalFleetId: val, ...(val ? { quantity: 1 } : {}) })}
                            placeholder={t("management.autoAssignFromModel")}
                            searchPlaceholder={t("management.searchEquipmentPlaceholder", "Search by S/N, asset #, brand or model...")}
                            noResultsLabel={t("management.noMatchingEquipment", "No matching equipment")}
                            labels={{
                              available: t("management.equipAvailable", "Available"),
                              rented: t("management.equipRented", "Rented"),
                              maintenance: t("management.equipMaintenance", "Maintenance"),
                              until: t("management.equipUntil", "until"),
                              blockedWorkOrder: t("management.equipBlockedWorkOrder"),
                              blockedReturn: t("management.equipBlockedReturn"),
                            }}
                          />
                        )}
                        {/* Per-line rental period — leave blank to use the order dates above. */}
                        <div className="flex items-center gap-2 pl-0.5">
                          <span className="text-[11px] text-slate-400 shrink-0">{t("management.lineDatesLabel")}</span>
                          <input type="date" value={it.startDate} onChange={(e) => updateExtraItem(idx, { startDate: e.target.value })} className="bg-slate-50 border border-slate-300 rounded px-2 py-1 text-xs text-slate-900" />
                          <span className="text-slate-400 text-xs">→</span>
                          <input type="date" value={it.endDate} onChange={(e) => updateExtraItem(idx, { endDate: e.target.value })} className="bg-slate-50 border border-slate-300 rounded px-2 py-1 text-xs text-slate-900" />
                          {customPeriod && (
                            <button type="button" onClick={() => updateExtraItem(idx, { startDate: "", endDate: "" })} className="text-[11px] text-slate-400 hover:text-[var(--primary)]">{t("management.lineDatesReset")}</button>
                          )}
                        </div>
                      </div>
                      );
                    })}
                    {isMultiItem && (
                      <p className="text-xs text-slate-400">{t("management.multiUnitHint")}</p>
                    )}
                  </div>
                )}
              </div>

              {/* 3. Customer */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-slate-700">{t("management.customer")}</p>
                  <button
                    type="button"
                    onClick={resetCustomerFields}
                    className="text-xs text-slate-500 hover:text-[var(--primary)] underline-offset-2 hover:underline"
                  >
                    {t("management.resetCustomer")}
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="relative">
                    <label className="block text-xs text-slate-500 mb-1">{t("management.customerName")} *</label>
                    <input
                      value={orderForm.customerName}
                      onChange={(e) => { setOrderForm({ ...orderForm, customerName: e.target.value, customerId: "", customerDiscountPercent: "", customerCreditLimit: "" }); setNameOpen(true); }}
                      onFocus={() => setNameOpen(true)}
                      onBlur={() => setTimeout(() => setNameOpen(false), 150)}
                      autoComplete="off"
                      className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full"
                    />
                    {nameOpen && nameMatches.length > 0 && (
                      <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-auto">
                        {nameMatches.map((m) => (
                          <li key={m.id}>
                            <button
                              type="button"
                              onMouseDown={(e) => { e.preventDefault(); pickCustomerMatch(m); }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-slate-900 font-medium truncate">{m.name}</span>
                                {m.isBlacklisted && <span className="text-[10px] uppercase tracking-wide text-[var(--primary)] bg-red-50 rounded px-1.5 py-0.5">{t("management.blacklistedTag")}</span>}
                              </div>
                              <div className="text-xs text-slate-500 truncate">
                                {m.phone || "—"}{m.company ? ` · ${m.company}` : ""}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.customerEmail")}</label>
                    <input type="email" value={orderForm.customerEmail} onChange={(e) => setOrderForm({ ...orderForm, customerEmail: e.target.value, customerId: "", customerDiscountPercent: "", customerCreditLimit: "" })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                  </div>
                  <div className="relative">
                    <label className="block text-xs text-slate-500 mb-1">{t("management.customerPhone")} *</label>
                    <input
                      value={orderForm.customerPhone}
                      onChange={(e) => { setOrderForm({ ...orderForm, customerPhone: e.target.value, customerId: "", customerDiscountPercent: "", customerCreditLimit: "" }); setPhoneOpen(true); }}
                      onFocus={() => setPhoneOpen(true)}
                      onBlur={() => setTimeout(() => setPhoneOpen(false), 150)}
                      autoComplete="off"
                      className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full"
                    />
                    {phoneOpen && phoneMatches.length > 0 && (
                      <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-auto">
                        {phoneMatches.map((m) => (
                          <li key={m.id}>
                            <button
                              type="button"
                              onMouseDown={(e) => { e.preventDefault(); pickCustomerMatch(m); }}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-slate-900 font-medium truncate">{m.name}</span>
                                {m.isBlacklisted && <span className="text-[10px] uppercase tracking-wide text-[var(--primary)] bg-red-50 rounded px-1.5 py-0.5">{t("management.blacklistedTag")}</span>}
                              </div>
                              <div className="text-xs text-slate-500 truncate">
                                {m.phone || "—"}{m.company ? ` · ${m.company}` : ""}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.customerCompany")}</label>
                    <input value={orderForm.customerCompany} onChange={(e) => setOrderForm({ ...orderForm, customerCompany: e.target.value, customerId: "", customerDiscountPercent: "", customerCreditLimit: "" })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.financialOrderNumber")}</label>
                    <input value={orderForm.financialOrderNumber} onChange={(e) => setOrderForm({ ...orderForm, financialOrderNumber: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" placeholder="SOT12269 / SOR00039" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.cardLast4")}</label>
                    <input value={orderForm.cardLast4} maxLength={4} inputMode="numeric" onChange={(e) => setOrderForm({ ...orderForm, cardLast4: e.target.value.replace(/\D/g, "").slice(0, 4) })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" placeholder="1234" />
                  </div>
                </div>
              </div>

              {/* Delivery */}
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">{t("management.delivery")}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.deliveryMethod")}</label>
                    <select value={orderForm.deliveryMethod} onChange={(e) => updateField({ deliveryMethod: e.target.value as typeof emptyOrderForm.deliveryMethod })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full">
                      <option value="pickup">{t("management.pickupOption")}</option>
                      <option value="delivery">{t("management.oneWayDeliveryOption")}</option>
                      <option value="delivery_and_return">{t("management.deliveryReturnOption")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.deliveryAddress")}</label>
                    <input value={orderForm.deliveryAddress} onChange={(e) => updateField({ deliveryAddress: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.province")}</label>
                    <ProvinceSelect value={orderForm.deliveryProvince} onChange={(v) => updateField({ deliveryProvince: v })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.insuranceType")}</label>
                    <select value={orderForm.insuranceType} onChange={(e) => updateField({ insuranceType: e.target.value as typeof orderForm.insuranceType, ...(e.target.value !== "none" ? { insuranceDocsReceived: false } : {}) })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full">
                      <option value="basic">{t("management.insuranceBasic")}</option>
                      <option value="full">{t("management.insuranceFull")}</option>
                      <option value="none">{t("management.insuranceNone")}</option>
                    </select>
                    {/* Waiving insurance requires a customer-provided certificate on file. */}
                    {orderForm.insuranceType === "none" && (
                      <label className="mt-1.5 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 cursor-pointer">
                        <input type="checkbox" checked={orderForm.insuranceDocsReceived} onChange={(e) => updateField({ insuranceDocsReceived: e.target.checked })} className="mt-0.5 rounded border-amber-300" />
                        <span>{t("management.insuranceWaiverConfirm")}</span>
                      </label>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.scheduledDeliveryTime")}</label>
                    <select value={orderForm.scheduledDeliveryTime} onChange={(e) => updateField({ scheduledDeliveryTime: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full">
                      {TIME_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.labelKey ? translateDynamic(t, opt.labelKey) : opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.scheduledPickupTime")}</label>
                    <select value={orderForm.scheduledPickupTime} onChange={(e) => updateField({ scheduledPickupTime: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full">
                      {TIME_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.labelKey ? translateDynamic(t, opt.labelKey) : opt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Pricing — hidden for credit orders (amount is TBD until close-out) */}
              {orderForm.isCreditOrder ? (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-700">
                  {t("management.creditOrderHint", "Open-ended — amount is set at bin-swap / close-out.")}
                </div>
              ) : (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-sm font-medium text-slate-700">{t("management.pricing")}</p>
                  {customerDiscountPct > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                      {t("management.customerDiscountBadge", { pct: customerDiscountPct })}
                    </span>
                  )}
                </div>
                {/* Price match / manual override: turning this on suppresses the
                    auto rate × days recalc so admin-entered prices stick. */}
                <div className="mb-3">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={orderForm.priceMatchEnabled} onChange={(e) => setOrderForm({ ...orderForm, priceMatchEnabled: e.target.checked })} className="rounded border-slate-300" />
                    {t("management.priceMatchToggle")}
                  </label>
                  {orderForm.priceMatchEnabled && (
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3 bg-amber-50/60 border border-amber-200 rounded-lg p-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("management.priceMatchCompetitor")}</label>
                        <input value={orderForm.priceMatchCompetitor} onChange={(e) => setOrderForm({ ...orderForm, priceMatchCompetitor: e.target.value })} className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" placeholder={t("management.priceMatchCompetitorPlaceholder")} />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("management.priceMatchAmount")}</label>
                        <input type="number" step="0.01" value={orderForm.priceMatchAmount} onChange={(e) => setOrderForm({ ...orderForm, priceMatchAmount: e.target.value })} className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("management.priceMatchNote")} <span className="text-[var(--primary)]">*</span></label>
                        <input value={orderForm.priceMatchNote} onChange={(e) => setOrderForm({ ...orderForm, priceMatchNote: e.target.value })} className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" placeholder={t("management.priceMatchNotePlaceholder")} />
                      </div>
                      <p className="sm:col-span-3 text-xs text-amber-700">{t("management.priceMatchHint")}</p>
                    </div>
                  )}
                </div>
                {/* Multi-unit orders price all units together via the shared quote
                    engine; show that as a read-only preview. Price-match falls back
                    to the editable grid so the admin can override. */}
                {!orderForm.priceMatchEnabled && isMultiItem ? (
                  <div className="space-y-2">
                  {/* Per-line itemization (like an invoice) — each unit's own subtotal. */}
                  {multiQuote?.perLine && multiItems && (
                    <div className="border border-slate-200 rounded-lg overflow-hidden">
                      {multiQuote.perLine.map((ln, i) => {
                        const mid = multiItems[i]?.equipmentModelId;
                        const m = (modelsData || []).find((x) => x.id === mid);
                        const name = m ? (m.displayName || `${m.brand} ${m.model}`) : t("management.equipment");
                        return (
                          <div key={i} className="flex justify-between items-center gap-2 px-3 py-1.5 text-xs border-b border-slate-100 last:border-b-0 bg-white">
                            <span className="text-slate-700 truncate">{name} × {ln.quantity} · {ln.days}{t("management.daysShort", "d")}</span>
                            <span className="text-slate-900 font-medium shrink-0">{formatCurrency(ln.lineSubtotal)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div><p className="text-xs text-slate-500">{t("management.rentalFee")}</p><p className="text-sm font-medium text-slate-900">{formatCurrency(multiQuote?.rentalFee ?? 0)}</p></div>
                    <div><p className="text-xs text-slate-500">{t("management.freight")}</p><p className="text-sm font-medium text-slate-900">{formatCurrency(multiQuote?.freightCost ?? 0)}</p></div>
                    <div><p className="text-xs text-slate-500">{t("management.insurance")}</p><p className="text-sm font-medium text-slate-900">{formatCurrency(multiQuote?.insuranceCost ?? 0)}</p></div>
                    <div><p className="text-xs text-slate-500">{t("management.tax")}</p><p className="text-sm font-medium text-slate-900">{formatCurrency(multiQuote?.taxAmount ?? 0)}</p></div>
                    <div><p className="text-xs text-slate-500">{t("management.deposit")}</p><p className="text-sm font-medium text-slate-900">{formatCurrency(multiQuote?.depositAmount ?? 0)}</p></div>
                    <div className="bg-[var(--primary)]/10 rounded-lg p-2 -m-1"><p className="text-xs text-[var(--primary)]">{t("management.autoTotal")}</p><p className="text-lg font-bold text-[var(--primary)]">{formatCurrency(multiQuote?.totalAmount ?? 0)}</p></div>
                  </div>
                  </div>
                ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      {t("management.rentalFee")}
                      {autoRentalPrice && !orderForm.priceMatchEnabled && <span className="ml-1 text-green-600">({t("management.autoCalculated")})</span>}
                    </label>
                    <input type="number" step="0.01" value={orderForm.rentalFee} disabled={!orderForm.priceMatchEnabled} onChange={(e) => setOrderForm({ ...orderForm, rentalFee: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full disabled:bg-slate-200/70 disabled:text-slate-500 disabled:cursor-not-allowed" />
                    {autoRentalPrice && (
                      <p className="text-xs text-slate-400 mt-1">{autoRentalPrice.days} {t("management.days")} = {autoRentalPrice.breakdown}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      {t("management.freight")}
                      {autoFreightCost > 0 && <span className="ml-1 text-green-600">({t("management.autoCalculated")})</span>}
                    </label>
                    <input type="number" step="0.01" value={orderForm.freightCost} disabled={!orderForm.priceMatchEnabled} onChange={(e) => setOrderForm({ ...orderForm, freightCost: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full disabled:bg-slate-200/70 disabled:text-slate-500 disabled:cursor-not-allowed" />
                    {shippingSmartData?.needsManual && (
                      <p className="text-xs mt-1 text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">⚠ {t("management.freightManualOver75")}</p>
                    )}
                    {shippingData && (
                      <div className="text-xs mt-1 space-y-0.5">
                        {shippingSmartData?.source === "distance_calculated" && shippingSmartData.distanceKm != null && (
                          <>
                            <p className="text-blue-600 font-medium">{t("management.shippingDistanceTier", { km: shippingSmartData.distanceKm, tier: shippingSmartData.costPerTrip, trips: shippingSmartData.trips })}</p>
                            <p className="text-slate-400">{t("management.shippingFrom", { address: shippingSmartData.originAddress })}</p>
                          </>
                        )}
                        {shippingSmartData?.source === "min_tier_fallback" && (
                          <p className="text-amber-600">⚠ {t("management.shippingMinTierFallback")}</p>
                        )}
                        {!hasDeliveryAddress && shippingFallbackData && (
                          <p className="text-slate-400">{t("management.shippingTierNoAddress", { tier: shippingFallbackData.tierName })}</p>
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      {t("management.insurance")}
                      {autoInsuranceCost > 0 && <span className="ml-1 text-green-600">({t("management.autoCalculated")})</span>}
                    </label>
                    <input type="number" step="0.01" value={orderForm.insuranceCost} disabled={!orderForm.priceMatchEnabled} onChange={(e) => setOrderForm({ ...orderForm, insuranceCost: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full disabled:bg-slate-200/70 disabled:text-slate-500 disabled:cursor-not-allowed" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      {t("management.tax")}
                      {autoTax > 0 && <span className="ml-1 text-green-600">({t("management.autoCalculated")})</span>}
                    </label>
                    <input type="number" step="0.01" value={orderForm.taxAmount} disabled={!orderForm.priceMatchEnabled} onChange={(e) => setOrderForm({ ...orderForm, taxAmount: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full disabled:bg-slate-200/70 disabled:text-slate-500 disabled:cursor-not-allowed" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">
                      {t("management.deposit")}
                      {customerCreditLimit > 0
                        ? <span className="ml-1 text-emerald-600">({t("management.depositWaivedAccount")})</span>
                        : autoDeposit > 0 && <span className="ml-1 text-green-600">({t("management.autoCalculated")})</span>}
                    </label>
                    <input type="number" step="0.01" value={orderForm.depositAmount} disabled={!orderForm.priceMatchEnabled} onChange={(e) => setOrderForm({ ...orderForm, depositAmount: e.target.value })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full disabled:bg-slate-200/70 disabled:text-slate-500 disabled:cursor-not-allowed" />
                  </div>
                  <div className="bg-[var(--primary)]/10 rounded-lg p-2 flex flex-col justify-center">
                    <label className="block text-xs text-[var(--primary)] mb-1">{t("management.autoTotal")}</label>
                    <div className="text-lg font-bold text-[var(--primary)]">{formatCurrency(calcOrderTotal())}</div>
                  </div>
                </div>
                )}
              </div>
              )}

              {/* Project & Notes */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("management.project")}</label>
                  <div className="flex gap-2">
                    <select
                      value={orderForm.projectId}
                      onChange={(e) => {
                        const pid = e.target.value;
                        setOrderForm({ ...orderForm, projectId: pid });
                        if (pid) {
                          const proj = (projectsData || []).find(p => String(p.projects.id) === pid);
                          if (proj?.projects.siteAddress && !orderForm.deliveryAddress) {
                            setOrderForm(prev => ({ ...prev, projectId: pid, deliveryAddress: proj.projects.siteAddress || "" }));
                          }
                        }
                      }}
                      className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full"
                    >
                      <option value="">{t("management.noProject")}</option>
                      {(projectsData || []).map(p => (
                        <option key={p.projects.id} value={p.projects.id}>{p.projects.name} {p.projects.poNumber ? `(PO: ${p.projects.poNumber})` : ""}</option>
                      ))}
                    </select>
                    <button type="button" onClick={() => setNewProjectOpen(true)} className="shrink-0 px-2 py-1 text-xs border border-slate-300 rounded-lg hover:bg-slate-50 text-slate-600 whitespace-nowrap">
                      <Plus size={12} className="inline -mt-0.5 mr-0.5" />{t("management.newProject")}
                    </button>
                  </div>
                  {/* Inline project creation form */}
                  {newProjectOpen && (
                    <div className="mt-2 p-3 border border-blue-200 bg-blue-50/50 rounded-lg space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-slate-700">{t("management.newProject")}</p>
                        <button type="button" onClick={() => setNewProjectOpen(false)} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
                      </div>
                      <input placeholder={t("management.projectName")} value={newProjectForm.name} onChange={(e) => setNewProjectForm({ ...newProjectForm, name: e.target.value })} className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
                      <div className="grid grid-cols-2 gap-2">
                        <input placeholder={t("management.placeholderPoNumber")} value={newProjectForm.poNumber} onChange={(e) => setNewProjectForm({ ...newProjectForm, poNumber: e.target.value })} className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
                        <input placeholder={t("management.contactName")} value={newProjectForm.contactName} onChange={(e) => setNewProjectForm({ ...newProjectForm, contactName: e.target.value })} className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
                      </div>
                      <input placeholder={t("management.siteAddress")} value={newProjectForm.siteAddress} onChange={(e) => setNewProjectForm({ ...newProjectForm, siteAddress: e.target.value })} className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-sm" />
                      <button
                        type="button"
                        disabled={!newProjectForm.name.trim() || !orderForm.customerName.trim() || createProjectMut.isPending || autoCreateCustomerMut.isPending}
                        onClick={() => {
                          // Find customer by name from customers list (more reliable than rental data)
                          const nameLower = orderForm.customerName.trim().toLowerCase();
                          const existingCust = (customersData || []).find((c) => c.name.toLowerCase() === nameLower);

                          if (existingCust) {
                            createProjectMut.mutate({
                              customerId: existingCust.id,
                              name: newProjectForm.name,
                              poNumber: newProjectForm.poNumber || undefined,
                              siteAddress: newProjectForm.siteAddress || undefined,
                              contactName: newProjectForm.contactName || undefined,
                              contactPhone: newProjectForm.contactPhone || undefined,
                              province: orderForm.deliveryProvince || undefined,
                            });
                          } else {
                            // Auto-create a minimal customer record first, then create project
                            autoCreateCustomerMut.mutate({
                              name: orderForm.customerName.trim(),
                              email: orderForm.customerEmail || undefined,
                              phone: orderForm.customerPhone || undefined,
                              company: orderForm.customerCompany || undefined,
                            }, {
                              onSuccess: (newCust) => {
                                createProjectMut.mutate({
                                  customerId: newCust.id,
                                  name: newProjectForm.name,
                                  poNumber: newProjectForm.poNumber || undefined,
                                  siteAddress: newProjectForm.siteAddress || undefined,
                                  contactName: newProjectForm.contactName || undefined,
                                  contactPhone: newProjectForm.contactPhone || undefined,
                                  province: orderForm.deliveryProvince || undefined,
                                });
                              },
                              onError: () => toast.error(t("management.customerCreateFailed")),
                            });
                          }
                        }}
                        className="btn-primary text-xs w-full disabled:opacity-50"
                      >
                        {createProjectMut.isPending ? t("common:saving") : t("management.createProject")}
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("management.referralCode")}</label>
                  <input value={orderForm.referralCode} onChange={(e) => setOrderForm({ ...orderForm, referralCode: e.target.value.toUpperCase() })} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" placeholder={t("management.referralCodePlaceholder")} />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">{t("management.projectDescription")}</label>
                  <textarea value={orderForm.projectDescription} onChange={(e) => setOrderForm({ ...orderForm, projectDescription: e.target.value })} rows={2} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs text-slate-500 mb-1">{t("management.adminNotes")}</label>
                  <textarea value={orderForm.adminNotes} onChange={(e) => setOrderForm({ ...orderForm, adminNotes: e.target.value })} rows={2} className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm w-full" />
                </div>
              </div>
            </div>

            {/* Conflict Warning Banner — shown when flag is on and specific asset has a conflict */}
            {conflictWarningEnabled && hasConflict && selectedFleet && (
              <ConflictWarningBanner
                assetLabel={`${selectedFleet.brand} ${selectedFleet.model}`}
                startDate={orderForm.startDate}
                endDate={orderForm.endDate}
                conflictingRentals={conflictingRentals}
                alternatives={conflictAlternatives}
                onSelectAlternative={(fleetId) => updateField({ rentalFleetId: String(fleetId) })}
              />
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setCreateOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleCreateOrder} disabled={adminCreateMut.isPending} className="btn-primary">
                {adminCreateMut.isPending ? t("management.creating") : t("management.createOrder")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credit Block Dialog */}
      {creditFlagEnabled && creditBlock && (
        <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-red-200 w-full max-w-md p-6 space-y-4">
            <div className="flex items-start gap-3">
              <ShieldAlert size={24} className="text-red-500 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-red-700 text-base">{t("rentalMgmt.orderBlocked", { ns: "admin" })}</div>
                <div className="text-sm text-red-600 mt-1">{creditBlock.message}</div>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setCreditBlock(null)}
                className="btn-secondary"
              >
                {t("cancel", { ns: "common" })}
              </button>
              {isSuperAdmin && creditBlock.pendingPayload && (
                <button
                  onClick={() => {
                    if (creditBlock.pendingPayload) {
                      adminCreateMut.mutate({ ...creditBlock.pendingPayload, creditOverride: true });
                    }
                  }}
                  disabled={adminCreateMut.isPending}
                  className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  {t("management.overrideAndCreate")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Detail Dialog */}
      {selectedId && (
        <RentalDetailDialog
          rentalId={selectedId}
          onClose={closeRentalDetail}
        />
      )}
    </DashboardLayout>
  );
}
