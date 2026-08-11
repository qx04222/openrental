import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { directRentalStatusOptions, rentalStatusOptions } from "@/lib/rentalStatusActions";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { copyFinanceRowTSV, copyWeChatDispatch } from "@/lib/financeRow";
import PhotoLightbox from "@/components/PhotoLightbox";
import { rentalStatusColors as statusColors } from "@/lib/statusColors";
import { derivePaymentState } from "@shared/paymentStatus";
import { PAYMENT_METHODS, paymentMethodI18nKey, type PaymentMethod } from "@shared/paymentMethod";
import { invalidatePaymentCaches } from "@/lib/paymentCache";
import PaymentBadge from "@/components/PaymentBadge";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { useAuth } from "@/hooks/useAuth";
import { Calendar, ArrowRight, Pencil, Plus as PlusIcon, Truck as TruckIcon, Copy as CopyIcon, RefreshCw, PenLine, X as XIcon, RotateCcw, Camera, MessageCircle } from "lucide-react";
import InspectionDetailDialog from "./InspectionDetailDialog";
import { useSignaturePad } from "@/hooks/useSignaturePad";
import { useFormatCalendarDate, useAppTimezone, formatCalendarDate, formatCalendarDateISO } from "@/lib/dateUtils";
import { EXTRA_CHARGE_REASONS, EXTRA_CHARGE_LABELS } from "@shared/extraCharges";
import { EDIT_REASONS, type EditReason } from "@shared/editReasons";
import { overrideFieldLines } from "./overrideSummary";
import { translateDynamic } from "@/lib/i18nHelpers";
import AssetProgressPanel, { type AssetProgressItem } from "@/components/AssetProgressPanel";
import { areAssetsReadyForAdminClose } from "@/lib/assetProgressPresentation";
import RollingRentalOperations from "./RollingRentalOperations";
import { serverErrorText } from "@/lib/serverError";
import { canUseModulePermission } from "@/lib/modulePermissions";
import { auditActionKey, auditFallbackLabel } from "@/lib/auditPresentation";
import { getGlobalSearchPath } from "@/lib/adminSearchNavigation";


// damage_claims lifecycle statuses (pending→estimated→accepted→invoiced, or disputed).
// Bilingual like EXTRA_CHARGE_LABELS so the English UI never leaks Chinese.
const CLAIM_STATUS_LABELS: Record<string, { en: string; zh: string }> = {
  pending: { en: "Pending", zh: "待处理" },
  estimated: { en: "Estimated", zh: "已估价" },
  accepted: { en: "Accepted", zh: "已接受" },
  invoiced: { en: "Invoiced", zh: "已开票" },
  disputed: { en: "Disputed", zh: "有异议" },
};

// Parse audit metadata for the reason / invoice number we stamp on edits.
function parseAuditMeta(metadata: string | null | undefined): { reason?: string; invoiceNumber?: string } {
  if (!metadata) return {};
  try {
    const m = JSON.parse(metadata);
    return { reason: typeof m.reason === "string" ? m.reason : undefined, invoiceNumber: typeof m.invoiceNumber === "string" ? m.invoiceNumber : undefined };
  } catch { return {}; }
}

// Compact before→after table for one audit entry's `{field:{old,new}}` changes.
function ChangeDiff({ changes }: { changes: string | null | undefined }) {
  if (!changes) return null;
  let parsed: Record<string, { old?: unknown; new?: unknown }>;
  try { parsed = JSON.parse(changes); } catch { return null; }
  const keys = Object.keys(parsed || {});
  if (keys.length === 0) return null;
  const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
  return (
    <table className="w-full text-xs border-collapse">
      <tbody>
        {keys.map((f) => (
          <tr key={f} className="border-t border-slate-100 align-top">
            <td className="py-1 pr-2 font-mono text-slate-600 w-32 break-all">{f}</td>
            <td className="py-1 pr-2 font-mono text-red-700 line-through break-all">{fmt(parsed[f]?.old)}</td>
            <td className="py-1 pr-1 text-slate-300">→</td>
            <td className="py-1 font-mono text-green-700 break-all">{fmt(parsed[f]?.new)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function RentalDetailDialog({ rentalId, onClose }: { rentalId: number; onClose: () => void }) {
  const { t, i18n } = useTranslation(["rental", "common", "dispatch"]);
  // Payment-method labels live in the admin bundle (shared with the invoice page).
  const { t: tAdmin } = useTranslation("admin");
  const lang: "en" | "zh" = i18n.language?.startsWith("zh") ? "zh" : "en";
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const canDuplicate = useFeatureFlag("rental_duplicate");
  const dispatchWorkflowEnabled = useFeatureFlag("dispatch_workflow");
  const [activeTab, setActiveTab] = useState<"overview" | "pricing" | "contract" | "dispatch" | "inspections" | "history">("overview");
  const showLateFee = useFeatureFlag("late_fee_auto");
  const { data: assetProgress, isLoading: assetProgressLoading } = trpc.rentalAssetProgress.byRental.useQuery(
    { rentalId },
    { refetchInterval: 10_000, refetchOnWindowFocus: true, refetchOnReconnect: true },
  );

  useEffect(() => {
    if (!dispatchWorkflowEnabled && activeTab === "dispatch") setActiveTab("overview");
  }, [dispatchWorkflowEnabled, activeTab]);

  // Core data — always fetched
  const { data } = trpc.rentals.getById.useQuery({ id: rentalId });
  const { data: lineItems } = trpc.rentals.getLineItems.useQuery({ rentalRequestId: rentalId });
  const { data: prepayments } = trpc.rentalPrepayments.list.useQuery({ rentalRequestId: rentalId });
  const { data: renewals } = trpc.extensionRequests.listByRental.useQuery({ rentalRequestId: rentalId });
  // Lazy-loaded — only fetch when the relevant tab is active
  const { data: dispatches } = trpc.dispatch.getByRentalId.useQuery({ rentalId }, { enabled: activeTab === "dispatch" });
  // Dispatch assigns to a driver: dispatch_orders.assignedDriverId is FK'd to
  // drivers.id, NOT users.id (drivers has its own PK, with an optional userId
  // link). This must query drivers.list — the same source the main /admin/dispatch
  // page uses — or the id submitted here would not satisfy the FK.
  const { data: drivers } = trpc.drivers.list.useQuery(undefined, { enabled: activeTab === "dispatch" });
  const { data: inspections } = trpc.inspections.getByRentalId.useQuery({ rentalId }, { enabled: activeTab === "inspections" });
  const { data: statusHistory } = trpc.rentals.getStatusHistory.useQuery({ rentalId }, { enabled: activeTab === "overview" });
  const { data: changeHistory } = trpc.auditLog.getByRental.useQuery({ rentalId }, { enabled: activeTab === "history" });
  // Live (non-cancelled) rental invoice → drives the "already invoiced" notice
  // on the pricing tab. Money edits stay allowed but require a reason.
  // Also needed on the overview tab so the prepayments section can show each
  // invoice's settlement status (the visible 预收款 ↔ 发票 linkage).
  const { data: rentalInvoices } = trpc.invoices.list.useQuery({ rentalId }, { enabled: activeTab === "pricing" || activeTab === "overview" });
  const orderInvoices = (rentalInvoices ?? [])
    .map((row) => row.invoices)
    .filter((inv) => inv.status !== "cancelled");
  const activeInvoice = orderInvoices.find((inv) => inv.type === "rental");
  // Extra charges (额外收费) for this order — fuel/damage/cleaning/etc.
  const { data: extraCharges } = trpc.damageClaims.list.useQuery({ rentalId }, { enabled: activeTab === "pricing" });
  const [extraChargeForm, setExtraChargeForm] = useState<{ chargeType: string; amount: string; description: string }>({ chargeType: "fuel", amount: "", description: "" });
  const addExtraCharge = trpc.damageClaims.create.useMutation({
    onSuccess: () => {
      // Invalidate ALL list variants (not just this rental's) so the standalone
      // Additional Charges page reflects it too — one source of truth, both views.
      utils.damageClaims.list.invalidate();
      utils.rentals.getById.invalidate({ id: rentalId });
      setExtraChargeForm({ chargeType: "fuel", amount: "", description: "" });
      toast.success(t("management.chargeAdded"));
    },
    onError: (e) => toast.error(serverErrorText(e)),
  });
  // In-place correction of an already-recorded extra charge. Every edit carries a
  // reason (EDIT_REASONS) so the change-history tab records why, not just what.
  const [editingCharge, setEditingCharge] = useState<
    { id: number; amount: string; description: string; reason: EditReason | ""; reasonNote: string } | null
  >(null);
  const [deletingCharge, setDeletingCharge] = useState<
    { id: number; reason: EditReason | ""; reasonNote: string } | null
  >(null);
  const updateExtraCharge = trpc.damageClaims.update.useMutation({
    onSuccess: () => {
      utils.damageClaims.list.invalidate();
      utils.rentals.getById.invalidate({ id: rentalId });
      setEditingCharge(null);
      toast.success(t("management.chargeUpdated"));
    },
    onError: (e) => toast.error(serverErrorText(e)),
  });
  const deleteExtraCharge = trpc.damageClaims.delete.useMutation({
    onSuccess: () => {
      utils.damageClaims.list.invalidate();
      utils.rentals.getById.invalidate({ id: rentalId });
      setDeletingCharge(null);
      toast.success(t("management.chargeDeleted"));
    },
    onError: (e) => toast.error(serverErrorText(e)),
  });
  const submitChargeEdit = () => {
    if (!editingCharge) return;
    if (!editingCharge.reason) return toast.error(t("editReason.required", { ns: "common" }));
    if (editingCharge.reason === "other" && !editingCharge.reasonNote.trim()) {
      return toast.error(t("errors.edit.noteRequired", { ns: "common" }));
    }
    const amt = parseFloat(editingCharge.amount);
    if (!amt || isNaN(amt) || amt <= 0) return toast.error(t("management.chargeAmountRequired"));
    if (!editingCharge.description.trim()) return toast.error(t("management.chargeDescRequired"));
    updateExtraCharge.mutate({
      id: editingCharge.id,
      amount: amt,
      description: editingCharge.description.trim(),
      reason: editingCharge.reason,
      ...(editingCharge.reasonNote.trim() ? { reasonNote: editingCharge.reasonNote.trim() } : {}),
    });
  };
  const submitChargeDelete = () => {
    if (!deletingCharge) return;
    if (!deletingCharge.reason) return toast.error(t("editReason.required", { ns: "common" }));
    if (deletingCharge.reason === "other" && !deletingCharge.reasonNote.trim()) {
      return toast.error(t("errors.edit.noteRequired", { ns: "common" }));
    }
    deleteExtraCharge.mutate({
      id: deletingCharge.id,
      reason: deletingCharge.reason,
      ...(deletingCharge.reasonNote.trim() ? { reasonNote: deletingCharge.reasonNote.trim() } : {}),
    });
  };

  const submitExtraCharge = () => {
    const amt = parseFloat(extraChargeForm.amount);
    if (!amt || isNaN(amt) || amt <= 0) return toast.error(t("management.chargeAmountRequired"));
    if (!extraChargeForm.description.trim()) return toast.error(t("management.chargeDescRequired"));
    addExtraCharge.mutate({
      rentalId,
      chargeType: extraChargeForm.chargeType as "damage" | "fuel" | "cleaning" | "overtime" | "transport" | "other",
      description: extraChargeForm.description.trim(),
      ...(extraChargeForm.chargeType === "damage" ? { repairEstimate: amt } : { amount: amt }),
    });
  };
  const { data: comparison } = trpc.inspections.getComparisonForRental.useQuery({ rentalId }, { enabled: activeTab === "inspections" });
  const signatureEvidenceEnabled = useFeatureFlag("signature_evidence");
  const { data: signatureEvidence } = trpc.signatureEvidence.getForRental.useQuery(
    { rentalId },
    { enabled: activeTab === "contract" && signatureEvidenceEnabled },
  );

  const updateRental = trpc.rentals.update.useMutation({
    onSuccess: () => {
      utils.rentals.getById.invalidate();
      utils.rentals.list.invalidate();
      utils.auditLog.getByRental.invalidate({ rentalId });
      setEditReason("");
      setPriceOverride(false);
      toast.success(t("management.saved"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeForm, setCloseForm] = useState({ actualReturnedAt: "", damageCharges: "", adminNotes: "" });

  const closeRental = trpc.rentals.closeRental.useMutation({
    onSuccess: (res) => {
      utilsRepRefresh.rentals.list.invalidate();
      utilsRepRefresh.rentals.getById.invalidate();
      toast.success(t("management.closeRentalDone", { lateFee: res.accruedLateFee.toFixed(2), damage: res.damageCharges.toFixed(2) }));
      if (res.failures.length > 0) {
        toast.warning(t("management.statusUpdatedWithGaps", {
          kinds: Array.from(new Set(res.failures.map((failure) => failure.kind))).join(", "),
        }));
      }
      setCloseOpen(false);
      setCloseForm({ actualReturnedAt: "", damageCharges: "", adminNotes: "" });
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [repSignOpen, setRepSignOpen] = useState(false);
  const { canvasRef: repCanvasRef, signature: repSignature, handlers: repSignatureHandlers, clear: repClear } = useSignaturePad();

  const utilsRepRefresh = trpc.useUtils();
  const signAsRep = trpc.rentals.signAsRep.useMutation({
    onSuccess: () => {
      utilsRepRefresh.rentals.list.invalidate();
      utilsRepRefresh.rentals.getById.invalidate();
      toast.success(t("management.signatureSaved"));
      setRepSignOpen(false);
      repClear();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const generateContract = trpc.rentals.generateContract.useMutation({
    onSuccess: () => { utils.rentals.getById.invalidate(); toast.success(t("management.contractGenerated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const createToken = trpc.inspections.createToken.useMutation({
    onSuccess: (result) => {
      const url = `${window.location.origin}/inspect/${result.token}`;
      navigator.clipboard.writeText(url);
      toast.success(t("management.linkCopied"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateStatus = trpc.rentals.updateStatus.useMutation({
    onSuccess: (result) => {
      utils.rentals.getById.invalidate();
      utils.rentals.list.invalidate();
      utils.rentals.getStatusHistory.invalidate();
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
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const refreshAssetProgress = async (item?: AssetProgressItem) => {
    await utils.rentalAssetProgress.byRental.invalidate({ rentalId });
    await utils.rentalAssetProgress.fieldList.invalidate();
    if (item) await utils.rentalAssetProgress.timeline.invalidate({ rentalId, rentalFleetId: item.rentalFleetId });
  };
  const startAssetReturn = trpc.rentalAssetProgress.startReturn.useMutation({
    onSuccess: async (_result, input) => {
      await refreshAssetProgress(assetProgress?.find((item) => item.rentalFleetId === input.rentalFleetId));
      toast.success(t("assetProgress.returnStarted", { ns: "common" }));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });
  const confirmPhysicalPickup = trpc.rollingRentals.pickup.useMutation({
    onSuccess: async (_result, input) => {
      await refreshAssetProgress(assetProgress?.find((item) => item.rentalFleetId === input.rentalFleetId));
      await utils.rollingRentals.summary.invalidate({ rentalId });
      toast.success(t("assetProgress.physicalPickupRecorded", { ns: "common" }));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });
  const bypassAssetInspection = trpc.rentalAssetProgress.bypassInspection.useMutation({
    onSuccess: async (_result, input) => {
      await refreshAssetProgress(assetProgress?.find((item) => item.rentalFleetId === input.rentalFleetId));
      toast.success(t("assetProgress.bypassRecorded", { ns: "common" }));
    },
    onError: (error) => toast.error(serverErrorText(error)),
  });
  const reopenRental = trpc.rentals.reopen.useMutation({
    onSuccess: (res) => {
      utils.rentals.getById.invalidate();
      utils.rentals.list.invalidate();
      utils.rentals.getStatusHistory.invalidate();
      if (res.fleetReassignFailed && res.fleetReassignFailed.length > 0) {
        toast.warning(t("management.reopenedFleetWarning"));
      } else {
        toast.success(t("management.reopened"));
      }
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const createDispatch = trpc.dispatch.create.useMutation({
    onSuccess: () => { utils.dispatch.getByRentalId.invalidate(); toast.success(t("management.dispatchCreated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateDispatch = trpc.dispatch.update.useMutation({
    onSuccess: () => { utils.dispatch.getByRentalId.invalidate(); toast.success(t("management.dispatchUpdated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateDispatchStatus = trpc.dispatch.updateStatus.useMutation({
    onSuccess: () => { utils.dispatch.getByRentalId.invalidate(); utils.rentals.getById.invalidate(); toast.success(t("management.dispatchStatusUpdated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const duplicateRental = trpc.rentals.duplicate.useMutation({
    onSuccess: (result) => {
      toast.success(`Rental ${result.rentalNumber ?? `#${result.id}`} created`);
      onClose();
      navigate(getGlobalSearchPath("rental", result.id));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const renewalEnabled = useFeatureFlag("rental_renewal");
  const renewMutation = trpc.rentals.renew.useMutation({
    onSuccess: (result) => {
      if (result.supplementSkipped) {
        toast.success(t("management.renewalSuccessNoInvoice", {
          days: result.extensionDays,
        }));
      } else {
        toast.success(t("management.renewalSuccess", {
          days: result.extensionDays,
          invoice: result.supplementInvoiceNumber ?? "—",
          amount: result.supplementAmount,
        }));
      }
      utils.rentals.getById.invalidate({ id: rentalId });
      utils.rentals.list.invalidate();
      utils.rentals.getLineItems.invalidate({ rentalRequestId: rentalId });
      utils.invoices.list.invalidate({ rentalId });
      utils.extensionRequests.listByRental.invalidate({ rentalRequestId: rentalId });
      setRenewOpen(false);
      setRenewConflict(false);
    },
    onError: (err) => {
      // Fleet booked in the window → offer an admin override instead of a dead end.
      if (err.data?.code === "CONFLICT") {
        setRenewConflict(true);
        toast.error(serverErrorText(err));
      } else {
        toast.error(serverErrorText(err));
      }
    },
  });
  const undoRenewMutation = trpc.rentals.undoLastRenewal.useMutation({
    onSuccess: () => {
      toast.success(t("management.undoRenewalSuccess"));
      utils.rentals.getById.invalidate({ id: rentalId });
      utils.rentals.list.invalidate();
      utils.rentals.getLineItems.invalidate({ rentalRequestId: rentalId });
      utils.invoices.list.invalidate({ rentalId });
      utils.extensionRequests.listByRental.invalidate({ rentalRequestId: rentalId });
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const r = data?.rental_requests;
  const fleet = data?.rental_fleet;
  const rentalReadyForClose = Boolean(
    r
    && ["active", "approved", "overdue"].includes(r.status)
    && areAssetsReadyForAdminClose(assetProgress ?? []),
  );
  const [editRentalFee, setEditRentalFee] = useState("");
  const [editFreight, setEditFreight] = useState("");
  const [editInsurance, setEditInsurance] = useState("");
  const [editTax, setEditTax] = useState("");
  const [editDeposit, setEditDeposit] = useState("");
  const [editReason, setEditReason] = useState("");
  // Pricing is locked to the saved/system values; editing requires Override + reason.
  const [priceOverride, setPriceOverride] = useState(false);
  const [adminNotes, setAdminNotes] = useState("");
  const [financialOrderNumber, setFinancialOrderNumber] = useState("");
  const [cardLast4, setCardLast4] = useState("");
  const [lightboxPhotos, setLightboxPhotos] = useState<{ src: string; label: string }[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [editingDates, setEditingDates] = useState(false);
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [dispatchCreateOpen, setDispatchCreateOpen] = useState(false);
  const [dispatchEditId, setDispatchEditId] = useState<number | null>(null);
  const [dispatchForm, setDispatchForm] = useState({ orderType: "delivery" as "delivery" | "pickup", scheduledDate: "", assignedDriverId: "", pickupAddress: "", deliveryAddress: "", notes: "" });
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [dupStartDate, setDupStartDate] = useState("");
  const [dupEndDate, setDupEndDate] = useState("");
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewEndDate, setRenewEndDate] = useState("");
  const [renewConflict, setRenewConflict] = useState(false);
  const [inspEditOpen, setInspEditOpen] = useState<{ mode: "create" | "edit"; id?: number; type?: "dispatch" | "return" | "general"; fleetId?: number } | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapTargetId, setSwapTargetId] = useState<number | "">("");
  const [swapReason, setSwapReason] = useState("");

  // ─── Prepayments ───────────────────────────────────────────
  // invoiceId "" → order-level deposit (FIFO); a specific id tags the collection
  // to that invoice (for multi-invoice monthly-credit / renewal orders).
  const [prepayForm, setPrepayForm] = useState<{ amount: string; paymentMethod: PaymentMethod; paymentDate: string; notes: string; invoiceId: string }>(
    { amount: "", paymentMethod: "e_transfer", paymentDate: "", notes: "", invoiceId: "" },
  );
  const resetPrepayForm = () => setPrepayForm({ amount: "", paymentMethod: "e_transfer", paymentDate: "", notes: "", invoiceId: "" });
  const createPrepayment = trpc.rentalPrepayments.create.useMutation({
    onSuccess: () => {
      // Recording a 预收款 settles the order's invoice(s) server-side → refresh both views.
      invalidatePaymentCaches(utils);
      resetPrepayForm();
      toast.success(t("management.saved"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deletePrepayment = trpc.rentalPrepayments.delete.useMutation({
    onSuccess: () => {
      invalidatePaymentCaches(utils);
      toast.success(t("management.saved"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  // 预付款转租金 — converts all HELD prepayments on this order to rent at once.
  const convertToRent = trpc.rentalPrepayments.convertToRent.useMutation({
    onSuccess: (res) => {
      invalidatePaymentCaches(utils);
      toast.success(t("management.convertedToRent", { count: res.converted }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  // 押金转客户余额 — the third option for a held deposit once a rental is over:
  // not converted to rent, not refunded, but parked on the customer's account
  // for next time. Four orders were sitting on $7,550 with no way to do this.
  const transferDeposit = trpc.customerCredit.transferDeposit.useMutation({
    onSuccess: (res) => {
      invalidatePaymentCaches(utils);
      utils.customerCredit.byCustomer.invalidate();
      utils.customerCredit.overview.invalidate();
      utils.reports.internalWorkQueue.invalidate();
      toast.success(t("management.depositTransferred", { amount: formatCurrency(res.transferred) }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  // 撤销转租金 — put converted payments back to 待转 so staff can redo by hand.
  const unconvert = trpc.rentalPrepayments.unconvert.useMutation({
    onSuccess: (res) => {
      invalidatePaymentCaches(utils);
      toast.success(t("management.unconverted", { count: res.reverted }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  // 记录退款 — refund the overpayment back to the customer (negative ledger row).
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundForm, setRefundForm] = useState<{ amount: string; paymentMethod: PaymentMethod; notes: string }>(
    { amount: "", paymentMethod: "e_transfer", notes: "" },
  );
  const recordRefund = trpc.rentalPrepayments.recordRefund.useMutation({
    onSuccess: () => {
      invalidatePaymentCaches(utils);
      setRefundOpen(false);
      setRefundForm({ amount: "", paymentMethod: "e_transfer", notes: "" });
      toast.success(t("management.refundRecorded"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const prepaidTotal = useMemo(() =>
    (prepayments ?? []).reduce((sum, p) => sum + parseFloat(p.amount || "0"), 0),
    [prepayments]
  );
  // Applied (转租金) NET of refunds; held; and refunds — only applied settles the
  // invoice, and refunds (negative applied rows) reduce the net.
  const appliedTotal = useMemo(() =>
    (prepayments ?? []).filter((p) => p.appliedAt).reduce((sum, p) => sum + parseFloat(p.amount || "0"), 0),
    [prepayments]
  );
  // Money still waiting on a decision. A deposit leaves this bucket two ways:
  // converted to rent (appliedAt) or parked on the customer's account
  // (transferredToCreditAt, migration 150). Only checking appliedAt kept
  // transferred deposits showing as "held" forever — and disagreed with
  // internalWorkQueue, which excludes both.
  const heldTotal = useMemo(() =>
    (prepayments ?? [])
      .filter((p) => !p.appliedAt && !p.transferredToCreditAt)
      .reduce((sum, p) => sum + parseFloat(p.amount || "0"), 0),
    [prepayments]
  );
  // "Finished" for deposit purposes: the rental is over one way or another, so
  // a deposit still sitting on it is a loose end rather than a live guarantee.
  const isFinished = ["completed", "cancelled", "rejected"].includes(r?.status ?? "");
  const refundedTotal = useMemo(() =>
    (prepayments ?? []).reduce((sum, p) => { const a = parseFloat(p.amount || "0"); return a < 0 ? sum - a : sum; }, 0),
    [prepayments]
  );

  // ─── Credit (挂账) charges ──────────────────────────────────
  const isCreditOrder = !!data?.rental_requests?.isCreditOrder;
  const isCreditSettled = !!data?.rental_requests?.creditFinalizedAt;
  const { data: charges } = trpc.rentalCharges.list.useQuery(
    { rentalRequestId: rentalId },
    { enabled: isCreditOrder },
  );
  const refreshCharges = () => {
    utils.rentalCharges.list.invalidate({ rentalRequestId: rentalId });
    utils.rentals.getById.invalidate();
    utils.rentals.list.invalidate();
  };
  const warnCredit = (w: { exposure: number; creditLimit: number } | null | undefined) => {
    if (w) toast.warning(t("management.creditLimitWarning", { exposure: w.exposure.toFixed(2), limit: w.creditLimit.toFixed(2) }));
  };
  const [chargeForm, setChargeForm] = useState({ chargeType: "adjustment" as "adjustment" | "final", amount: "", description: "", chargeDate: "" });
  const createCharge = trpc.rentalCharges.create.useMutation({
    onSuccess: (res) => {
      refreshCharges();
      setChargeForm({ chargeType: "adjustment", amount: "", description: "", chargeDate: "" });
      toast.success(t("management.saved"));
      warnCredit(res.creditWarning);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  // Editing / deleting a recorded charge both go through one dialog, because
  // both need the same thing the plain window.confirm could never collect: the
  // reason. Without it the audit row says what changed but not why.
  const [chargeEdit, setChargeEdit] = useState<
    | { id: number; mode: "edit" | "delete"; amount: string; description: string; chargeDate: string; reason: string; reasonNote: string }
    | null
  >(null);
  const closeChargeEdit = () => setChargeEdit(null);
  // Deleting an extra charge is a separate permission from editing one (admins
  // have update but not delete by default), so the button must reflect that
  // instead of rendering enabled and 403-ing on click.
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const canDeleteCharge = canUseModulePermission(myPerms, "damage_claims", "delete");

  // Waiving an already-invoiced charge: the issued invoice is left alone and a
  // credit note is raised for the charge plus its share of tax.
  const [waivingCharge, setWaivingCharge] = useState<
    | { id: number; amount: string; reason: string; reasonNote: string }
    | null
  >(null);
  const waiveCharge = trpc.invoices.waiveCharge.useMutation({
    onSuccess: (res) => {
      setWaivingCharge(null);
      utils.damageClaims.list.invalidate();
      utils.rentals.getById.invalidate({ id: rentalId });
      utils.invoices.list.invalidate();
      toast.success(t("management.chargeWaived", { number: res.creditNoteNumber, amount: res.totalAmount }));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  // Deleting a recorded payment now needs a reason, same as every other
  // correction — a native confirm() cannot collect one (and blocks automation).
  const [prepaymentDelete, setPrepaymentDelete] = useState<
    | { id: number; amount: string; reason: string; reasonNote: string }
    | null
  >(null);
  const updateCharge = trpc.rentalCharges.update.useMutation({
    onSuccess: (res) => {
      refreshCharges();
      closeChargeEdit();
      toast.success(t("management.saved"));
      warnCredit(res.creditWarning);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteCharge = trpc.rentalCharges.delete.useMutation({
    onSuccess: () => { refreshCharges(); closeChargeEdit(); toast.success(t("management.saved")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const generateChargeInvoice = trpc.rentalCharges.generateInvoice.useMutation({
    onSuccess: (res) => { refreshCharges(); utils.rentals.getById.invalidate(); toast.success(t("management.chargeInvoiceCreated", { number: res.invoiceNumber })); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const [exchangeForm, setExchangeForm] = useState({ newRentalFleetId: "" as number | "", fee: "", exchangeDate: "", description: "" });
  const exchangeBin = trpc.rentals.exchangeBin.useMutation({
    onSuccess: (res) => {
      refreshCharges();
      setExchangeOpen(false);
      setExchangeForm({ newRentalFleetId: "", fee: "", exchangeDate: "", description: "" });
      toast.success(t("management.exchangeSuccess"));
      warnCredit(res.creditWarning);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [finalizeForm, setFinalizeForm] = useState({ actualEndDate: "", finalAmount: "", adminNotes: "" });
  const finalizeCreditOrder = trpc.rentals.finalizeCreditOrder.useMutation({
    onSuccess: () => {
      refreshCharges();
      setFinalizeOpen(false);
      setFinalizeForm({ actualEndDate: "", finalAmount: "", adminNotes: "" });
      toast.success(t("management.finalizeSuccess"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const { data: exchangeFleetData } = trpc.rentalFleet.listForDropdown.useQuery(undefined, { enabled: exchangeOpen });
  const exchangeCandidates = useMemo(
    () => (exchangeFleetData ?? []).filter((f) => f.currentStatus === "available"),
    [exchangeFleetData],
  );
  const chargesTotal = useMemo(() => (charges ?? []).reduce((s, c) => s + parseFloat(c.amount || "0"), 0), [charges]);
  const chargesUnbilled = useMemo(() => (charges ?? []).filter((c) => !c.invoiceId).reduce((s, c) => s + parseFloat(c.amount || "0"), 0), [charges]);

  const swapFleet = trpc.rentals.swapFleet.useMutation({
    onSuccess: () => {
      utils.rentals.getById.invalidate();
      utils.rentals.list.invalidate();
      toast.success(t("management.swapSuccess"));
      setSwapOpen(false);
      setSwapTargetId("");
      setSwapReason("");
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const { data: swapCandidatesData } = trpc.rentals.listSwapCandidates.useQuery(
    { rentalRequestId: rentalId },
    { enabled: swapOpen },
  );
  const swapCandidates = swapCandidatesData?.candidates ?? [];

  // Mid-rental swap (active/overdue, non-credit): replace a broken unit.
  const midSwapEnabled = useFeatureFlag("mid_rental_swap");
  const [midSwapOpen, setMidSwapOpen] = useState(false);
  const emptyMidSwap = {
    oldFleetId: "" as number | "",
    newFleetId: "" as number | "",
    reasonType: "equipment_fault" as "equipment_fault" | "customer_fault" | "other",
    reason: "",
    chargeAmount: "",
    chargeDescription: "",
    createWorkOrder: true,
    createDispatch: true,
  };
  const [midSwap, setMidSwap] = useState(emptyMidSwap);
  const midRentalSwap = trpc.rentals.midRentalSwap.useMutation({
    onSuccess: (res) => {
      utils.rentals.getById.invalidate();
      utils.rentals.list.invalidate();
      utils.rentals.getLineItems.invalidate();
      const extras = [
        res.workOrderNumber ? t("management.midSwapWorkOrderCreated", { number: res.workOrderNumber }) : null,
        res.dispatchCreated ? t("management.midSwapDispatchCreated", { count: res.dispatchCreated }) : null,
        res.damageClaimId ? t("management.midSwapChargeCreated") : null,
        res.contractRegenerated ? t("management.midSwapContractRegenerated") : null,
      ].filter(Boolean).join(" · ");
      toast.success(extras ? `${t("management.midSwapSuccess")} — ${extras}` : t("management.midSwapSuccess"));
      for (const f of res.failures ?? []) {
        toast.error(t("management.midSwapSideEffectFailed", { kind: f.kind }));
      }
      warnCredit(res.creditWarning);
      setMidSwapOpen(false);
      setMidSwap(emptyMidSwap);
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const { data: midSwapCandData, isFetching: midSwapCandLoading } = trpc.rentals.listMidSwapCandidates.useQuery(
    { rentalRequestId: rentalId, oldRentalFleetId: typeof midSwap.oldFleetId === "number" ? midSwap.oldFleetId : undefined },
    { enabled: midSwapOpen && typeof midSwap.oldFleetId === "number" },
  );
  // Units currently on the order — the "which unit broke" choices.
  const orderUnits = useMemo(() => {
    const units: { id: number; label: string }[] = [];
    if (lineItems && lineItems.length > 0) {
      for (const row of lineItems) {
        if (row.fleet?.id) {
          units.push({ id: row.fleet.id, label: `${row.fleet.brand} ${row.fleet.model}${row.fleet.serialNumber ? ` · ${row.fleet.serialNumber}` : ""}` });
        }
      }
    }
    if (units.length === 0 && fleet) {
      units.push({ id: fleet.id, label: `${fleet.brand} ${fleet.model}${fleet.serialNumber ? ` · ${fleet.serialNumber}` : ""}` });
    }
    return units;
  }, [lineItems, fleet]);
  const openMidSwap = () => {
    setMidSwap({ ...emptyMidSwap, oldFleetId: orderUnits.length === 1 ? orderUnits[0].id : "" });
    lastAutoChargeRef.current = "";
    setMidSwapOpen(true);
  };

  // Rate difference when swapping to a DIFFERENT model: equipment fault → waived
  // by default; customer-side reasons → suggest charging it for the remaining days.
  const midSwapDiff = useMemo(() => {
    const cand = (midSwapCandData?.candidates ?? []).find((c) => c.id === midSwap.newFleetId);
    if (!cand || cand.sameModel || !midSwapCandData?.current) return null;
    const curDaily = parseFloat(midSwapCandData.current.rates.dailyRate || "0");
    const candDaily = parseFloat(cand.rates.dailyRate || "0");
    if (!(curDaily > 0) || !(candDaily > 0) || candDaily === curDaily) return null;
    const remainingDays = r?.endDate
      ? Math.max(0, Math.ceil((new Date(r.endDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
      : 0;
    const perDay = candDaily - curDaily;
    return { perDay, remainingDays, total: perDay * remainingDays };
  }, [midSwapCandData, midSwap.newFleetId, r]);

  const midSwapAutoCharge = midSwap.reasonType !== "equipment_fault" && midSwapDiff && midSwapDiff.total > 0
    ? midSwapDiff.total.toFixed(2)
    : "";
  const lastAutoChargeRef = useRef("");
  useEffect(() => {
    if (!midSwapOpen) return;
    setMidSwap((prev) => {
      // Leave the field alone once the operator has typed their own value.
      if (prev.chargeAmount !== "" && prev.chargeAmount !== lastAutoChargeRef.current) return prev;
      if (prev.chargeAmount === midSwapAutoCharge) return prev;
      lastAutoChargeRef.current = midSwapAutoCharge;
      return { ...prev, chargeAmount: midSwapAutoCharge };
    });
  }, [midSwapAutoCharge, midSwapOpen]);

  // Price preview query — only fires when dates are being edited and valid
  const datesChanged = useMemo(() => {
    if (!editingDates || !r) return false;
    const origStart = r.startDate ? formatCalendarDateISO(r.startDate) : "";
    const origEnd = r.endDate ? formatCalendarDateISO(r.endDate) : "";
    return (editStartDate !== origStart || editEndDate !== origEnd) && editStartDate && editEndDate && editStartDate < editEndDate;
  }, [editingDates, editStartDate, editEndDate, r]);

  const { data: pricePreview, isFetching: previewLoading } = trpc.rentals.previewDateChange.useQuery(
    { id: rentalId, startDate: editStartDate, endDate: editEndDate },
    { enabled: !!datesChanged },
  );

  // Sync form state when data loads
  useEffect(() => {
    if (r) {
      setEditRentalFee(r.rentalFee || "");
      setEditFreight(r.freightCost || "");
      setEditInsurance(r.insuranceCost || "");
      setEditTax(r.taxAmount || "");
      setEditDeposit(r.depositAmount || "");
      setAdminNotes(r.adminNotes || "");
      setFinancialOrderNumber(r.financialOrderNumber || "");
      setCardLast4(r.cardLast4 || "");
      setPriceOverride(false);
      setEditReason("");
    }

  }, [r?.id]);

  // Hooks must run in the same order every render — keep them above the
  // early-return below or React throws "rendered fewer hooks than expected"
  // and the dialog white-screens.
  const fmtDate = useFormatCalendarDate();
  const tz = useAppTimezone();
  const fmtDateTime = (d: string | Date | null | undefined) => d ? new Date(d).toLocaleString() : "-";

  if (!data || !r) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/50" onClick={onClose} />
        <div className="relative bg-[var(--surface-container-lowest)] rounded-xl shadow-xl max-w-md w-full p-8 text-center">
          <p className="text-slate-500">{t("management.loadingDetails")}</p>
        </div>
      </div>
    );
  }
  const days = Math.max(1, Math.ceil((new Date(r.endDate).getTime() - new Date(r.startDate).getTime()) / (1000 * 60 * 60 * 24)));
  const totalAmount = parseFloat(r.totalAmount || "0");
  // Extra charges (fuel/damage/…) are billed but never folded into totalAmount,
  // so the true amount the customer owes = base total + extra charges (+ their
  // tax, computed server-side to match the invoice). Without this the balance —
  // and the refund default below — drop the extra charges and over-refund.
  const extraChargesOwed = data?.extraChargesOwed?.total ?? 0;
  const amountOwed = totalAmount + extraChargesOwed;
  // balance > 0 → customer still owes money; balance < 0 → refund owed to customer.
  // Only APPLIED (转租金) prepayments settle the rent; held money isn't counted yet.
  const balance = amountOwed - appliedTotal;

  // Calculate billed total from individual fields. Deposit is excluded — it's a
  // refundable held liability, not revenue (matches the booking engine & reports).
  const calcTotal = () => {
    const sum = [editRentalFee, editFreight, editInsurance, editTax]
      .reduce((acc, val) => acc + (parseFloat(val) || 0), 0);
    return sum;
  };

  const savePricing = () => {
    const total = calcTotal().toFixed(2);
    // Money changed vs the saved order? (loose string compare, matches backend)
    const moneyChanged = !!r && (
      (editRentalFee || "") !== (r.rentalFee ?? "") ||
      (editFreight || "") !== (r.freightCost ?? "") ||
      (editInsurance || "") !== (r.insuranceCost ?? "") ||
      (editTax || "") !== (r.taxAmount ?? "") ||
      (editDeposit || "") !== (r.depositAmount ?? "") ||
      total !== (r.totalAmount ?? "")
    );
    // System price is authoritative: any money change requires Override + reason.
    if (moneyChanged) {
      if (!priceOverride) return toast.error(t("management.overrideToEditPrice"));
      if (!editReason.trim()) {
        return toast.error(activeInvoice ? t("management.invoicedEditReasonRequired") : t("management.overrideReasonRequired"));
      }
    }
    updateRental.mutate({
      id: rentalId,
      rentalFee: editRentalFee || undefined,
      freightCost: editFreight || undefined,
      insuranceCost: editInsurance || undefined,
      taxAmount: editTax || undefined,
      depositAmount: editDeposit || undefined,
      totalAmount: total,
      adminNotes: adminNotes || undefined,
      editReason: editReason.trim() || undefined,
    });
  };

  const tabClass = (tab: string) =>
    `px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${activeTab === tab ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-slate-500 hover:text-slate-700"}`;

  const photoLabels = [
    { key: "photoFront" as const, label: t("photo.front", { ns: "common" }) },
    { key: "photoBack" as const, label: t("photo.back", { ns: "common" }) },
    { key: "photoLeft" as const, label: t("photo.left", { ns: "common" }) },
    { key: "photoRight" as const, label: t("photo.right", { ns: "common" }) },
    { key: "photoAdditional" as const, label: t("photo.additional", { ns: "common" }) },
  ];

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-stretch md:items-center md:justify-center md:p-4">
        <div className="fixed inset-0 bg-black/50" onClick={onClose} />
        <div className="relative bg-[var(--surface-container-lowest)] md:rounded-xl shadow-xl max-w-6xl w-full h-full md:h-auto md:max-h-[95vh] overflow-y-auto">
          {/* Header */}
          <div className="sticky top-0 bg-white border-b border-slate-200 px-4 md:px-6 py-3 md:py-4 z-10">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-3 mb-3">
              <div className="flex items-center gap-2 md:gap-3 min-w-0">
                <h2 className="text-lg md:text-xl font-bold text-slate-900 truncate">{t("management.rentalNumber", { id: r.rentalNumber || r.id })}</h2>
                <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${statusColors[r.status] || ""}`}>{t(`status.${r.status}`, { ns: "common" })}</span>
                {totalAmount > 0 && <PaymentBadge state={derivePaymentState(totalAmount, appliedTotal)} className="shrink-0" />}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={async () => {
                    try {
                      await copyFinanceRowTSV(data);
                      toast.success(t("management.financeRowCopied"));
                    } catch {
                      toast.error(t("management.copyFinanceRow"));
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
                  title={t("management.copyFinanceRow")}
                >
                  <CopyIcon className="w-4 h-4" />
                  <span className="hidden sm:inline">{t("management.copyFinanceRow")}</span>
                </button>
                <button
                  onClick={async () => {
                    try {
                      await copyWeChatDispatch(data);
                      toast.success(t("management.weChatCopied"));
                    } catch {
                      toast.error(t("management.copyWeChat"));
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
                  title={t("management.copyWeChat")}
                >
                  <MessageCircle className="w-4 h-4" />
                  <span className="hidden sm:inline">{t("management.copyWeChat")}</span>
                </button>
                {canDuplicate && ["completed", "active", "cancelled"].includes(r.status) && (
                  <button
                    onClick={() => {
                      // Anchor on Toronto's "today", then do pure calendar
                      // arithmetic on a UTC scratch date so the YYYY-MM-DD
                      // strings are correct regardless of the viewer's zone.
                      const start = new Date(`${formatCalendarDateISO(new Date())}T00:00:00.000Z`);
                      start.setUTCDate(start.getUTCDate() + 1);
                      const originalDays = Math.max(1, Math.ceil(
                        (new Date(r.endDate).getTime() - new Date(r.startDate).getTime()) / (1000 * 60 * 60 * 24)
                      ));
                      const dupEnd = new Date(start);
                      dupEnd.setUTCDate(dupEnd.getUTCDate() + originalDays);
                      setDupStartDate(start.toISOString().split("T")[0]);
                      setDupEndDate(dupEnd.toISOString().split("T")[0]);
                      setDuplicateOpen(true);
                    }}
                    className="text-sm bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg flex items-center gap-1"
                  >
                    <CopyIcon size={14} /> {t("management.duplicate")}
                  </button>
                )}
                {renewalEnabled && ["active", "approved", "overdue", "completed"].includes(r.status) && (
                  <button
                    onClick={() => setRenewOpen((v) => !v)}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 font-medium"
                  >
                    <RefreshCw size={12} /> {t("management.renewRental")}
                  </button>
                )}
                {["active", "approved", "overdue"].includes(r.status) && !(isCreditOrder && !isCreditSettled) && (
                  <button
                    onClick={() => setCloseOpen(true)}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 font-medium"
                    title={t("management.closeRentalHint")}
                  >
                    {t("management.closeRental")}
                  </button>
                )}
                {isCreditOrder && !isCreditSettled && ["active", "approved", "overdue"].includes(r.status) && (
                  <button
                    onClick={() => { setActiveTab("pricing"); setFinalizeOpen(true); }}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 font-medium"
                    title={t("management.finalizeHint")}
                  >
                    {t("management.finalizeCreditOrder")}
                  </button>
                )}
                {r.status === "completed" && isSuperAdmin && (
                  <button
                    onClick={() => {
                      const reason = prompt(t("management.reopenConfirm"));
                      if (reason === null) return;
                      reopenRental.mutate({ id: rentalId, reason: reason || undefined });
                    }}
                    disabled={reopenRental.isPending}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 font-medium disabled:opacity-50"
                    title={t("management.reopenHint")}
                  >
                    <RotateCcw size={12} /> {t("management.reopen")}
                  </button>
                )}
                <select
                  value={r.status}
                  onChange={(e) => {
                    const next = e.target.value as typeof rentalStatusOptions[number];
                    updateStatus.mutate({ id: rentalId, status: next });
                  }}
                  className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-xs text-slate-900"
                >
                  {directRentalStatusOptions(r.status).map((s) => <option key={s} value={s}>{t(`status.${s}`, { ns: "common" })}</option>)}
                </select>
                <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl" aria-label={t("close", { ns: "common" })}>&times;</button>
              </div>
            </div>

            {/* Status Timeline */}
            {statusHistory && statusHistory.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-2 mb-2">
                {statusHistory.slice().reverse().map((entry, idx) => {
                  const changes = entry.changes ? JSON.parse(entry.changes as string) as Record<string, { old: string; new: string }> : {} as Record<string, { old: string; new: string }>;
                  const statusChange = changes.status;
                  return (
                    <div key={entry.id} className="flex items-center gap-1 shrink-0">
                      {idx > 0 && <div className="w-4 h-px bg-slate-300" />}
                      <div className="text-center">
                        <div className="text-[10px] text-slate-400">{new Date(entry.createdAt).toLocaleDateString(i18n.resolvedLanguage ?? i18n.language)}</div>
                        {statusChange ? (
                          <div className="text-xs">
                            <span className="text-slate-400">{translateDynamic(t, `status.${statusChange.old}`, { ns: "common" })}</span>
                            <span className="text-slate-300 mx-1">&rarr;</span>
                            <span className={`font-medium ${statusColors[statusChange.new]?.split(" ")[1] || "text-slate-700"}`}>{translateDynamic(t, `status.${statusChange.new}`, { ns: "common" })}</span>
                          </div>
                        ) : (
                          <div className="text-xs text-slate-500">
                            {translateDynamic(tAdmin, auditActionKey(entry.action), {
                              defaultValue: auditFallbackLabel(entry.action),
                            })}
                          </div>
                        )}
                        <div className="text-[10px] text-slate-300">{entry.userName || entry.userUsername || tAdmin("auditLog.system")}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Renewal history badges */}
            {(r.parentRentalId || (renewals && renewals.length > 0)) && (
              <div className="mb-2 flex flex-wrap gap-2">
                {renewals && renewals.length > 0 && (() => {
                  const startMs = new Date(r.startDate).getTime();
                  const endMs = new Date(r.endDate).getTime();
                  const originalEndMs = renewals[0]
                    ? new Date(renewals[0].requestedEndDate).getTime() - (() => {
                        // Approximate: pull from reason "+Nd"
                        const m = /\+(\d+)\s*day/i.exec(renewals[0].reason ?? "");
                        return m ? parseInt(m[1], 10) * 86400000 : 0;
                      })()
                    : startMs;
                  const totalExtraDays = Math.max(
                    0,
                    Math.round((endMs - (originalEndMs || startMs)) / 86400000),
                  );
                  return (
                    <>
                      <span className="inline-flex items-center gap-1 text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2.5 py-0.5">
                        <RefreshCw size={10} /> {t("management.renewedTimes", {
                          count: renewals.length,
                          days: totalExtraDays,
                        })}
                      </span>
                      <button
                        onClick={() => {
                          const reason = prompt(t("management.undoRenewalConfirm"));
                          if (reason === null) return;
                          undoRenewMutation.mutate({ rentalId, reason: reason || undefined });
                        }}
                        disabled={undoRenewMutation.isPending}
                        className="inline-flex items-center gap-1 text-xs bg-white text-amber-700 border border-amber-300 rounded-full px-2.5 py-0.5 hover:bg-amber-50 disabled:opacity-50"
                        title={t("management.undoRenewalHint")}
                      >
                        <RotateCcw size={10} /> {undoRenewMutation.isPending ? "..." : t("management.undoRenewal")}
                      </button>
                    </>
                  );
                })()}
                {r.parentRentalId && (
                  <span className="inline-flex items-center gap-1 text-xs bg-slate-50 text-slate-600 border border-slate-200 rounded-full px-2.5 py-0.5">
                    <RefreshCw size={10} /> {t("management.renewalOf", { number: r.parentRentalId })}
                  </span>
                )}
              </div>
            )}

            {/* Inline renew panel */}
            {renewOpen && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 mb-2">
                <div className="text-sm font-semibold text-emerald-800 mb-2">{t("management.renewRental")}</div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-emerald-700">{t("management.renewNewEndDate")}</span>
                  <input
                    type="date"
                    value={renewEndDate}
                    min={r?.endDate ? new Date(r.endDate).toISOString().slice(0, 10) : undefined}
                    onChange={(e) => { setRenewEndDate(e.target.value); setRenewConflict(false); }}
                    className="text-xs border border-emerald-300 rounded px-2 py-1.5 bg-white text-slate-900"
                  />
                  <button
                    onClick={() => {
                      if (!renewEndDate) { toast.error(t("management.renewPickEndDate")); return; }
                      renewMutation.mutate({ sourceId: rentalId, newEndDate: renewEndDate });
                    }}
                    disabled={renewMutation.isPending}
                    className="text-xs px-4 py-1.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50"
                  >
                    {renewMutation.isPending ? t("management.creating") : t("management.confirmRenewal")}
                  </button>
                  <button
                    onClick={() => { setRenewOpen(false); setRenewConflict(false); }}
                    className="text-xs px-3 py-1.5 rounded bg-white text-slate-500 border border-slate-200 hover:bg-slate-50"
                  >
                    {t("management.cancel")}
                  </button>
                </div>
                {renewConflict && (
                  <div className="mt-2 flex items-center gap-2 flex-wrap bg-amber-50 border border-amber-200 rounded px-3 py-2">
                    <span className="text-xs text-amber-700">{t("management.renewConflictOverride")}</span>
                    <button
                      onClick={() => renewMutation.mutate({ sourceId: rentalId, newEndDate: renewEndDate, allowConflict: true })}
                      disabled={renewMutation.isPending}
                      className="text-xs px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700 font-medium disabled:opacity-50"
                    >
                      {t("management.renewForce")}
                    </button>
                  </div>
                )}
                <div className="text-xs text-emerald-600 mt-1.5">
                  {t("management.renewStartHint", {
                    date: r.endDate
                      ? formatCalendarDate(new Date(new Date(r.endDate).getTime() + 86400000), tz)
                      : t("management.theDayAfterEnd"),
                  })}
                </div>
              </div>
            )}

            {/* Tabs — horizontal scroll on mobile when overflowing */}
            <div className="flex gap-1 border-b border-slate-200 overflow-x-auto -mx-4 md:-mx-0 px-4 md:px-0">
              <button onClick={() => setActiveTab("overview")} className={tabClass("overview") + " shrink-0"}>{t("management.overview")}</button>
              <button onClick={() => setActiveTab("pricing")} className={tabClass("pricing") + " shrink-0"}>{t("management.pricing")}</button>
              <button onClick={() => setActiveTab("contract")} className={tabClass("contract") + " shrink-0"}>{t("management.contractDocs")}</button>
              {dispatchWorkflowEnabled && <button onClick={() => setActiveTab("dispatch")} className={tabClass("dispatch") + " shrink-0"}>{t("management.dispatch")}</button>}
              <button onClick={() => setActiveTab("inspections")} className={tabClass("inspections") + " shrink-0"}>{t("management.inspections")}</button>
              <button onClick={() => setActiveTab("history")} className={tabClass("history") + " shrink-0"}>{t("management.changeHistory")}</button>
            </div>
          </div>

          <div className="p-4 md:p-6">
            {/* Unhandled deposit on a finished order.
                The two buttons for this already live in the prepayments section
                of the overview tab — several scrolls down, on one tab out of
                six. That is why six finished orders were sitting on $11,250 of
                deposits nobody had converted or parked: the action was possible
                but never asked for. Once the order is over, the money is a
                loose end, so the loose end announces itself at the top of every
                tab until somebody resolves it. */}
            {isFinished && heldTotal > 0 && (
              <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1">
                  <div className="text-sm font-semibold text-amber-900">
                    {t("management.finishedHeldDepositTitle", { amount: formatCurrency(heldTotal) })}
                  </div>
                  <div className="text-xs text-amber-800 mt-0.5">{t("management.finishedHeldDepositHint")}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => {
                      if (window.confirm(t("management.transferDepositConfirm", { amount: formatCurrency(heldTotal) }))) {
                        transferDeposit.mutate({ rentalRequestId: rentalId });
                      }
                    }}
                    disabled={transferDeposit.isPending}
                    className="text-xs px-3 py-1.5 border border-amber-400 bg-white rounded-lg text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {transferDeposit.isPending ? t("saving", { ns: "common" }) : t("management.transferDeposit")}
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(t("management.convertToRentConfirm", { amount: formatCurrency(heldTotal) }))) {
                        convertToRent.mutate({ rentalRequestId: rentalId });
                      }
                    }}
                    disabled={convertToRent.isPending}
                    className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50"
                  >
                    {convertToRent.isPending ? t("saving", { ns: "common" }) : t("management.convertToRent")}
                  </button>
                </div>
              </div>
            )}

            {/* -- Overview Tab -- */}
            {activeTab === "overview" && (
              <div className="space-y-6">
                <RollingRentalOperations
                  rentalId={rentalId}
                  status={r.status}
                  endDate={r.endDate}
                  isCreditOrder={Boolean(r.isCreditOrder)}
                />
                <section>
                  <div className="mb-3 flex items-end justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-black uppercase tracking-[0.16em] text-slate-800">{t("assetProgress.lifecycle", { ns: "common" })}</h3>
                      <p className="mt-1 text-xs text-slate-400">{t("assetProgress.adminHint", { ns: "common" })}</p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-500">{t("management.liveRefresh", { seconds: 10 })}</span>
                  </div>
                  {rentalReadyForClose && (
                    <div className="mb-3 flex flex-col gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-950 sm:flex-row sm:items-center sm:justify-between" role="status">
                      <div>
                        <p className="text-sm font-black">{t("assetProgress.closeReadyTitle", { ns: "common" })}</p>
                        <p className="mt-1 text-xs leading-5 text-emerald-800">{t("assetProgress.closeReadyHint", { ns: "common" })}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setCloseOpen(true)}
                        className="shrink-0 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-800"
                      >
                        {t("assetProgress.closeReadyAction", { ns: "common" })}
                      </button>
                    </div>
                  )}
                  <AssetProgressPanel
                    items={assetProgress ?? []}
                    loading={assetProgressLoading}
                    isSuperAdmin={isSuperAdmin}
                    showConflictRentalLinks
                    onStartReturn={(item) => startAssetReturn.mutate({ rentalId, rentalFleetId: item.rentalFleetId })}
                    onConfirmPickup={(item) => confirmPhysicalPickup.mutate({ rentalId, rentalFleetId: item.rentalFleetId })}
                    onInspect={(item, type) => { setActiveTab("inspections"); setInspEditOpen({ mode: "create", type, fleetId: item.rentalFleetId }); }}
                    onBypass={async (item, inspectionType, reason) => {
                      await bypassAssetInspection.mutateAsync({ rentalId, rentalFleetId: item.rentalFleetId, inspectionType, reason });
                    }}
                  />
                </section>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="bg-slate-50 rounded-lg p-4 md:col-span-1">
                    <h3 className="text-sm font-semibold text-slate-500 uppercase mb-3">{t("management.customer")}</h3>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between"><span className="text-slate-500">{t("management.customerName")}</span><span className="text-slate-900 font-medium">{r.customerName}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">{t("management.customerEmail")}</span><span className="text-slate-900">{r.customerEmail || "-"}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">{t("management.customerPhone")}</span><span className="text-slate-900">{r.customerPhone || "-"}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">{t("management.customerCompany")}</span><span className="text-slate-900">{r.customerCompany || "-"}</span></div>
                    </div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-4 md:col-span-2">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-slate-500 uppercase">{t("management.equipment")}</h3>
                      {fleet && ["pending", "approved"].includes(r.status) && !swapOpen && (
                        <button
                          onClick={() => setSwapOpen(true)}
                          className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1"
                          title={t("management.swapHint")}
                        >
                          <RefreshCw size={12} /> {t("management.swapAsset")}
                        </button>
                      )}
                      {midSwapEnabled && !r.isCreditOrder && ["active", "overdue"].includes(r.status) && orderUnits.length > 0 && !midSwapOpen && (
                        <button
                          onClick={openMidSwap}
                          className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1"
                          title={t("management.midSwapHint")}
                        >
                          <RefreshCw size={12} /> {t("management.midSwapAsset")}
                        </button>
                      )}
                    </div>
                    <div className="space-y-2 text-sm">
                      {lineItems && lineItems.length > 1 ? (
                        <div className="space-y-2">
                          <p className="text-xs text-slate-500">{t("management.itemsBadge", { count: lineItems.length })}</p>
                          <ul className="divide-y divide-slate-200">
                            {lineItems.map((row) => (
                              <li key={row.line.id} className="py-2">
                                <div className="flex items-baseline gap-2 flex-wrap">
                                  <span className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${row.line.itemType === "attachment" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-700"}`}>
                                    {row.line.itemType === "attachment" ? t("management.itemTypeAttachment") : t("management.itemTypeMachine")}
                                  </span>
                                  <span className="font-medium text-slate-900">
                                    {row.fleet?.brand || row.model?.brand || "-"} {row.fleet?.model || row.model?.model || ""}
                                  </span>
                                  <span className="text-xs text-slate-500">{row.fleet?.category || row.model?.category || ""}</span>
                                  {row.fleet?.serialNumber && <span className="text-xs text-slate-400 font-mono">{row.fleet.serialNumber}</span>}
                                  {row.line.quantity > 1 && <span className="text-xs text-slate-500 ml-auto">× {row.line.quantity}</span>}
                                </div>
                                {/* Per-line rental period + subtotal (itemized) */}
                                <div className="flex justify-between gap-2 text-xs text-slate-500 mt-1">
                                  <span>
                                    {row.line.startDate && row.line.endDate
                                      ? `${fmtDate(row.line.startDate)} – ${fmtDate(row.line.endDate)}`
                                      : t("management.lineUsesOrderDates", "Order dates")}
                                  </span>
                                  {row.line.lineSubtotal != null && (
                                    <span className="text-slate-900 font-medium whitespace-nowrap">{formatCurrency(Number(row.line.lineSubtotal))}</span>
                                  )}
                                </div>
                                {row.line.customerEquipmentNote && <p className="text-xs text-amber-700 italic mt-1">{t("management.customerMachineNote", { note: row.line.customerEquipmentNote })}</p>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : fleet ? (
                        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
                          <dt className="text-slate-500">{t("management.brand")}</dt><dd className="text-slate-900 font-medium">{fleet.brand}</dd>
                          <dt className="text-slate-500">{t("management.model")}</dt><dd className="text-slate-900">{fleet.model}</dd>
                          <dt className="text-slate-500">{t("management.category")}</dt><dd className="text-slate-900">{fleet.category || "-"}</dd>
                          {fleet.serialNumber && <><dt className="text-slate-500">{t("management.serialNumber")}</dt><dd className="text-slate-900">{fleet.serialNumber}</dd></>}
                        </dl>
                      ) : (
                        <p className="text-slate-400">{t("management.noEquipment")}</p>
                      )}
                    </div>

                    {swapOpen && (
                      <div className="mt-4 pt-4 border-t border-slate-200 space-y-3">
                        <p className="text-xs text-slate-500">{t("management.swapHint")}</p>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("management.swapTarget")}</label>
                          <select
                            value={swapTargetId === "" ? "" : String(swapTargetId)}
                            onChange={(e) => setSwapTargetId(e.target.value ? Number(e.target.value) : "")}
                            className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                          >
                            <option value="">{t("management.swapPickAsset")}</option>
                            {swapCandidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.serialNumber || `#${c.id}`} — {c.brand} {c.model}{c.year ? ` · ${c.year}` : ""}
                              </option>
                            ))}
                          </select>
                          {swapCandidatesData && swapCandidates.length === 0 && (
                            <p className="text-xs text-amber-600 mt-1">{t("management.swapNoCandidates")}</p>
                          )}
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("management.swapReason")} *</label>
                          <input
                            type="text"
                            value={swapReason}
                            onChange={(e) => setSwapReason(e.target.value)}
                            placeholder={t("management.swapReasonPlaceholder")}
                            className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                            maxLength={500}
                          />
                        </div>
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => { setSwapOpen(false); setSwapTargetId(""); setSwapReason(""); }}
                            className="px-3 py-1.5 text-xs rounded border border-slate-300 text-slate-700 hover:bg-slate-100"
                          >
                            {t("management.cancel")}
                          </button>
                          <button
                            onClick={() => {
                              if (typeof swapTargetId !== "number") return;
                              if (!swapReason.trim()) {
                                toast.error(t("management.swapReasonRequired"));
                                return;
                              }
                              swapFleet.mutate({
                                rentalRequestId: rentalId,
                                newRentalFleetId: swapTargetId,
                                reason: swapReason.trim(),
                              });
                            }}
                            disabled={swapFleet.isPending || typeof swapTargetId !== "number" || !swapReason.trim()}
                            className="px-3 py-1.5 text-xs rounded bg-[var(--primary)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {swapFleet.isPending ? t("management.swapping") : t("management.swapConfirm")}
                          </button>
                        </div>
                      </div>
                    )}

                    {midSwapOpen && (
                      <div className="mt-4 pt-4 border-t border-slate-200 space-y-3">
                        <p className="text-xs text-slate-500">{t("management.midSwapHint")}</p>
                        {orderUnits.length > 1 && (
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">{t("management.midSwapOldUnit")} *</label>
                            <select
                              value={midSwap.oldFleetId === "" ? "" : String(midSwap.oldFleetId)}
                              onChange={(e) => setMidSwap({ ...midSwap, oldFleetId: e.target.value ? Number(e.target.value) : "", newFleetId: "" })}
                              className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                            >
                              <option value="">{t("management.midSwapPickOldUnit")}</option>
                              {orderUnits.map((u) => (
                                <option key={u.id} value={u.id}>{u.label}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("management.midSwapNewUnit")} *</label>
                          <select
                            value={midSwap.newFleetId === "" ? "" : String(midSwap.newFleetId)}
                            onChange={(e) => setMidSwap({ ...midSwap, newFleetId: e.target.value ? Number(e.target.value) : "" })}
                            className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                            disabled={typeof midSwap.oldFleetId !== "number"}
                          >
                            <option value="">{midSwapCandLoading ? t("management.loading", { ns: "common", defaultValue: "Loading…" }) : t("management.swapPickAsset")}</option>
                            {(midSwapCandData?.candidates ?? []).map((c) => {
                              const curDaily = parseFloat(midSwapCandData?.current?.rates.dailyRate || "0");
                              const candDaily = parseFloat(c.rates.dailyRate || "0");
                              const diff = candDaily - curDaily;
                              const diffLabel = !c.sameModel && curDaily > 0 && candDaily > 0 && diff !== 0
                                ? ` (${diff > 0 ? "+" : "−"}$${Math.abs(diff).toFixed(0)}/${t("management.midSwapPerDay")})`
                                : "";
                              return (
                                <option key={c.id} value={c.id}>
                                  {c.sameModel ? "★ " : ""}{c.serialNumber || `#${c.id}`} — {c.brand} {c.model}{c.year ? ` · ${c.year}` : ""}{diffLabel}
                                </option>
                              );
                            })}
                          </select>
                          {midSwapCandData && (midSwapCandData.candidates ?? []).length === 0 && !midSwapCandLoading && (
                            <p className="text-xs text-amber-600 mt-1">{t("management.swapNoCandidates")}</p>
                          )}
                          <p className="text-[11px] text-slate-400 mt-1">{t("management.midSwapSameModelHint")}</p>
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("management.midSwapReasonType")} *</label>
                          <div className="flex gap-2">
                            {(["equipment_fault", "customer_fault", "other"] as const).map((rt) => (
                              <button
                                key={rt}
                                type="button"
                                onClick={() => setMidSwap({ ...midSwap, reasonType: rt, createWorkOrder: rt === "equipment_fault" ? true : midSwap.createWorkOrder })}
                                className={`flex-1 px-2 py-1.5 rounded border text-xs ${
                                  midSwap.reasonType === rt
                                    ? "border-[var(--primary)] bg-[var(--primary)]/5 text-[var(--primary)] font-medium"
                                    : "border-slate-300 text-slate-600 hover:bg-slate-100"
                                }`}
                              >
                                {t(`management.midSwapReason_${rt}`)}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">{t("management.swapReason")} *</label>
                          <textarea
                            value={midSwap.reason}
                            onChange={(e) => setMidSwap({ ...midSwap, reason: e.target.value })}
                            placeholder={t("management.midSwapReasonPlaceholder")}
                            className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                            rows={2}
                            maxLength={1000}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">
                              {t("management.midSwapCharge")}
                              {midSwap.reasonType === "customer_fault" && (
                                <span className="text-amber-600 ml-1">{t("management.midSwapChargeSuggested")}</span>
                              )}
                            </label>
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={midSwap.chargeAmount}
                              onChange={(e) => setMidSwap({ ...midSwap, chargeAmount: e.target.value })}
                              placeholder="0.00"
                              className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                            />
                            {midSwapDiff && midSwapDiff.perDay > 0 && (
                              midSwap.reasonType === "equipment_fault" ? (
                                <p className="text-[11px] text-emerald-600 mt-1">
                                  {t("management.midSwapDiffWaived", { perDay: midSwapDiff.perDay.toFixed(0) })}
                                </p>
                              ) : (
                                <p className="text-[11px] text-amber-600 mt-1">
                                  {t("management.midSwapDiffSuggested", { total: midSwapDiff.total.toFixed(2), days: midSwapDiff.remainingDays, perDay: midSwapDiff.perDay.toFixed(0) })}
                                </p>
                              )
                            )}
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">{t("management.midSwapChargeDesc")}</label>
                            <input
                              type="text"
                              value={midSwap.chargeDescription}
                              onChange={(e) => setMidSwap({ ...midSwap, chargeDescription: e.target.value })}
                              className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                              maxLength={1000}
                            />
                          </div>
                        </div>
                        <div className="flex gap-4">
                          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={midSwap.createWorkOrder}
                              onChange={(e) => setMidSwap({ ...midSwap, createWorkOrder: e.target.checked })}
                              className="rounded border-slate-300"
                            />
                            {t("management.midSwapCreateWorkOrder")}
                          </label>
                          <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={midSwap.createDispatch}
                              onChange={(e) => setMidSwap({ ...midSwap, createDispatch: e.target.checked })}
                              className="rounded border-slate-300"
                            />
                            {t("management.midSwapCreateDispatch")}
                          </label>
                        </div>
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => { setMidSwapOpen(false); setMidSwap(emptyMidSwap); }}
                            className="px-3 py-1.5 text-xs rounded border border-slate-300 text-slate-700 hover:bg-slate-100"
                          >
                            {t("management.cancel")}
                          </button>
                          <button
                            onClick={() => {
                              if (typeof midSwap.oldFleetId !== "number" || typeof midSwap.newFleetId !== "number") return;
                              if (!midSwap.reason.trim()) {
                                toast.error(t("management.swapReasonRequired"));
                                return;
                              }
                              midRentalSwap.mutate({
                                rentalRequestId: rentalId,
                                oldRentalFleetId: midSwap.oldFleetId,
                                newRentalFleetId: midSwap.newFleetId,
                                reasonType: midSwap.reasonType,
                                reason: midSwap.reason.trim(),
                                chargeAmount: midSwap.chargeAmount && parseFloat(midSwap.chargeAmount) > 0 ? midSwap.chargeAmount : undefined,
                                chargeDescription: midSwap.chargeDescription.trim() || undefined,
                                createWorkOrder: midSwap.createWorkOrder,
                                createDispatch: midSwap.createDispatch,
                              });
                            }}
                            disabled={midRentalSwap.isPending || typeof midSwap.oldFleetId !== "number" || typeof midSwap.newFleetId !== "number" || !midSwap.reason.trim()}
                            className="px-3 py-1.5 text-xs rounded bg-[var(--primary)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {midRentalSwap.isPending ? t("management.swapping") : t("management.midSwapConfirm")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-slate-50 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-slate-500 uppercase">{t("management.rentalPeriod")}</h3>
                    {["pending", "approved"].includes(r.status) && !editingDates && (
                      <button
                        onClick={() => {
                          setEditingDates(true);
                          setEditStartDate(r.startDate ? formatCalendarDateISO(r.startDate) : "");
                          setEditEndDate(r.endDate ? formatCalendarDateISO(r.endDate) : "");
                        }}
                        className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1"
                      >
                        <Calendar size={12} /> {t("management.editDates")}
                      </button>
                    )}
                  </div>

                  {editingDates ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.start")}</label>
                          <input type="date" value={editStartDate} onChange={(e) => setEditStartDate(e.target.value)}
                            className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.end")}</label>
                          <input type="date" value={editEndDate} onChange={(e) => setEditEndDate(e.target.value)}
                            className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900" />
                        </div>
                      </div>

                      {/* Price change preview */}
                      {datesChanged && pricePreview && (
                        <div className="bg-white rounded-lg border border-amber-200 p-3 space-y-2">
                          <div className="text-xs font-semibold text-amber-700 flex items-center gap-1">
                            <ArrowRight size={12} /> {t("management.pricePreview")}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                            <div>
                              <span className="text-slate-400 block">{t("management.rentalFee")}</span>
                              <span className="text-slate-500 line-through">{formatCurrency(pricePreview.old.rentalFee)}</span>
                              <span className="text-slate-900 font-medium ml-1">{formatCurrency(pricePreview.new.rentalFee)}</span>
                            </div>
                            <div>
                              <span className="text-slate-400 block">{t("management.tax")}</span>
                              <span className="text-slate-500 line-through">{formatCurrency(pricePreview.old.taxAmount)}</span>
                              <span className="text-slate-900 font-medium ml-1">{formatCurrency(pricePreview.new.taxAmount)}</span>
                            </div>
                            <div>
                              <span className="text-slate-400 block">{t("management.total")}</span>
                              <span className="text-slate-500 line-through">{formatCurrency(pricePreview.old.totalAmount)}</span>
                              <span className={`font-bold ml-1 ${pricePreview.diff.totalAmount > 0 ? "text-[var(--primary)]" : "text-green-600"}`}>
                                {formatCurrency(pricePreview.new.totalAmount)}
                              </span>
                            </div>
                          </div>
                          <div className="text-xs text-slate-500">
                            {pricePreview.old.days} → {pricePreview.new.days} {t("management.days")} ({pricePreview.diff.days > 0 ? "+" : ""}{pricePreview.diff.days})
                            {" · "}
                            {pricePreview.diff.totalAmount > 0 ? "+" : ""}{formatCurrency(pricePreview.diff.totalAmount)}
                          </div>
                        </div>
                      )}
                      {previewLoading && <div className="text-xs text-slate-400">{t("loading", { ns: "common" })}</div>}

                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            updateRental.mutate({
                              id: rentalId,
                              startDate: editStartDate,
                              endDate: editEndDate,
                              recalculatePricing: true,
                            }, {
                              onSuccess: () => setEditingDates(false),
                            });
                          }}
                          disabled={!datesChanged || updateRental.isPending}
                          className="btn-primary text-xs px-3 py-1.5"
                        >
                          {updateRental.isPending ? t("saving", { ns: "common" }) : t("management.saveDates")}
                        </button>
                        <button onClick={() => setEditingDates(false)} className="btn-secondary text-xs px-3 py-1.5">
                          {t("cancel", { ns: "common" })}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div><span className="text-slate-400 block text-xs">{t("management.start")}</span><span className="text-slate-900 font-medium">{fmtDate(r.startDate)}</span></div>
                        <div><span className="text-slate-400 block text-xs">{t("management.end")}</span><span className="text-slate-900 font-medium">{fmtDate(r.endDate)}</span></div>
                        <div><span className="text-slate-400 block text-xs">{t("management.duration")}</span><span className="text-slate-900 font-medium">{days} {t("management.days")}</span></div>
                        <div>
                          <span className="text-slate-400 block text-xs">{t("management.delivery")}</span>
                          <span className="text-slate-900 font-medium">
                            {r.deliveryMethod === "delivery_and_return"
                              ? t("management.deliveryReturnOption")
                              : r.deliveryMethod === "delivery"
                                ? t("management.deliveryOption")
                                : t("management.pickupOption")}
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                  {r.deliveryAddress && <p className="text-sm text-slate-600 mt-2">{t("management.deliveryAddress")} {r.deliveryAddress}</p>}
                  {r.projectDescription && <p className="text-sm text-slate-600 mt-1">{t("management.project")} {r.projectDescription}</p>}
                </div>

                {/* Notes — customer + admin (read-only here; admin editable in Contract & Docs tab) */}
                {(r.customerNotes || r.adminNotes) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-amber-800 uppercase mb-3">{t("management.notesSection")}</h3>
                    <div className="space-y-3 text-sm">
                      {r.customerNotes && (
                        <div>
                          <div className="text-xs font-semibold text-slate-500 mb-1">{t("management.notesCustomer")}</div>
                          <p className="text-slate-800 whitespace-pre-wrap">{r.customerNotes}</p>
                        </div>
                      )}
                      {r.adminNotes && (
                        <div>
                          <div className="text-xs font-semibold text-slate-500 mb-1">{t("management.notesAdmin")}</div>
                          <p className="text-slate-800 whitespace-pre-wrap">{r.adminNotes}</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Quick price summary */}
                <div className="bg-slate-50 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-slate-500 uppercase mb-3">{t("management.priceSummary")}</h3>
                  <div className="grid grid-cols-3 md:grid-cols-6 gap-3 text-sm">
                    <div><span className="text-slate-400 block text-xs">{t("management.rental")}</span><span className="font-medium">{r.rentalFee ? formatCurrency(parseFloat(r.rentalFee)) : "-"}</span></div>
                    <div><span className="text-slate-400 block text-xs">{t("management.freight")}</span><span className="font-medium">{r.freightCost ? formatCurrency(parseFloat(r.freightCost)) : "-"}</span></div>
                    <div><span className="text-slate-400 block text-xs">{t("management.insurance")}</span><span className="font-medium">{r.insuranceCost ? formatCurrency(parseFloat(r.insuranceCost)) : "-"}</span></div>
                    <div><span className="text-slate-400 block text-xs">{t("management.tax")}</span><span className="font-medium">{r.taxAmount ? formatCurrency(parseFloat(r.taxAmount)) : "-"}</span></div>
                    <div><span className="text-slate-400 block text-xs">{t("management.deposit")}</span><span className="font-medium">{r.depositAmount ? formatCurrency(parseFloat(r.depositAmount)) : "-"}</span></div>
                    <div><span className="text-slate-400 block text-xs">{t("management.total")}</span><span className="font-bold text-[var(--primary)]">{r.totalAmount ? formatCurrency(parseFloat(r.totalAmount)) : "-"}</span></div>
                  </div>

                  {/* Extra charges (fuel/damage/…) are billed on top of the base
                      total — show them + the true amount owed so the balance below
                      is self-explanatory. */}
                  {extraChargesOwed > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-200 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                      <div>
                        <span className="text-slate-400 block text-xs">{t("management.extraChargesOwed")}</span>
                        <span className="font-medium text-slate-900">+{formatCurrency(extraChargesOwed)}</span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-xs">{t("management.amountOwed")}</span>
                        <span className="font-bold text-[var(--primary)]">{formatCurrency(amountOwed)}</span>
                      </div>
                    </div>
                  )}

                  {/* Prepaid + balance row */}
                  {(prepaidTotal > 0 || totalAmount > 0) && (
                    <div className="mt-3 pt-3 border-t border-slate-200 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                      <div>
                        <span className="text-slate-400 block text-xs">{t("management.prepaidTotal")}</span>
                        <span className="font-medium text-emerald-700">{formatCurrency(appliedTotal)}</span>
                        {heldTotal > 0 && (
                          <span className="block text-xs text-amber-600">{t("management.heldPending")}: {formatCurrency(heldTotal)}</span>
                        )}
                      </div>
                      <div>
                        <span className="text-slate-400 block text-xs">{t("management.balance")}</span>
                        {balance > 0 ? (
                          <span className="font-bold text-[var(--primary)]">
                            {formatCurrency(balance)} <span className="text-xs font-normal text-slate-500">· {t("management.balanceDue")}</span>
                          </span>
                        ) : balance < 0 ? (
                          <span className="font-bold text-amber-700">
                            {formatCurrency(Math.abs(balance))} <span className="text-xs font-normal text-slate-500">· {t("management.balanceRefund")}</span>
                          </span>
                        ) : (
                          <span className="font-bold text-emerald-700">{formatCurrency(0)}</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Late fee badge — gated by late_fee_auto feature flag */}
                  {showLateFee && r.estimatedLateFee && parseFloat(r.estimatedLateFee) > 0 && (
                    <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-100 border border-red-300 text-red-700 text-sm font-semibold">
                      <span className="text-red-500">&#9888;</span>
                      {t("management.estimatedLateFee", { amount: formatCurrency(parseFloat(r.estimatedLateFee)) })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* -- Pricing Tab -- */}
            {activeTab === "pricing" && (
              <div className="space-y-6">
                {/* This order's price is a manual Override — label it with the
                    specific components that changed (system value → entered) + reason. */}
                {r.priceMatchEnabled && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
                    <div>
                      <span className="font-semibold text-amber-800">{t("management.priceOverridden")}</span>
                      {r.priceMatchNote && <span className="text-amber-700"> · {r.priceMatchNote}</span>}
                      {r.priceMatchCompetitor && <span className="text-amber-700"> · {r.priceMatchCompetitor}</span>}
                    </div>
                    {(() => {
                      const lines = overrideFieldLines(r.priceMatchFields, t, (n) => formatCurrency(n));
                      if (!lines.length) return null;
                      return (
                        <ul className="mt-1.5 space-y-0.5 text-amber-800">
                          {lines.map((l) => (
                            <li key={l.field} className="flex items-center gap-2">
                              <span className="font-medium">{l.label}</span>
                              <span className="text-amber-600">{l.from}</span>
                              <span className="text-amber-400">→</span>
                              <span className="font-semibold">{l.to}</span>
                            </li>
                          ))}
                        </ul>
                      );
                    })()}
                  </div>
                )}
                {/* Delivery order with no address → freight couldn't be computed
                    at all; prompt staff to add the address and verify freight. */}
                {r.deliveryMethod !== "pickup" && !r.deliveryAddress?.trim() ? (
                  <div className="bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-sm text-amber-800 flex items-center gap-2">
                    <span className="text-amber-500">&#9888;</span>
                    <span>{t("management.freightNoAddressWarning")}</span>
                  </div>
                ) : r.freightEstimated && (
                  /* Freight charged at the lowest bracket because the distance was
                     unknown — prompt staff to verify it before invoicing. */
                  <div className="bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 text-sm text-amber-800 flex items-center gap-2">
                    <span className="text-amber-500">&#9888;</span>
                    <span>{t("management.freightEstimatedWarning")}</span>
                  </div>
                )}
                {/* Prices are locked to the system/saved values. Editing requires
                    an explicit Override + a recorded reason (audited). */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={priceOverride} onChange={(e) => setPriceOverride(e.target.checked)} className="rounded border-slate-300" />
                    <span className="font-medium">{t("management.overridePrice")}</span>
                  </label>
                  {priceOverride && (
                    <>
                      {activeInvoice && (
                        <p className="text-sm text-amber-800 font-medium">{t("management.invoicedNotice", { number: activeInvoice.invoiceNumber })}</p>
                      )}
                      <label className="block text-xs text-slate-500">{t("management.editReason")} <span className="text-red-600">*</span></label>
                      <input
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                        placeholder={t("management.editReasonPlaceholder")}
                      />
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {[
                    { label: t("management.rentalFee"), value: editRentalFee, set: setEditRentalFee, original: r.rentalFee },
                    { label: t("management.freight"), value: editFreight, set: setEditFreight, original: r.freightCost },
                    { label: t("management.insurance"), value: editInsurance, set: setEditInsurance, original: r.insuranceCost },
                    { label: t("management.tax"), value: editTax, set: setEditTax, original: r.taxAmount },
                    { label: t("management.deposit"), value: editDeposit, set: setEditDeposit, original: r.depositAmount },
                  ].map(({ label, value, set, original }) => (
                    <div key={label} className="bg-slate-50 rounded-lg p-3">
                      <label className="block text-xs text-slate-400 mb-1">{label}</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                        <input
                          type="number"
                          step="0.01"
                          value={value}
                          onChange={(e) => set(e.target.value)}
                          disabled={!priceOverride}
                          className="w-full bg-white border border-slate-300 rounded px-2 py-2 pl-7 text-sm text-slate-900 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
                        />
                      </div>
                      {original && value !== original && (
                        <p className="text-xs text-slate-400 mt-1">{t("management.original")} {formatCurrency(parseFloat(original))}</p>
                      )}
                    </div>
                  ))}
                  <div className="bg-[var(--primary)]/10 rounded-lg p-3">
                    <label className="block text-xs text-[var(--primary)] mb-1">{t("management.autoTotal")}</label>
                    <div className="text-xl font-bold text-[var(--primary)] py-1">
                      {formatCurrency(calcTotal())}
                    </div>
                    {r.totalAmount && calcTotal().toFixed(2) !== parseFloat(r.totalAmount).toFixed(2) && (
                      <p className="text-xs text-slate-400 mt-1">{t("management.savedAmount", { amount: formatCurrency(parseFloat(r.totalAmount)) })}</p>
                    )}
                  </div>
                </div>
                {r.taxBreakdown && <p className="text-xs text-slate-400">{t("management.taxBreakdown")} {r.taxBreakdown}</p>}
                {r.insuranceType && <p className="text-xs text-slate-400">{t("management.insuranceType")} {r.insuranceType}</p>}

                <button onClick={savePricing} disabled={updateRental.isPending} className="btn-primary text-sm">
                  {updateRental.isPending ? t("saving", { ns: "common" }) : t("management.savePricing")}
                </button>

                {/* Extra charges (额外收费): fuel / damage / cleaning / etc. */}
                <div className="bg-slate-50 rounded-lg p-4 mt-4">
                  <h3 className="text-sm font-semibold text-slate-500 uppercase mb-3">{t("management.extraCharges")}</h3>
                  {extraCharges && extraCharges.length > 0 ? (
                    <ul className="divide-y divide-slate-200 mb-3 bg-white rounded border border-slate-200">
                      {extraCharges.map((c) => {
                        const claim = c.damage_claims;
                        const ct = (claim.chargeType ?? "damage") as keyof typeof EXTRA_CHARGE_LABELS;
                        const amt = claim.approvedAmount ?? claim.amount ?? claim.repairEstimate;
                        // Mirror the server guard so the buttons are disabled up
                        // front rather than failing after the click.
                        const billed = claim.invoiceId != null || claim.status === "invoiced";
                        const orderClosed = r.status === "completed" || r.status === "cancelled";
                        const locked = billed || orderClosed;
                        const lockHint = billed
                          ? t("management.chargeLockedInvoiced")
                          : orderClosed ? t("management.chargeLockedClosed") : undefined;
                        const isEditing = editingCharge?.id === claim.id;
                        const isDeleting = deletingCharge?.id === claim.id;
                        return (
                          <li key={claim.id} className="px-3 py-2 text-sm">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-slate-700 w-24 shrink-0">{EXTRA_CHARGE_LABELS[ct]?.[lang] ?? ct}</span>
                              <span className="font-semibold text-slate-900 w-20 shrink-0">{amt ? formatCurrency(parseFloat(amt)) : "-"}</span>
                              <span className="text-xs text-slate-500 flex-1 truncate">{claim.description}</span>
                              <span className="text-[10px] text-slate-400 shrink-0">
                                {CLAIM_STATUS_LABELS[claim.status]?.[lang] ?? claim.status}
                                {claim.invoiceId ? (lang === "zh" ? " · 已开票" : " · Invoiced") : ""}
                              </span>
                              <button
                                type="button"
                                disabled={locked}
                                title={lockHint}
                                onClick={() => {
                                  setDeletingCharge(null);
                                  setEditingCharge({
                                    id: claim.id,
                                    amount: amt ?? "",
                                    description: claim.description ?? "",
                                    reason: "",
                                    reasonNote: "",
                                  });
                                }}
                                className="text-xs text-[var(--primary)] hover:underline disabled:text-slate-300 disabled:no-underline disabled:cursor-not-allowed shrink-0"
                              >
                                {t("edit", { ns: "common" })}
                              </button>
                              <button
                                type="button"
                                disabled={locked || !canDeleteCharge}
                                title={!canDeleteCharge ? t("management.chargeDeleteNoPermission") : lockHint}
                                onClick={() => {
                                  setEditingCharge(null);
                                  setDeletingCharge({ id: claim.id, reason: "", reasonNote: "" });
                                }}
                                className="text-xs text-red-600 hover:underline disabled:text-slate-300 disabled:no-underline disabled:cursor-not-allowed shrink-0"
                              >
                                {t("delete", { ns: "common" })}
                              </button>
                              {/* Once billed, the charge can no longer be edited or
                                  deleted — the issued invoice must not change. Waiving
                                  it issues a credit note instead, so this is the only
                                  action left on an invoiced charge. */}
                              {billed && !orderClosed && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingCharge(null);
                                    setDeletingCharge(null);
                                    setWaivingCharge({ id: claim.id, amount: amt ?? "", reason: "waived", reasonNote: "" });
                                  }}
                                  className="text-xs text-amber-700 hover:underline shrink-0"
                                >
                                  {t("management.waiveCharge")}
                                </button>
                              )}
                            </div>

                            {isEditing && editingCharge && (
                              <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-3 grid grid-cols-2 gap-2">
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">{t("management.chargeAmount")}</label>
                                  <input
                                    type="number" step="0.01" min="0"
                                    value={editingCharge.amount}
                                    onChange={(e) => setEditingCharge({ ...editingCharge, amount: e.target.value })}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">{t("editReason.label", { ns: "common" })}</label>
                                  <select
                                    value={editingCharge.reason}
                                    onChange={(e) => setEditingCharge({ ...editingCharge, reason: e.target.value as EditReason | "" })}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm"
                                  >
                                    <option value="">{t("editReason.required", { ns: "common" })}</option>
                                    {EDIT_REASONS.map((er) => (
                                      <option key={er} value={er}>{t(`editReason.${er}`, { ns: "common" })}</option>
                                    ))}
                                  </select>
                                </div>
                                <div className="col-span-2">
                                  <label className="block text-xs text-slate-400 mb-1">{t("management.chargeDescription")}</label>
                                  <input
                                    value={editingCharge.description}
                                    onChange={(e) => setEditingCharge({ ...editingCharge, description: e.target.value })}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm"
                                  />
                                </div>
                                <div className="col-span-2">
                                  <input
                                    value={editingCharge.reasonNote}
                                    onChange={(e) => setEditingCharge({ ...editingCharge, reasonNote: e.target.value })}
                                    placeholder={t("editReason.notePlaceholder", { ns: "common" })}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm"
                                  />
                                </div>
                                <div className="col-span-2 flex gap-2">
                                  <button onClick={submitChargeEdit} disabled={updateExtraCharge.isPending} className="btn-primary text-sm">
                                    {updateExtraCharge.isPending ? t("saving", { ns: "common" }) : t("save", { ns: "common" })}
                                  </button>
                                  <button onClick={() => setEditingCharge(null)} className="btn-secondary text-sm">
                                    {t("cancel", { ns: "common" })}
                                  </button>
                                </div>
                              </div>
                            )}

                            {isDeleting && deletingCharge && (
                              <div className="mt-2 rounded border border-red-200 bg-red-50 p-3 grid grid-cols-2 gap-2">
                                <p className="col-span-2 text-xs text-red-700">{t("management.confirmDeleteCharge")}</p>
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">{t("editReason.label", { ns: "common" })}</label>
                                  <select
                                    value={deletingCharge.reason}
                                    onChange={(e) => setDeletingCharge({ ...deletingCharge, reason: e.target.value as EditReason | "" })}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm"
                                  >
                                    <option value="">{t("editReason.required", { ns: "common" })}</option>
                                    {EDIT_REASONS.map((er) => (
                                      <option key={er} value={er}>{t(`editReason.${er}`, { ns: "common" })}</option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <label className="block text-xs text-slate-400 mb-1">&nbsp;</label>
                                  <input
                                    value={deletingCharge.reasonNote}
                                    onChange={(e) => setDeletingCharge({ ...deletingCharge, reasonNote: e.target.value })}
                                    placeholder={t("editReason.notePlaceholder", { ns: "common" })}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm"
                                  />
                                </div>
                                <div className="col-span-2 flex gap-2">
                                  <button onClick={submitChargeDelete} disabled={deleteExtraCharge.isPending} className="btn-primary text-sm bg-red-600 hover:bg-red-700">
                                    {deleteExtraCharge.isPending ? t("saving", { ns: "common" }) : t("delete", { ns: "common" })}
                                  </button>
                                  <button onClick={() => setDeletingCharge(null)} className="btn-secondary text-sm">
                                    {t("cancel", { ns: "common" })}
                                  </button>
                                </div>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-400 mb-3">{t("management.noExtraCharges")}</p>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.chargeReason")}</label>
                      <select value={extraChargeForm.chargeType} onChange={(e) => setExtraChargeForm({ ...extraChargeForm, chargeType: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm">
                        {EXTRA_CHARGE_REASONS.map((r) => <option key={r} value={r}>{EXTRA_CHARGE_LABELS[r][lang]}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.chargeAmount")}</label>
                      <input type="number" step="0.01" min="0" value={extraChargeForm.amount} onChange={(e) => setExtraChargeForm({ ...extraChargeForm, amount: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm" />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-slate-400 mb-1">{t("management.chargeDescription")}</label>
                      <input value={extraChargeForm.description} onChange={(e) => setExtraChargeForm({ ...extraChargeForm, description: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm" />
                    </div>
                    <button onClick={submitExtraCharge} disabled={addExtraCharge.isPending} className="btn-secondary text-sm col-span-2 md:col-span-4">{t("management.addCharge")}</button>
                  </div>
                  <p className="text-xs text-slate-400 mt-2">{t("management.extraChargesHint")}</p>
                </div>

                {/* Insurance Documents */}
                <div className="bg-slate-50 rounded-lg p-4 mt-4">
                  <h3 className="text-sm font-semibold text-slate-500 uppercase mb-3">{t("management.insuranceDocs")}</h3>
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={r.insuranceDocsReceived ?? false}
                      onChange={(e) => {
                        updateRental.mutate({ id: rentalId, insuranceDocsReceived: e.target.checked });
                      }}
                      className="w-5 h-5 rounded border-slate-300 text-[var(--primary)] focus:ring-[var(--primary)]"
                    />
                    <span className="text-sm text-slate-700">{t("management.insuranceDocsReceived")}</span>
                  </label>
                  <p className="text-xs text-slate-400 mt-1">{t("management.insuranceDocsHint")}</p>
                </div>

                {/* Security deposit collection — the only business entry point that
                    flips depositPaid. Drives the deposit-liability report and the
                    customer-portal deposit balance (both count only collected
                    deposits). Mirrors the insurance-docs toggle above. */}
                <div className="bg-slate-50 rounded-lg p-4 mt-4">
                  <h3 className="text-sm font-semibold text-slate-500 uppercase mb-3">{t("management.depositCollection")}</h3>
                  {r.depositAmount && parseFloat(r.depositAmount) > 0 ? (
                    <>
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={r.depositPaid ?? false}
                          onChange={(e) => {
                            updateRental.mutate({ id: rentalId, depositPaid: e.target.checked });
                          }}
                          className="w-5 h-5 rounded border-slate-300 text-[var(--primary)] focus:ring-[var(--primary)]"
                        />
                        <span className="text-sm text-slate-700">
                          {t("management.depositCollected")}
                          <span className="ml-1 font-medium text-slate-900">({formatCurrency(parseFloat(r.depositAmount))})</span>
                        </span>
                      </label>
                      <p className="text-xs text-slate-400 mt-1">{t("management.depositCollectedHint")}</p>
                    </>
                  ) : (
                    <p className="text-xs text-slate-400">{t("management.depositNotApplicable")}</p>
                  )}
                </div>

                {/* Prepayments ledger */}
                <div className="bg-slate-50 rounded-lg p-4 mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-slate-500 uppercase">{t("management.prepayments")}</h3>
                    <div className="text-sm">
                      <span className="text-slate-400">{t("management.appliedToRent")}: </span>
                      <span className="font-bold text-emerald-700">{formatCurrency(appliedTotal)}</span>
                      {heldTotal > 0 && (
                        <>
                          <span className="text-slate-300 mx-2">·</span>
                          <span className="text-slate-400">{t("management.heldPending")}: </span>
                          <span className="font-bold text-amber-600">{formatCurrency(heldTotal)}</span>
                        </>
                      )}
                      {refundedTotal > 0 && (
                        <>
                          <span className="text-slate-300 mx-2">·</span>
                          <span className="text-slate-400">{t("management.statusRefund")}: </span>
                          <span className="font-bold text-rose-600">{formatCurrency(refundedTotal)}</span>
                        </>
                      )}
                      {totalAmount > 0 && (
                        <>
                          <span className="text-slate-300 mx-2">·</span>
                          <span className="text-slate-400">{t("management.balance")}: </span>
                          {balance > 0 ? (
                            <span className="font-bold text-[var(--primary)]">{formatCurrency(balance)}</span>
                          ) : balance < 0 ? (
                            <span className="font-bold text-amber-700">-{formatCurrency(Math.abs(balance))}</span>
                          ) : (
                            <span className="font-bold text-emerald-700">{formatCurrency(0)}</span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-slate-400 mb-3">{t("management.prepaymentsHint")}</p>

                  {/* 预付款转租金 — manual step: convert all held prepayments to
                      rent (settles the invoice). Always shown once there are any
                      prepayments so the button is discoverable; disabled when
                      nothing is held (e.g. everything already converted). */}
                  {prepayments && prepayments.length > 0 && (
                    <div className={`mb-3 flex items-center justify-between gap-2 rounded px-3 py-2 border ${heldTotal > 0 ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200"}`}>
                      <span className={`text-xs ${heldTotal > 0 ? "text-amber-700" : "text-slate-400"}`}>
                        {heldTotal > 0 ? t("management.convertToRentHint", { amount: formatCurrency(heldTotal) }) : t("management.allConvertedHint")}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        {/* 撤销转租金 — appears once something is converted, so staff
                            can put it back to 待转 and redo the conversion by hand. */}
                        {(prepayments ?? []).some((p) => p.appliedAt && parseFloat(p.amount || "0") > 0) && (
                          <button
                            onClick={() => {
                              if (window.confirm(t("management.unconvertConfirm"))) {
                                unconvert.mutate({ rentalRequestId: rentalId });
                              }
                            }}
                            disabled={unconvert.isPending}
                            className="text-xs px-2 py-1.5 text-slate-500 hover:text-slate-800 underline disabled:opacity-50"
                          >
                            {unconvert.isPending ? t("saving", { ns: "common" }) : t("management.unconvert")}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            if (window.confirm(t("management.transferDepositConfirm", { amount: formatCurrency(heldTotal) }))) {
                              transferDeposit.mutate({ rentalRequestId: rentalId });
                            }
                          }}
                          disabled={transferDeposit.isPending || heldTotal <= 0}
                          className="text-xs px-3 py-1.5 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {transferDeposit.isPending ? t("saving", { ns: "common" }) : t("management.transferDeposit")}
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm(t("management.convertToRentConfirm", { amount: formatCurrency(heldTotal) }))) {
                              convertToRent.mutate({ rentalRequestId: rentalId });
                            }
                          }}
                          disabled={convertToRent.isPending || heldTotal <= 0}
                          className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {convertToRent.isPending ? t("saving", { ns: "common" }) : t("management.convertToRent")}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 记录退款 — when applied prepayments exceed the rent the customer
                      is owed money (应退). Recording the refund (money returned)
                      nets the balance to 0 instead of a phantom standing debt. */}
                  {balance < -0.005 && (
                    <div className="mb-3 bg-rose-50 border border-rose-200 rounded px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-rose-700">{t("management.refundOwedHint", { amount: formatCurrency(Math.abs(balance)) })}</span>
                        {!refundOpen && (
                          <button
                            onClick={() => { setRefundOpen(true); setRefundForm((f) => ({ ...f, amount: Math.abs(balance).toFixed(2) })); }}
                            className="btn-primary text-xs px-3 py-1.5 shrink-0"
                          >
                            {t("management.recordRefund")}
                          </button>
                        )}
                      </div>
                      {refundOpen && (
                        <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
                          <div>
                            <label className="block text-xs text-slate-400 mb-1">{t("management.refundAmount")}</label>
                            <div className="relative">
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                              <input type="number" step="0.01" min="0" value={refundForm.amount}
                                onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })}
                                className="w-full bg-white border border-slate-300 rounded px-2 py-2 pl-6 text-sm text-slate-900" placeholder="0.00" />
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs text-slate-400 mb-1">{t("management.prepaymentMethod")}</label>
                            <select value={refundForm.paymentMethod}
                              onChange={(e) => setRefundForm({ ...refundForm, paymentMethod: e.target.value as PaymentMethod })}
                              className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900">
                              {PAYMENT_METHODS.map((m) => (
                                <option key={m.value} value={m.value}>{tAdmin(m.i18nKey)}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-slate-400 mb-1">{t("management.prepaymentNotes")}</label>
                            <input type="text" value={refundForm.notes}
                              onChange={(e) => setRefundForm({ ...refundForm, notes: e.target.value })}
                              className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => {
                                const amt = parseFloat(refundForm.amount);
                                if (!refundForm.amount || isNaN(amt) || amt <= 0) { toast.error(t("management.amountRequired")); return; }
                                recordRefund.mutate({ rentalRequestId: rentalId, amount: amt.toFixed(2), paymentMethod: refundForm.paymentMethod, notes: refundForm.notes || undefined });
                              }}
                              disabled={recordRefund.isPending}
                              className="btn-primary text-xs px-3 py-2 flex-1"
                            >
                              {recordRefund.isPending ? t("saving", { ns: "common" }) : t("management.recordRefund")}
                            </button>
                            <button onClick={() => setRefundOpen(false)} className="text-xs px-2 py-2 text-slate-500 hover:text-slate-700">{t("cancel", { ns: "common" })}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Invoice settlement status — makes the 预收款 ↔ 发票 linkage
                      visible: recording a 预收款 here settles these invoices. */}
                  {orderInvoices.length > 0 && (
                    <ul className="mb-3 bg-white rounded border border-slate-200 divide-y divide-slate-200">
                      {orderInvoices.map((inv) => {
                        const invTotal = parseFloat(inv.totalAmount || "0");
                        const invPaid = parseFloat(inv.amountPaid || "0");
                        return (
                          <li key={inv.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                            <span className="font-mono text-xs text-slate-600 w-32 shrink-0">{inv.invoiceNumber}</span>
                            <PaymentBadge state={derivePaymentState(invTotal, invPaid)} />
                            <span className="text-xs text-slate-400 ml-auto">
                              {t("management.prepaidTotal")} {formatCurrency(invPaid)} / {formatCurrency(invTotal)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {/* List of prepayments */}
                  {prepayments && prepayments.length > 0 ? (
                    <ul className="divide-y divide-slate-200 mb-3 bg-white rounded border border-slate-200">
                      {prepayments.map((p) => (
                        <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                          {(() => { const amt = parseFloat(p.amount); const isRefund = amt < 0; return (
                            <>
                              <span className={`font-semibold w-24 shrink-0 ${isRefund ? "text-rose-600" : "text-emerald-700"}`}>{isRefund ? `-${formatCurrency(Math.abs(amt))}` : formatCurrency(amt)}</span>
                              <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full shrink-0 ${isRefund ? "bg-rose-100 text-rose-700" : p.appliedAt ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                                {isRefund ? t("management.statusRefund") : p.appliedAt ? t("management.statusApplied") : t("management.statusHeld")}
                              </span>
                            </>
                          ); })()}
                          <span className="text-xs text-slate-500 w-24 shrink-0">
                            {(() => { const k = paymentMethodI18nKey(p.paymentMethod); return k ? tAdmin(k) : "-"; })()}
                          </span>
                          <span className="text-xs text-slate-500 w-24 shrink-0">{fmtDate(p.paymentDate)}</span>
                          <span className="text-xs text-slate-500 flex-1 truncate">
                            {p.invoiceId && (
                              <span className="text-[10px] font-mono text-blue-600 mr-1">
                                → {orderInvoices.find((inv) => inv.id === p.invoiceId)?.invoiceNumber ?? `#${p.invoiceId}`}
                              </span>
                            )}
                            {p.notes || ""}
                          </span>
                          <button
                            onClick={() => setPrepaymentDelete({
                              id: p.id,
                              amount: String(p.amount ?? ""),
                              reason: "",
                              reasonNote: "",
                            })}
                            disabled={deletePrepayment.isPending}
                            className="text-slate-400 hover:text-red-600 shrink-0"
                            aria-label={t("delete", { ns: "common" })}
                          >
                            <XIcon size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-400 mb-3">{t("management.noPrepayments")}</p>
                  )}

                  {/* Optional invoice target — only when the order has multiple
                      invoices (monthly-credit / renewal). Default: order-level FIFO. */}
                  {orderInvoices.length > 1 && (
                    <div className="mb-2">
                      <label className="block text-xs text-slate-400 mb-1">{t("management.prepaymentApplyTo")}</label>
                      <select
                        value={prepayForm.invoiceId}
                        onChange={(e) => setPrepayForm({ ...prepayForm, invoiceId: e.target.value })}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                      >
                        <option value="">{t("management.prepaymentApplyAuto")}</option>
                        {orderInvoices.map((inv) => (
                          <option key={inv.id} value={inv.id}>
                            {inv.invoiceNumber} · {formatCurrency(parseFloat(inv.balanceDue || "0"))} {t("management.balance")}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Add prepayment form */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.prepaymentAmount")} *</label>
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={prepayForm.amount}
                          onChange={(e) => setPrepayForm({ ...prepayForm, amount: e.target.value })}
                          className="w-full bg-white border border-slate-300 rounded px-2 py-2 pl-6 text-sm text-slate-900"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.prepaymentMethod")}</label>
                      <select
                        value={prepayForm.paymentMethod}
                        onChange={(e) => setPrepayForm({ ...prepayForm, paymentMethod: e.target.value as PaymentMethod })}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                      >
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>{tAdmin(m.i18nKey)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.prepaymentDate")}</label>
                      <input
                        type="date"
                        value={prepayForm.paymentDate}
                        onChange={(e) => setPrepayForm({ ...prepayForm, paymentDate: e.target.value })}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                      />
                    </div>
                    <div className="col-span-2 md:col-span-1">
                      <label className="block text-xs text-slate-400 mb-1">{t("management.prepaymentNotes")}</label>
                      <input
                        type="text"
                        value={prepayForm.notes}
                        onChange={(e) => setPrepayForm({ ...prepayForm, notes: e.target.value })}
                        placeholder={t("management.prepaymentNotesPlaceholder")}
                        className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                      />
                    </div>
                    <button
                      onClick={() => {
                        const amt = parseFloat(prepayForm.amount);
                        if (!prepayForm.amount || isNaN(amt) || amt <= 0) {
                          toast.error(t("management.amountRequired"));
                          return;
                        }
                        createPrepayment.mutate({
                          rentalRequestId: rentalId,
                          amount: amt.toFixed(2),
                          paymentMethod: prepayForm.paymentMethod,
                          paymentDate: prepayForm.paymentDate || undefined,
                          notes: prepayForm.notes || undefined,
                          invoiceId: prepayForm.invoiceId ? Number(prepayForm.invoiceId) : undefined,
                        });
                      }}
                      disabled={createPrepayment.isPending}
                      className="btn-primary text-sm h-[38px] flex items-center justify-center gap-1"
                    >
                      <PlusIcon size={14} />
                      {createPrepayment.isPending ? t("saving", { ns: "common" }) : t("management.addPrepayment")}
                    </button>
                  </div>
                </div>

                {/* Credit (挂账) charges ledger */}
                {isCreditOrder && (
                  <div className="bg-amber-50/40 border border-amber-200 rounded-lg p-4 mt-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-amber-700 uppercase">{t("management.charges")}</h3>
                      <div className="text-sm">
                        <span className="text-slate-400">{t("management.chargedTotal")}: </span>
                        <span className="font-bold text-slate-700">{formatCurrency(chargesTotal)}</span>
                        <span className="text-slate-300 mx-2">·</span>
                        <span className="text-slate-400">{t("management.unbilledTotal")}: </span>
                        <span className="font-bold text-amber-700">{formatCurrency(chargesUnbilled)}</span>
                      </div>
                    </div>

                    {charges && charges.length > 0 ? (
                      <ul className="divide-y divide-amber-100 mb-3 bg-white rounded border border-amber-200">
                        {charges.map((c) => (
                          <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                            <span className="text-xs text-slate-500 w-24 shrink-0">{fmtDate(c.chargeDate)}</span>
                            <span className="text-xs font-medium text-slate-600 w-28 shrink-0">{translateDynamic(t, `management.chargeType_${c.chargeType}`, { defaultValue: c.chargeType })}</span>
                            <span className="font-semibold text-slate-700 w-24 shrink-0">{formatCurrency(parseFloat(c.amount))}</span>
                            <span className="text-xs flex-1 truncate text-slate-500">{c.description || ""}</span>
                            {c.invoiceId ? (
                              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 shrink-0">{t("management.chargeBilled")}</span>
                            ) : (
                              <>
                                <button
                                  onClick={() => setChargeEdit({
                                    id: c.id,
                                    mode: "edit",
                                    amount: c.amount ?? "",
                                    description: c.description ?? "",
                                    chargeDate: formatCalendarDateISO(c.chargeDate, tz),
                                    reason: "",
                                    reasonNote: "",
                                  })}
                                  disabled={isCreditSettled}
                                  className="text-slate-400 hover:text-blue-600 shrink-0 disabled:opacity-40"
                                  aria-label={t("edit", { ns: "common" })}
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  onClick={() => setChargeEdit({
                                    id: c.id,
                                    mode: "delete",
                                    amount: c.amount ?? "",
                                    description: c.description ?? "",
                                    chargeDate: formatCalendarDateISO(c.chargeDate, tz),
                                    reason: "",
                                    reasonNote: "",
                                  })}
                                  disabled={isCreditSettled}
                                  className="text-slate-400 hover:text-red-600 shrink-0 disabled:opacity-40"
                                  aria-label={t("delete", { ns: "common" })}
                                >
                                  <XIcon size={14} />
                                </button>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-slate-400 mb-3">{t("management.noCharges")}</p>
                    )}

                    {/* Add a manual charge */}
                    {!isCreditSettled && (
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end mb-3">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.chargeType")}</label>
                          <select
                            value={chargeForm.chargeType}
                            onChange={(e) => setChargeForm({ ...chargeForm, chargeType: e.target.value as typeof chargeForm.chargeType })}
                            className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                          >
                            <option value="adjustment">{t("management.chargeType_adjustment")}</option>
                            <option value="final">{t("management.chargeType_final")}</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.chargeAmount")} *</label>
                          <input type="number" step="0.01" value={chargeForm.amount} onChange={(e) => setChargeForm({ ...chargeForm, amount: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" placeholder="0.00" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.chargeDate")}</label>
                          <input type="date" value={chargeForm.chargeDate} onChange={(e) => setChargeForm({ ...chargeForm, chargeDate: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" />
                        </div>
                        <div className="col-span-2 md:col-span-1">
                          <label className="block text-xs text-slate-400 mb-1">{t("management.chargeDescription")}</label>
                          <input type="text" value={chargeForm.description} onChange={(e) => setChargeForm({ ...chargeForm, description: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" />
                        </div>
                        <button
                          onClick={() => {
                            const amt = parseFloat(chargeForm.amount);
                            if (!chargeForm.amount || isNaN(amt) || amt <= 0) { toast.error(t("management.amountRequired")); return; }
                            createCharge.mutate({
                              rentalRequestId: rentalId,
                              chargeType: chargeForm.chargeType,
                              amount: amt.toFixed(2),
                              description: chargeForm.description || undefined,
                              chargeDate: chargeForm.chargeDate || undefined,
                            });
                          }}
                          disabled={createCharge.isPending}
                          className="btn-primary text-sm h-[38px] flex items-center justify-center gap-1"
                        >
                          <PlusIcon size={14} />
                          {t("management.addCharge")}
                        </button>
                      </div>
                    )}

                    {/* Correct or remove a recorded charge — reason is mandatory */}


                    {chargeEdit && (
                      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={closeChargeEdit}>
                        <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
                          <h4 className="text-sm font-semibold text-slate-700 mb-3">
                            {chargeEdit.mode === "edit" ? t("management.editCharge") : t("management.deleteChargeTitle")}
                          </h4>

                          {chargeEdit.mode === "edit" ? (
                            <div className="space-y-3">
                              <div>
                                <label className="block text-xs text-slate-400 mb-1">{t("management.chargeAmount")} *</label>
                                <input
                                  type="number" step="0.01" value={chargeEdit.amount}
                                  onChange={(e) => setChargeEdit({ ...chargeEdit, amount: e.target.value })}
                                  className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-slate-400 mb-1">{t("management.chargeDate")}</label>
                                <input
                                  type="date" value={chargeEdit.chargeDate}
                                  onChange={(e) => setChargeEdit({ ...chargeEdit, chargeDate: e.target.value })}
                                  className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-slate-400 mb-1">{t("management.chargeDescription")}</label>
                                <input
                                  type="text" value={chargeEdit.description}
                                  onChange={(e) => setChargeEdit({ ...chargeEdit, description: e.target.value })}
                                  className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                                />
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm text-slate-600 mb-3">
                              {t("management.deleteCharge")} <span className="font-semibold">{formatCurrency(parseFloat(chargeEdit.amount || "0"))}</span>
                            </p>
                          )}

                          <div className="mt-3">
                            <label className="block text-xs text-slate-400 mb-1">{t("editReason.label", { ns: "common" })} *</label>
                            <select
                              value={chargeEdit.reason}
                              onChange={(e) => setChargeEdit({ ...chargeEdit, reason: e.target.value })}
                              className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                            >
                              <option value="">—</option>
                              {EDIT_REASONS.map((rsn) => (
                                <option key={rsn} value={rsn}>{t(`editReason.${rsn}`, { ns: "common" })}</option>
                              ))}
                            </select>
                          </div>
                          <div className="mt-2">
                            <input
                              type="text" value={chargeEdit.reasonNote}
                              onChange={(e) => setChargeEdit({ ...chargeEdit, reasonNote: e.target.value })}
                              placeholder={t("editReason.notePlaceholder", { ns: "common" })}
                              className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                            />
                          </div>

                          <div className="flex justify-end gap-2 mt-4">
                            <button onClick={closeChargeEdit} className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
                              {t("cancel", { ns: "common" })}
                            </button>
                            <button
                              onClick={() => {
                                if (!chargeEdit.reason) { toast.error(t("editReason.required", { ns: "common" })); return; }
                                if (chargeEdit.mode === "delete") {
                                  deleteCharge.mutate({
                                    id: chargeEdit.id,
                                    reason: chargeEdit.reason as typeof EDIT_REASONS[number],
                                    reasonNote: chargeEdit.reasonNote || undefined,
                                  });
                                  return;
                                }
                                const amt = parseFloat(chargeEdit.amount);
                                if (!chargeEdit.amount || isNaN(amt) || amt <= 0) { toast.error(t("management.amountRequired")); return; }
                                updateCharge.mutate({
                                  id: chargeEdit.id,
                                  amount: amt.toFixed(2),
                                  description: chargeEdit.description,
                                  chargeDate: chargeEdit.chargeDate || undefined,
                                  reason: chargeEdit.reason as typeof EDIT_REASONS[number],
                                  reasonNote: chargeEdit.reasonNote || undefined,
                                });
                              }}
                              disabled={updateCharge.isPending || deleteCharge.isPending}
                              className={chargeEdit.mode === "delete"
                                ? "text-sm px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
                                : "btn-primary text-sm px-4 py-2"}
                            >
                              {updateCharge.isPending || deleteCharge.isPending
                                ? t("saving", { ns: "common" })
                                : chargeEdit.mode === "delete" ? t("delete", { ns: "common" }) : t("save", { ns: "common" })}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => generateChargeInvoice.mutate({ rentalRequestId: rentalId })}
                        disabled={generateChargeInvoice.isPending || chargesUnbilled <= 0}
                        className="text-sm bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg disabled:opacity-40"
                      >
                        {t("management.generateChargeInvoice")}
                      </button>
                      {!isCreditSettled && ["active", "overdue"].includes(r.status) && r.rentalFleetId && (
                        <button
                          onClick={() => setExchangeOpen((v) => !v)}
                          className="text-sm bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg"
                        >
                          {t("management.binExchange")}
                        </button>
                      )}
                      {!isCreditSettled && ["active", "approved", "overdue"].includes(r.status) && (
                        <button
                          onClick={() => setFinalizeOpen((v) => !v)}
                          className="text-sm bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 text-emerald-700 px-4 py-2 rounded-lg"
                        >
                          {t("management.finalizeCreditOrder")}
                        </button>
                      )}
                    </div>

                    {/* Exchange-bin inline form */}
                    {exchangeOpen && !isCreditSettled && (
                      <div className="mt-3 bg-white border border-slate-200 rounded-lg p-3 grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
                        <div className="col-span-2">
                          <label className="block text-xs text-slate-400 mb-1">{t("management.exchangeNewBin")} *</label>
                          <select
                            value={exchangeForm.newRentalFleetId === "" ? "" : String(exchangeForm.newRentalFleetId)}
                            onChange={(e) => setExchangeForm({ ...exchangeForm, newRentalFleetId: e.target.value ? Number(e.target.value) : "" })}
                            className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
                          >
                            <option value="">{t("management.selectByModelPlaceholder", { ns: "rental" })}</option>
                            {exchangeCandidates.map((f) => (
                              <option key={f.id} value={f.id}>{f.serialNumber ? `${f.serialNumber} · ` : ""}{f.brand} {f.model}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.exchangeFee")}</label>
                          <input type="number" step="0.01" value={exchangeForm.fee} onChange={(e) => setExchangeForm({ ...exchangeForm, fee: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" placeholder="0.00" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.exchangeDate")}</label>
                          <input type="date" value={exchangeForm.exchangeDate} onChange={(e) => setExchangeForm({ ...exchangeForm, exchangeDate: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" />
                        </div>
                        <div className="col-span-2 md:col-span-3">
                          <label className="block text-xs text-slate-400 mb-1">{t("management.chargeDescription")}</label>
                          <input type="text" value={exchangeForm.description} onChange={(e) => setExchangeForm({ ...exchangeForm, description: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" />
                        </div>
                        <button
                          onClick={() => {
                            if (typeof exchangeForm.newRentalFleetId !== "number") { toast.error(t("management.amountRequired")); return; }
                            exchangeBin.mutate({
                              rentalRequestId: rentalId,
                              newRentalFleetId: exchangeForm.newRentalFleetId,
                              fee: exchangeForm.fee ? parseFloat(exchangeForm.fee).toFixed(2) : undefined,
                              exchangeDate: exchangeForm.exchangeDate || undefined,
                              description: exchangeForm.description || undefined,
                            });
                          }}
                          disabled={exchangeBin.isPending}
                          className="btn-primary text-sm h-[38px]"
                        >
                          {t("management.binExchange")}
                        </button>
                      </div>
                    )}

                    {/* Finalize (close-out) inline form */}
                    {finalizeOpen && !isCreditSettled && (
                      <div className="mt-3 bg-white border border-emerald-200 rounded-lg p-3 grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.actualEndDate")} *</label>
                          <input type="date" value={finalizeForm.actualEndDate} onChange={(e) => setFinalizeForm({ ...finalizeForm, actualEndDate: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">{t("management.finalAmount")}</label>
                          <input type="number" step="0.01" value={finalizeForm.finalAmount} onChange={(e) => setFinalizeForm({ ...finalizeForm, finalAmount: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" placeholder="0.00" />
                        </div>
                        <div className="col-span-2 md:col-span-4 text-xs text-slate-500">
                          {t("management.finalizeConfirm", {
                            charged: formatCurrency(chargesTotal),
                            adding: formatCurrency(parseFloat(finalizeForm.finalAmount) || 0),
                            total: formatCurrency(chargesTotal + (parseFloat(finalizeForm.finalAmount) || 0)),
                          })}
                        </div>
                        <div className="col-span-2 md:col-span-3">
                          <label className="block text-xs text-slate-400 mb-1">{t("management.adminNotes", { ns: "rental" })}</label>
                          <input type="text" value={finalizeForm.adminNotes} onChange={(e) => setFinalizeForm({ ...finalizeForm, adminNotes: e.target.value })} className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900" />
                        </div>
                        <button
                          onClick={() => {
                            if (!finalizeForm.actualEndDate) { toast.error(t("management.requiredFields")); return; }
                            finalizeCreditOrder.mutate({
                              id: rentalId,
                              actualEndDate: finalizeForm.actualEndDate,
                              finalAmount: finalizeForm.finalAmount ? parseFloat(finalizeForm.finalAmount).toFixed(2) : undefined,
                              adminNotes: finalizeForm.adminNotes || undefined,
                            });
                          }}
                          disabled={finalizeCreditOrder.isPending}
                          className="btn-primary text-sm h-[38px] bg-emerald-600 hover:bg-emerald-700"
                        >
                          {t("management.finalizeCreditOrder")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* -- Contract & Docs Tab -- */}
            {activeTab === "contract" && (
              <div className="space-y-6">
                <div className="bg-slate-50 rounded-lg p-4">
                  <h3 className="text-sm font-semibold text-slate-500 uppercase mb-3">{t("management.contract")}</h3>
                  <div className="flex gap-3 items-center flex-wrap">
                    {r.contractUrl ? (
                      <a href={r.contractUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--primary)] hover:text-[var(--accent-hover)] underline font-medium">
                        {t("management.downloadContract", { version: r.contractVersion })}
                      </a>
                    ) : (
                      <span className="text-sm text-slate-400">{t("management.noContract")}</span>
                    )}
                    <button
                      onClick={() => generateContract.mutate({ id: rentalId })}
                      disabled={generateContract.isPending}
                      className="text-sm bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-4 py-2 rounded-lg"
                    >
                      {generateContract.isPending ? t("management.generating") : r.contractUrl ? t("management.regenerate") : t("management.generateContract")}
                    </button>
                  </div>
                  {r.contractGeneratedAt && <p className="text-xs text-slate-400 mt-2">{t("management.generated")} {fmtDateTime(r.contractGeneratedAt)}</p>}
                  {r.contractSignedAt && <p className="text-xs text-slate-400">{t("management.customerSignedAt")} {fmtDateTime(r.contractSignedAt)}</p>}
                  {r.repSignedAt && <p className="text-xs text-slate-400">{t("management.repSignedAt")} {fmtDateTime(r.repSignedAt)}</p>}
                  <div className="mt-3">
                    {r.repSignedAt ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
                        <PenLine size={12} /> {t("management.repSigned")}
                      </span>
                    ) : (
                      <button
                        onClick={() => setRepSignOpen(true)}
                        className="inline-flex items-center gap-1 text-sm bg-[var(--primary)] hover:bg-[var(--accent-hover)] text-white px-3 py-1.5 rounded-lg"
                      >
                        <PenLine size={14} /> {t("management.signAsRep")}
                      </button>
                    )}
                  </div>
                </div>

                {signatureEvidenceEnabled && signatureEvidence && signatureEvidence.signedAt && (
                  <div className="border border-slate-200 rounded-lg p-4 bg-slate-50">
                    <label className="block text-sm font-semibold text-slate-500 uppercase mb-3">{t("management.signatureEvidence")}</label>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-slate-500">{t("management.signedAt")}</span>
                        <span className="text-slate-900 font-mono">{fmtDateTime(signatureEvidence.signedAt)}</span>
                      </div>
                      {signatureEvidence.signatureIp && (
                        <div className="flex justify-between">
                          <span className="text-slate-500">{t("management.ipAddress")}</span>
                          <span className="text-slate-900 font-mono">{signatureEvidence.signatureIp}</span>
                        </div>
                      )}
                      {signatureEvidence.signatureContractHash && (
                        <div className="flex justify-between gap-4">
                          <span className="text-slate-500 shrink-0">{t("management.contractHash")}</span>
                          <span className="text-slate-900 font-mono text-xs break-all">
                            {signatureEvidence.signatureContractHash.slice(0, 16)}...
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-slate-500">{t("management.hashVerified")}</span>
                        <span className={signatureEvidence.hashMatch ? "text-green-600 font-semibold" : "text-red-600 font-semibold"}>
                          {signatureEvidence.hashMatch ? t("management.hashOk") : t("management.hashMismatch")}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.financialOrderNumber")}</label>
                    <input
                      value={financialOrderNumber}
                      onChange={(e) => setFinancialOrderNumber(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900"
                      placeholder="SOT12269 / SOR00039"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("management.cardLast4")}</label>
                    <input
                      value={cardLast4}
                      maxLength={4}
                      inputMode="numeric"
                      onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900"
                      placeholder="1234"
                    />
                  </div>
                  <button
                    onClick={() => updateRental.mutate({ id: rentalId, financialOrderNumber: financialOrderNumber || undefined, cardLast4: cardLast4 || undefined })}
                    disabled={updateRental.isPending}
                    className="btn-primary text-sm w-fit"
                  >
                    {t("management.save")}
                  </button>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-slate-500 uppercase mb-2">{t("management.adminNotes")}</label>
                  <textarea
                    value={adminNotes}
                    onChange={(e) => setAdminNotes(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-4 py-3 text-sm text-slate-900 min-h-[200px] resize-y"
                    placeholder={t("management.notesPlaceholder")}
                  />
                  <button
                    onClick={() => updateRental.mutate({ id: rentalId, adminNotes: adminNotes || undefined })}
                    disabled={updateRental.isPending}
                    className="btn-primary text-sm mt-2"
                  >
                    {t("management.saveNotes")}
                  </button>
                </div>
              </div>
            )}

            {/* -- Dispatch Tab -- */}
            {dispatchWorkflowEnabled && activeTab === "dispatch" && (() => {
              const getNextStatuses = (current: string) => {
                const transitions: Record<string, string[]> = {
                  pending: ["assigned"],
                  assigned: ["in_transit"],
                  in_transit: ["delivered"],
                  delivered: ["completed"],
                };
                return transitions[current] || [];
              };
              const availableDrivers = (drivers || []).filter((d) => d.isActive);
              const resetDispatchForm = (orderType: "delivery" | "pickup" = "delivery") => {
                setDispatchForm({
                  orderType,
                  scheduledDate: "",
                  assignedDriverId: "",
                  pickupAddress: orderType === "pickup" ? (r.deliveryAddress || "") : "",
                  deliveryAddress: orderType === "delivery" ? (r.deliveryAddress || "") : "",
                  notes: "",
                });
              };
              const dispatchFormFields = (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.orderType")}</label>
                      <select
                        value={dispatchForm.orderType}
                        onChange={(e) => {
                          const ot = e.target.value as "delivery" | "pickup";
                          setDispatchForm((f) => ({
                            ...f,
                            orderType: ot,
                            pickupAddress: ot === "pickup" ? (r.deliveryAddress || "") : f.pickupAddress,
                            deliveryAddress: ot === "delivery" ? (r.deliveryAddress || "") : f.deliveryAddress,
                          }));
                        }}
                        className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                      >
                        <option value="delivery">{t("management.deliveryOption")}</option>
                        <option value="pickup">{t("management.pickupOption2")}</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.scheduledDate")}</label>
                      <input
                        type="date"
                        value={dispatchForm.scheduledDate}
                        onChange={(e) => setDispatchForm((f) => ({ ...f, scheduledDate: e.target.value }))}
                        className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">{t("management.assignedDriver")}</label>
                    <select
                      value={dispatchForm.assignedDriverId}
                      onChange={(e) => setDispatchForm((f) => ({ ...f, assignedDriverId: e.target.value }))}
                      className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                    >
                      <option value="">{t("management.selectDriver")}</option>
                      {availableDrivers.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.pickupAddress")}</label>
                      <input
                        type="text"
                        value={dispatchForm.pickupAddress}
                        onChange={(e) => setDispatchForm((f) => ({ ...f, pickupAddress: e.target.value }))}
                        className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                        placeholder={t("management.pickupAddressPlaceholder")}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">{t("management.deliveryAddressLabel")}</label>
                      <input
                        type="text"
                        value={dispatchForm.deliveryAddress}
                        onChange={(e) => setDispatchForm((f) => ({ ...f, deliveryAddress: e.target.value }))}
                        className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                        placeholder={t("management.deliveryAddressPlaceholder")}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">{t("management.notesLabel")}</label>
                    <textarea
                      value={dispatchForm.notes}
                      onChange={(e) => setDispatchForm((f) => ({ ...f, notes: e.target.value }))}
                      className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900 min-h-[60px] resize-y"
                      placeholder={t("management.notesPlaceholder2")}
                    />
                  </div>
                </div>
              );

              return (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-500 uppercase">{t("management.dispatchOrders")}</h3>
                    {!dispatchCreateOpen && (
                      <button
                        onClick={() => { resetDispatchForm(); setDispatchCreateOpen(true); setDispatchEditId(null); }}
                        className="btn-primary text-sm flex items-center gap-1"
                      >
                        <PlusIcon size={14} /> {t("management.createDispatch")}
                      </button>
                    )}
                  </div>

                  {/* Inline Create Form */}
                  {dispatchCreateOpen && (
                    <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                      <h4 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1"><TruckIcon size={14} /> {t("management.newDispatchOrder")}</h4>
                      {dispatchFormFields}
                      <div className="flex gap-2 mt-3">
                        <button
                          onClick={() => {
                            createDispatch.mutate({
                              orderType: dispatchForm.orderType,
                              rentalRequestId: rentalId,
                              assignedDriverId: dispatchForm.assignedDriverId ? Number(dispatchForm.assignedDriverId) : undefined,
                              scheduledDate: dispatchForm.scheduledDate || undefined,
                              pickupAddress: dispatchForm.pickupAddress || undefined,
                              deliveryAddress: dispatchForm.deliveryAddress || undefined,
                              notes: dispatchForm.notes || undefined,
                            }, { onSuccess: () => setDispatchCreateOpen(false) });
                          }}
                          disabled={createDispatch.isPending}
                          className="btn-primary text-sm"
                        >
                          {createDispatch.isPending ? t("management.creatingDispatch") : t("management.createDispatch")}
                        </button>
                        <button onClick={() => setDispatchCreateOpen(false)} className="btn-secondary text-sm">{t("cancel", { ns: "common" })}</button>
                      </div>
                    </div>
                  )}

                  {/* Dispatch Cards */}
                  {dispatches && dispatches.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {dispatches.map((d) => {
                        const order = d.dispatch_orders;
                        const nextStatuses = getNextStatuses(order.status);
                        const isEditing = dispatchEditId === order.id;
                        const driverName = order.assignedDriverId
                          ? availableDrivers.find((d) => d.id === order.assignedDriverId)?.name || `Driver #${order.assignedDriverId}`
                          : null;

                        return (
                          <div key={order.id} className="bg-slate-50 rounded-lg p-4">
                            {isEditing ? (
                              <>
                                <h4 className="text-sm font-semibold text-slate-700 mb-3">{t("management.editDispatch")} #{order.id}</h4>
                                {dispatchFormFields}
                                <div className="flex gap-2 mt-3">
                                  <button
                                    onClick={() => {
                                      updateDispatch.mutate({
                                        id: order.id,
                                        assignedDriverId: dispatchForm.assignedDriverId ? Number(dispatchForm.assignedDriverId) : undefined,
                                        scheduledDate: dispatchForm.scheduledDate || undefined,
                                        pickupAddress: dispatchForm.pickupAddress || undefined,
                                        deliveryAddress: dispatchForm.deliveryAddress || undefined,
                                        notes: dispatchForm.notes || undefined,
                                      }, { onSuccess: () => setDispatchEditId(null) });
                                    }}
                                    disabled={updateDispatch.isPending}
                                    className="btn-primary text-sm"
                                  >
                                    {updateDispatch.isPending ? t("management.savingDispatch") : t("management.saveDispatch")}
                                  </button>
                                  <button onClick={() => setDispatchEditId(null)} className="btn-secondary text-sm">{t("cancel", { ns: "common" })}</button>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="flex justify-between items-start mb-2">
                                  <span className="font-semibold text-slate-900 capitalize">{t(order.orderType, { ns: "dispatch" })} #{order.id}</span>
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => {
                                        setDispatchCreateOpen(false);
                                        setDispatchEditId(order.id);
                                        setDispatchForm({
                                          orderType: order.orderType as "delivery" | "pickup",
                                          scheduledDate: order.scheduledDate ? formatCalendarDateISO(order.scheduledDate) : "",
                                          assignedDriverId: order.assignedDriverId ? String(order.assignedDriverId) : "",
                                          pickupAddress: order.pickupAddress || "",
                                          deliveryAddress: order.deliveryAddress || "",
                                          notes: order.notes || "",
                                        });
                                      }}
                                      className="text-slate-400 hover:text-slate-600"
                                      title={t("edit", { ns: "common" })}
                                    >
                                      <Pencil size={14} />
                                    </button>
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${order.status === "completed" ? "bg-green-100 text-green-700" : order.status === "cancelled" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                                      {t(`kanban.${order.status === "in_transit" ? "inTransit" : order.status}`, { ns: "dispatch" })}
                                    </span>
                                  </div>
                                </div>
                                {driverName && <p className="text-xs text-slate-500">{t("driver", { ns: "dispatch" })}: {driverName}</p>}
                                {order.scheduledDate && <p className="text-xs text-slate-500">{t("scheduled", { ns: "dispatch" })}: {fmtDate(order.scheduledDate)}</p>}
                                {order.deliveryAddress && <p className="text-xs text-slate-500 mt-1">{t("management.deliveryAddressLabel")}: {order.deliveryAddress}</p>}
                                {order.pickupAddress && <p className="text-xs text-slate-500 mt-1">{t("management.pickupAddress")}: {order.pickupAddress}</p>}
                                {order.notes && <p className="text-xs text-slate-400 mt-1">{order.notes}</p>}
                                {nextStatuses.length > 0 && (
                                  <div className="mt-2 flex gap-1">
                                    {nextStatuses.map((s) => (
                                      <button
                                        key={s}
                                        onClick={() => updateDispatchStatus.mutate({ id: order.id, status: s as "pending" | "assigned" | "in_transit" | "delivered" | "completed" | "cancelled" })}
                                        disabled={updateDispatchStatus.isPending}
                                        className="text-xs bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 px-2 py-1 rounded capitalize"
                                      >
                                        &rarr; {translateDynamic(t, `kanban.${s === "in_transit" ? "inTransit" : s}`, { ns: "dispatch" })}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    !dispatchCreateOpen && <p className="text-sm text-slate-400 py-4">{t("management.noDispatch")}</p>
                  )}
                </div>
              );
            })()}

            {/* -- Inspections Tab -- */}
            {activeTab === "history" && (
              <div className="space-y-3">
                <p className="text-xs text-slate-400">{t("management.changeHistoryHint")}</p>
                {(!changeHistory || changeHistory.length === 0) ? (
                  <p className="text-sm text-slate-400 py-6 text-center">{t("management.noChangeHistory")}</p>
                ) : (
                  <ul className="space-y-3">
                    {changeHistory.map((e) => {
                      const meta = parseAuditMeta(e.metadata);
                      return (
                        <li key={e.id} className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 mb-2">
                            <span className="font-semibold text-slate-700">{e.userName || e.userUsername || t("management.systemActor")}</span>
                            <span>{e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${e.action === "post_invoice_edit" ? "bg-amber-100 text-amber-800" : "bg-slate-200 text-slate-600"}`}>{e.action}</span>
                            {meta.invoiceNumber && <span className="text-amber-700">{meta.invoiceNumber}</span>}
                            {meta.reason && <span className="italic">「{meta.reason}」</span>}
                          </div>
                          <ChangeDiff changes={e.changes} />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {activeTab === "inspections" && (
              <div className="space-y-6">
                {/* Inspection Status */}
                <div className="grid grid-cols-2 gap-4">
                  <div className={`rounded-lg p-4 ${r.deliveryInspectionCompleted ? "bg-green-50 border border-green-200" : "bg-slate-50 border border-slate-200"}`}>
                    <div className="text-sm font-medium text-slate-700">{t("management.deliveryInspection")}</div>
                    <div className={`text-xs mt-1 ${r.deliveryInspectionCompleted ? "text-green-600" : "text-slate-400"}`}>
                      {r.deliveryInspectionCompleted ? t("management.completed") : t("management.pending")}
                    </div>
                  </div>
                  <div className={`rounded-lg p-4 ${r.returnInspectionCompleted ? "bg-green-50 border border-green-200" : "bg-slate-50 border border-slate-200"}`}>
                    <div className="text-sm font-medium text-slate-700">{t("management.returnInspection")}</div>
                    <div className={`text-xs mt-1 ${r.returnInspectionCompleted ? "text-green-600" : "text-slate-400"}`}>
                      {r.returnInspectionCompleted ? t("management.completed") : t("management.pending")}
                    </div>
                  </div>
                </div>

                {/* Create Inspection Token + admin upload */}
                <div className="flex gap-3 flex-wrap items-center">
                  <button
                    onClick={() => createToken.mutate({ inspectionType: "dispatch", rentalId, rentalFleetId: fleet?.id })}
                    disabled={createToken.isPending}
                    className="text-sm bg-blue-50 text-blue-700 hover:bg-blue-100 px-3 py-2 rounded-lg border border-blue-200"
                  >
                    {t("management.createDispatchLink")}
                  </button>
                  <button
                    onClick={() => createToken.mutate({ inspectionType: "return", rentalId, rentalFleetId: fleet?.id })}
                    disabled={createToken.isPending}
                    className="text-sm bg-purple-50 text-purple-700 hover:bg-purple-100 px-3 py-2 rounded-lg border border-purple-200"
                  >
                    {t("management.createReturnLink")}
                  </button>
                  <div className="w-px h-6 bg-slate-200" />
                  <button
                    onClick={() => setInspEditOpen({ mode: "create", type: "dispatch" })}
                    className="text-sm bg-emerald-50 text-emerald-700 hover:bg-emerald-100 px-3 py-2 rounded-lg border border-emerald-200 flex items-center gap-1.5"
                  >
                    <Camera size={14} /> {t("management.adminUploadDispatch")}
                  </button>
                  <button
                    onClick={() => setInspEditOpen({ mode: "create", type: "return" })}
                    className="text-sm bg-emerald-50 text-emerald-700 hover:bg-emerald-100 px-3 py-2 rounded-lg border border-emerald-200 flex items-center gap-1.5"
                  >
                    <Camera size={14} /> {t("management.adminUploadReturn")}
                  </button>
                </div>

                {/* Inspection Records */}
                {inspections && inspections.length > 0 ? (
                  <div className="space-y-4">
                    {inspections.map((insp) => {
                      const photos = photoLabels
                        .filter(({ key }) => insp[key])
                        .map(({ key, label }) => ({ src: insp[key] as string, label }));

                      return (
                        <div key={insp.id} className="bg-slate-50 rounded-lg p-4">
                          <div className="flex justify-between items-start mb-2">
                            <span className="font-semibold text-slate-900">{translateDynamic(t, `management.inspType_${insp.type}`)} #{insp.id}</span>
                            <div className="flex items-center gap-2">
                              <span className={`text-sm font-medium ${
                                insp.overallCondition === "excellent" ? "text-green-600" :
                                insp.overallCondition === "good" ? "text-blue-600" :
                                insp.overallCondition === "fair" ? "text-yellow-600" :
                                insp.overallCondition === "poor" ? "text-red-600" : "text-slate-400"
                              }`}>{insp.overallCondition ? t(`condition.${insp.overallCondition}`, { ns: "common" }) : "-"}</span>
                              <span className="text-xs text-slate-400">{fmtDate(insp.createdAt)}</span>
                              <button
                                onClick={() => setInspEditOpen({ mode: "edit", id: insp.id })}
                                className="text-xs px-2 py-1 rounded bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-emerald-700 flex items-center gap-1"
                                title={t("management.editInspection")}
                              >
                                <Pencil size={11} /> {t("management.edit", { defaultValue: "Edit" })}
                              </button>
                            </div>
                          </div>
                          {insp.damageNotes && <p className="text-sm text-yellow-700 bg-yellow-50 p-2 rounded mb-2">{insp.damageNotes}</p>}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-slate-500 mb-2">
                            <div>{t("management.engine")} {insp.engineHours ?? "-"}</div>
                            <div>{t("management.fuel")} {insp.fuelLevel != null ? `${insp.fuelLevel}%` : "-"}</div>
                            <div>{t("management.odometer")} {insp.odometerReading ?? "-"}</div>
                            <div>{t("management.location")} {insp.locationAddress || "-"}</div>
                          </div>
                          {photos.length > 0 && (
                            <div className="flex gap-2 flex-wrap mt-2">
                              {photos.map((p, i) => (
                                <button key={i} onClick={() => { setLightboxPhotos(photos); setLightboxIndex(i); }}>
                                  <img src={p.src} alt={p.label} className="w-20 h-20 object-cover rounded-lg border border-slate-200 hover:ring-2 hover:ring-[var(--primary)]" />
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">{t("management.noInspections")}</p>
                )}

                {/* Dispatch vs Return Comparison */}
                {comparison && (comparison.dispatch || comparison.return) && (
                  <div className="border-t border-slate-200 pt-4">
                    <h3 className="text-sm font-semibold text-slate-500 uppercase mb-3">{t("management.dispatchComparison")}</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {["dispatch", "return"].map((type) => {
                        const insp = comparison[type as "dispatch" | "return"];
                        if (!insp) return (
                          <div key={type} className="bg-slate-50 rounded-lg p-4 text-center text-slate-400 text-sm">
                            {translateDynamic(t, `management.noInspType_${type}`)}
                          </div>
                        );
                        return (
                          <div key={type} className="bg-slate-50 rounded-lg p-4">
                            <h4 className="font-semibold text-slate-900 mb-2">{translateDynamic(t, `management.inspType_${type}`)}</h4>
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              <div><span className="text-slate-400">{t("management.condition")}:</span> <span className="capitalize font-medium">{insp.overallCondition ? t(`condition.${insp.overallCondition}`, { ns: "common" }) : "-"}</span></div>
                              <div><span className="text-slate-400">{t("management.engine")}</span> <span className="font-medium">{insp.engineHours ?? "-"}</span></div>
                              <div><span className="text-slate-400">{t("management.fuel")}</span> <span className="font-medium">{insp.fuelLevel != null ? `${insp.fuelLevel}%` : "-"}</span></div>
                              <div><span className="text-slate-400">{t("management.odometer")}</span> <span className="font-medium">{insp.odometerReading ?? "-"}</span></div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Waive an invoiced extra charge, and delete a mistyped prepayment.
          Both live at the top level because their trigger buttons do: the
          waive button renders on the pricing tab of every order and the
          prepayment delete button on every order's payment list, while these
          dialogs used to sit inside the credit-order branch. On a normal
          order the click set the state and nothing mounted — the button was
          simply dead. */}
      {waivingCharge && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setWaivingCharge(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-semibold text-slate-700 mb-2">{t("management.waiveChargeTitle")}</h4>
            <p className="text-sm text-slate-600 mb-1">
              {t("management.waiveCharge")}{" "}
              <span className="font-semibold">{formatCurrency(parseFloat(waivingCharge.amount || "0"))}</span>
            </p>
            {/* Say plainly what this does — it is not a delete. */}
            <p className="text-xs text-slate-400 mb-3">{t("management.waiveChargeHint")}</p>
            <div>
              <label className="block text-xs text-slate-400 mb-1">{t("editReason.label", { ns: "common" })} *</label>
              <select
                value={waivingCharge.reason}
                onChange={(e) => setWaivingCharge({ ...waivingCharge, reason: e.target.value })}
                className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
              >
                <option value="">—</option>
                {EDIT_REASONS.map((rsn) => (
                  <option key={rsn} value={rsn}>{t(`editReason.${rsn}`, { ns: "common" })}</option>
                ))}
              </select>
            </div>
            <div className="mt-2">
              <input
                type="text" value={waivingCharge.reasonNote}
                onChange={(e) => setWaivingCharge({ ...waivingCharge, reasonNote: e.target.value })}
                placeholder={t("editReason.notePlaceholder", { ns: "common" })}
                className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setWaivingCharge(null)} className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
                {t("cancel", { ns: "common" })}
              </button>
              <button
                onClick={() => {
                  if (!waivingCharge.reason) { toast.error(t("editReason.required", { ns: "common" })); return; }
                  waiveCharge.mutate({
                    claimId: waivingCharge.id,
                    reason: waivingCharge.reason as typeof EDIT_REASONS[number],
                    reasonNote: waivingCharge.reasonNote || undefined,
                  });
                }}
                disabled={waiveCharge.isPending}
                className="text-sm px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40"
              >
                {waiveCharge.isPending ? t("saving", { ns: "common" }) : t("management.waiveCharge")}
              </button>
            </div>
          </div>
        </div>
      )}

      {prepaymentDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setPrepaymentDelete(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-semibold text-slate-700 mb-3">{t("management.deletePrepaymentTitle")}</h4>
            <p className="text-sm text-slate-600 mb-3">
              {t("management.deletePrepayment")}{" "}
              <span className="font-semibold">{formatCurrency(parseFloat(prepaymentDelete.amount || "0"))}</span>
            </p>
            <div>
              <label className="block text-xs text-slate-400 mb-1">{t("editReason.label", { ns: "common" })} *</label>
              <select
                value={prepaymentDelete.reason}
                onChange={(e) => setPrepaymentDelete({ ...prepaymentDelete, reason: e.target.value })}
                className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
              >
                <option value="">—</option>
                {EDIT_REASONS.map((rsn) => (
                  <option key={rsn} value={rsn}>{t(`editReason.${rsn}`, { ns: "common" })}</option>
                ))}
              </select>
            </div>
            <div className="mt-2">
              <input
                type="text" value={prepaymentDelete.reasonNote}
                onChange={(e) => setPrepaymentDelete({ ...prepaymentDelete, reasonNote: e.target.value })}
                placeholder={t("editReason.notePlaceholder", { ns: "common" })}
                className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setPrepaymentDelete(null)} className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50">
                {t("cancel", { ns: "common" })}
              </button>
              <button
                onClick={() => {
                  if (!prepaymentDelete.reason) { toast.error(t("editReason.required", { ns: "common" })); return; }
                  deletePrepayment.mutate({
                    id: prepaymentDelete.id,
                    reason: prepaymentDelete.reason as typeof EDIT_REASONS[number],
                    reasonNote: prepaymentDelete.reasonNote || undefined,
                  }, { onSuccess: () => setPrepaymentDelete(null) });
                }}
                disabled={deletePrepayment.isPending}
                className="text-sm px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white disabled:opacity-40"
              >
                {deletePrepayment.isPending ? t("saving", { ns: "common" }) : t("delete", { ns: "common" })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Duplicate dialog */}
      {duplicateOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setDuplicateOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl max-w-sm w-full p-6 z-10">
            <h3 className="text-base font-semibold text-slate-900 mb-4">{t("management.duplicateOrder")}</h3>
            <p className="text-sm text-slate-500 mb-4">
              {t("management.duplicateDescription")}
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">{t("management.newStartDate")}</label>
                <input
                  type="date"
                  value={dupStartDate}
                  onChange={(e) => setDupStartDate(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">{t("management.newEndDate")}</label>
                <input
                  type="date"
                  value={dupEndDate}
                  onChange={(e) => setDupEndDate(e.target.value)}
                  className="w-full bg-white border border-slate-300 rounded px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => {
                  if (!dupStartDate || !dupEndDate) {
                    toast.error(t("management.selectBothDates"));
                    return;
                  }
                  duplicateRental.mutate({
                    sourceId: rentalId,
                    newStartDate: dupStartDate,
                    newEndDate: dupEndDate,
                  });
                }}
                disabled={duplicateRental.isPending || !dupStartDate || !dupEndDate}
                className="btn-primary text-sm flex-1"
              >
                {duplicateRental.isPending ? t("management.creating") : t("management.createDuplicate")}
              </button>
              <button
                onClick={() => setDuplicateOpen(false)}
                className="btn-secondary text-sm"
              >
                {t("management.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Photo Lightbox */}
      {lightboxPhotos && (
        <PhotoLightbox
          photos={lightboxPhotos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxPhotos(null)}
        />
      )}

      {/* Inspection edit/create dialog */}
      {inspEditOpen && (
        <InspectionDetailDialog
          inspectionId={inspEditOpen.mode === "edit" ? inspEditOpen.id : undefined}
          rentalId={rentalId}
          rentalFleetId={inspEditOpen.fleetId ?? fleet?.id}
          defaultType={inspEditOpen.type}
          onClose={() => setInspEditOpen(null)}
        />
      )}

      {/* Close-rental modal */}
      {closeOpen && r && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={() => setCloseOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-slate-900">{t("management.closeRental")}</h3>
            <p className="text-xs text-slate-500">{t("management.closeRentalHint")}</p>

            {/* Prepaid vs total balance reminder */}
            {(prepaidTotal > 0 || totalAmount > 0) && (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs space-y-1">
                <div className="flex justify-between"><span className="text-slate-500">{t("management.total")}</span><span className="font-medium text-slate-900">{formatCurrency(totalAmount)}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("management.prepaidTotal")}</span><span className="font-medium text-emerald-700">{formatCurrency(appliedTotal)}</span></div>
                {heldTotal > 0 && (
                  <div className="flex justify-between text-amber-600"><span>{t("management.heldPending")}</span><span className="font-medium">{formatCurrency(heldTotal)}</span></div>
                )}
                <div className="flex justify-between pt-1 border-t border-slate-200">
                  <span className="text-slate-500">{t("management.balance")}</span>
                  {balance > 0 ? (
                    <span className="font-bold text-[var(--primary)]">{formatCurrency(balance)} · {t("management.balanceDue")}</span>
                  ) : balance < 0 ? (
                    <span className="font-bold text-amber-700">{formatCurrency(Math.abs(balance))} · {t("management.balanceRefund")}</span>
                  ) : (
                    <span className="font-bold text-emerald-700">{formatCurrency(0)}</span>
                  )}
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs text-slate-500 mb-1">{t("management.closeReturnedAt")}</label>
              <input type="datetime-local" value={closeForm.actualReturnedAt}
                onChange={(e) => setCloseForm({ ...closeForm, actualReturnedAt: e.target.value })}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
              <p className="text-xs text-slate-400 mt-0.5">{t("management.closeReturnedAtHint")}</p>
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1">{t("management.closeDamageCharges")}</label>
              <input type="number" step="0.01" min="0" value={closeForm.damageCharges}
                onChange={(e) => setCloseForm({ ...closeForm, damageCharges: e.target.value })}
                placeholder="0.00"
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm" />
            </div>

            <div>
              <label className="block text-xs text-slate-500 mb-1">{t("management.closeNotes")}</label>
              <textarea value={closeForm.adminNotes}
                onChange={(e) => setCloseForm({ ...closeForm, adminNotes: e.target.value })}
                rows={3} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-sm resize-none" />
            </div>

            {!rentalReadyForClose && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                {t("assetProgress.closeRequiresEvidence", { ns: "common" })}
              </p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setCloseOpen(false)} className="btn-secondary text-sm">{t("cancel", { ns: "common" })}</button>
              <button
                onClick={() => closeRental.mutate({
                  id: rentalId,
                  actualReturnedAt: closeForm.actualReturnedAt || undefined,
                  damageCharges: closeForm.damageCharges || undefined,
                  adminNotes: closeForm.adminNotes || undefined,
                })}
                disabled={closeRental.isPending}
                className="btn-primary text-sm disabled:opacity-50"
              >
                {closeRental.isPending ? t("management.generating") : t("management.closeRentalConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rep signature modal */}
      {repSignOpen && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4" onClick={() => setRepSignOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">{t("management.signAsRep")}</h3>
              <button onClick={() => setRepSignOpen(false)} className="text-slate-500 hover:text-slate-900"><XIcon size={18} /></button>
            </div>
            <p className="text-xs text-slate-500">{t("management.signAsRepHint")}</p>
            <div className="bg-slate-50 rounded-lg border border-slate-300 p-2">
              <canvas
                ref={repCanvasRef}
                className="w-full bg-white rounded touch-none"
                style={{ height: "180px" }}
                {...repSignatureHandlers}
              />
            </div>
            <div className="flex gap-2">
              <button onClick={repClear} className="flex-1 px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg">
                {t("management.clearSig")}
              </button>
              <button
                onClick={() => repSignature && signAsRep.mutate({ id: rentalId, signature: repSignature })}
                disabled={!repSignature || signAsRep.isPending}
                className="flex-1 px-3 py-2 text-sm font-medium text-white bg-[var(--primary)] hover:bg-[var(--accent-hover)] disabled:bg-slate-300 rounded-lg"
              >
                {signAsRep.isPending ? t("management.generating") : t("management.confirmSig")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
