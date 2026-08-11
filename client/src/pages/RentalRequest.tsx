import { useState, useRef, useEffect, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useBranding } from "@/config/branding";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { formatCalendarDateISO } from "@/lib/dateUtils";
import { useRentalRequest } from "@/hooks/useRentalRequest";
import { trackEvent } from "@/components/Analytics";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import type { AddressComponents } from "@/components/AddressAutocomplete";
import AvailabilityCalendar from "@/components/AvailabilityCalendar";
import { INSURANCE_OPTIONS } from "../../../shared/insurance";
import type { InsuranceType } from "../../../shared/insurance";
import { DELIVERY_METHODS } from "../../../shared/deliveryMethod";
import type { DeliveryMethod } from "../../../shared/deliveryMethod";
import type { CostEstimate } from "../../../shared/rentalTypes";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { tDeliveryMethod, tInsurance } from "@/lib/i18nHelpers";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { trpc } from "@/lib/trpc";
import { X, UserCheck } from "lucide-react";

interface RentalRequestDialogProps {
  fleetId: number;
  /** Fleet IDs the user can pick from when ordering multiple units of the same model.
   *  Defaults to [fleetId]. Length determines the max quantity allowed. */
  availableFleetIds?: number[];
  /** equipment_models.id of the model being rented */
  equipmentModelId?: number;
  /** catalog_cache.id of the rep — drives attachment compatibility lookup */
  catalogCacheId?: number;
  /** "machine" | "attachment" — when "attachment", the form gates submission on a compatibility ack */
  equipmentType?: "machine" | "attachment";
  onClose: () => void;
}

export function RentalRequestDialog({ fleetId, availableFleetIds, equipmentModelId, catalogCacheId, equipmentType, onClose }: RentalRequestDialogProps) {
  const { t } = useTranslation("common");
  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="relative bg-slate-50 rounded-2xl w-full max-w-5xl max-h-[95vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-200 transition"
          aria-label={t("close")}
        >
          <X size={24} />
        </button>
        <div className="p-6">
          <RentalRequestContent fleetId={fleetId} availableFleetIds={availableFleetIds} equipmentModelId={equipmentModelId} catalogCacheId={catalogCacheId} equipmentType={equipmentType} isDialog onClose={onClose} />
        </div>
      </div>
    </div>
  );
}

function RentalRequestContent({
  fleetId,
  availableFleetIds,
  equipmentModelId: _equipmentModelId,
  catalogCacheId,
  equipmentType,
  isDialog = false,
  onClose,
}: {
  fleetId: number;
  availableFleetIds?: number[];
  equipmentModelId?: number;
  catalogCacheId?: number;
  equipmentType?: "machine" | "attachment";
  isDialog?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation("rental");
  const [, setLocation] = useLocation();

  const {
    startDate, setStartDate,
    endDate, setEndDate,
    deliveryMethod, setDeliveryMethod,
    insuranceType, setInsuranceType,
    deliveryAddress, setDeliveryAddress,
    deliveryProvince, setDeliveryProvince,
    customerName, setCustomerName,
    customerEmail, setCustomerEmail,
    customerPhone, setCustomerPhone,
    customerCompany, setCustomerCompany,
    projectDescription, setProjectDescription,
    customerNotes, setCustomerNotes,
    referralCode, setReferralCode,
    scheduledDeliveryTime, setScheduledDeliveryTime,
    fleet,
    resolvedRates,
    warehouses,
    availability,
    costEstimate,
    submit,
    isSubmitting,
  } = useRentalRequest({
    fleetId,
    fleetIdPool: availableFleetIds && availableFleetIds.length > 0 ? availableFleetIds : [fleetId],
  });

  const [showReview, setShowReview] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  // Multi-unit quantity (length-1 list = single unit, current behavior)
  const fleetIdPool = availableFleetIds && availableFleetIds.length > 0 ? availableFleetIds : [fleetId];
  const maxQuantity = fleetIdPool.length;
  const [quantity, setQuantity] = useState(1);
  const [submitProgress, setSubmitProgress] = useState<{ current: number; total: number } | null>(null);

  // Attachment compatibility (Stage B)
  const isAttachment = equipmentType === "attachment";
  const [ownMachineNote, setOwnMachineNote] = useState("");
  const [compatibilityAck, setCompatibilityAck] = useState(false);
  const { data: compatibleMachines } = trpc.attachmentCompatibility.forAttachment.useQuery(
    { attachmentCatalogId: catalogCacheId || 0 },
    { enabled: !!catalogCacheId && isAttachment },
  );
  // Clamp quantity if the available pool shrinks (e.g., after a real-time refresh)
  useEffect(() => {
    if (quantity > maxQuantity) setQuantity(maxQuantity);
  }, [maxQuantity, quantity]);

  // Returning customer recognition
  const [emailLookupQuery, setEmailLookupQuery] = useState("");
  const [returningDismissed, setReturningDismissed] = useState(false);
  const { data: returningCustomer } = trpc.customers.lookupByEmail.useQuery(
    { email: emailLookupQuery },
    { enabled: !!emailLookupQuery && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLookupQuery) },
  );

  const handleEmailBlur = useCallback(() => {
    if (customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      setEmailLookupQuery(customerEmail);
      setReturningDismissed(false);
    }
  }, [customerEmail]);

  const applyReturningCustomer = useCallback(() => {
    if (!returningCustomer) return;
    const c = returningCustomer.customer;
    if (c.name && !customerName) setCustomerName(c.name);
    if (c.phone && !customerPhone) setCustomerPhone(c.phone);
    if (c.company && !customerCompany) setCustomerCompany(c.company);
    if (returningCustomer.lastRental?.deliveryAddress && !deliveryAddress) {
      setDeliveryAddress(returningCustomer.lastRental.deliveryAddress);
    }
    toast.success(t("request.returningCustomerApplied"));
  }, [returningCustomer, customerName, customerPhone, customerCompany, deliveryAddress, setCustomerName, setCustomerPhone, setCustomerCompany, setDeliveryAddress, t]);

  // Section refs for scroll progress (page mode only)
  const sectionRefs = {
    rental: useRef<HTMLDivElement>(null),
    delivery: useRef<HTMLDivElement>(null),
    insurance: useRef<HTMLDivElement>(null),
    info: useRef<HTMLDivElement>(null),
  };
  const [, setActiveSection] = useState("rental");

  useEffect(() => {
    if (isDialog) return; // No scroll indicator in dialog mode
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute("data-section");
            if (id) setActiveSection(id);
          }
        }
      },
      { threshold: 0.3 }
    );
    Object.values(sectionRefs).forEach(ref => {
      if (ref.current) observer.observe(ref.current);
    });
    return () => observer.disconnect();

  }, [isDialog]);

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!customerName.trim()) errors.name = t("request.validation.nameRequired");
    if (!customerEmail.trim()) {
      errors.email = t("request.validation.emailRequired");
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      errors.email = t("request.validation.emailInvalid");
    }
    if (!customerPhone.trim()) {
      errors.phone = t("request.validation.phoneRequired");
    } else {
      const digits = customerPhone.replace(/[\s\-()+ ]/g, "");
      const isValid = /^1?\d{10}$/.test(digits);
      if (!isValid) errors.phone = t("request.validation.phoneInvalid");
    }
    if (!startDate) errors.startDate = t("request.validation.startRequired");
    if (!endDate) errors.endDate = t("request.validation.endRequired");
    if (startDate && endDate && new Date(endDate) <= new Date(startDate)) {
      errors.endDate = t("request.validation.endAfterStart");
    }
    if (deliveryMethod !== "pickup" && !deliveryAddress.trim()) {
      errors.address = t("request.validation.addressRequired");
    }
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleReview = (e: React.FormEvent) => {
    e.preventDefault();
    setAttemptedSubmit(true);
    if (!validate()) {
      toast.error(t("request.fixErrors"));
      return;
    }
    setShowReview(true);
    if (!isDialog) window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async () => {
    if (!agreedToTerms) {
      toast.error(t("request.agreeFirst"));
      return;
    }
    if (isAttachment && !compatibilityAck) {
      toast.error(t("request.attachmentAckRequired"));
      return;
    }
    const idsToBook = fleetIdPool.slice(0, quantity);
    const extras = isAttachment
      ? {
          customerEquipmentNote: ownMachineNote.trim() || undefined,
          compatibilityAcknowledgedAt: new Date().toISOString(),
        }
      : undefined;
    try {
      let succeeded = 0;
      let firstOrderId: number | null = null;
      for (let i = 0; i < idsToBook.length; i++) {
        setSubmitProgress({ current: i + 1, total: idsToBook.length });
        const created = await submit(idsToBook[i], extras);
        if (firstOrderId === null && created?.id) firstOrderId = Number(created.id);
        succeeded += 1;
      }
      setSubmitProgress(null);
      trackEvent("generate_lead", { form: "rental_request", count: succeeded });
      toast.success(
        succeeded > 1
          ? t("request.submittedMulti", { count: succeeded })
          : t("request.submitted"),
      );
      if (isDialog && onClose) {
        onClose();
      } else {
        // Land the customer on the order-tracking page instead of a dead-end at
        // home. Prefill the order number + email so they can see status right
        // away (Checkout does the same redirect; this matches it for single-item).
        const params = new URLSearchParams();
        if (firstOrderId) params.set("orderId", String(firstOrderId));
        if (customerEmail) params.set("email", customerEmail);
        const qs = params.toString();
        setLocation(qs ? `/rental-status?${qs}` : "/rental-status");
      }
    } catch (err: unknown) {
      const succeeded = submitProgress ? submitProgress.current - 1 : 0;
      setSubmitProgress(null);
      const baseMsg = err instanceof Error ? err.message : t("request.submitError");
      if (succeeded > 0) {
        toast.error(t("request.partialSuccess", { succeeded, total: idsToBook.length, message: baseMsg }));
      } else {
        toast.error(baseMsg);
      }
    }
  };

  const fieldError = (field: string) => {
    if (!attemptedSubmit || !validationErrors[field]) return null;
    return <p className="text-red-500 text-xs mt-1">{validationErrors[field]}</p>;
  };

  const fieldClass = (field: string) => {
    const base = "w-full bg-[var(--surface-container-lowest)] border rounded-lg px-3 py-2 text-slate-900";
    if (attemptedSubmit && validationErrors[field]) return `${base} border-red-500`;
    return `${base} border-slate-300`;
  };

  const handlePlaceSelected = (address: AddressComponents) => {
    setDeliveryAddress(address.formattedAddress);
    setDeliveryProvince(address.province);
  };

  // Toronto's "today", not the browser's — so the min date is correct for an
  // overseas viewer and consistent with how dates are stored/displayed.
  const today = formatCalendarDateISO(new Date());

  return (
    <>
      {/* Equipment info header in dialog */}
      {isDialog && fleet && (
        <div className="mb-6">
          <h2 className="text-xl font-bold text-slate-900 pr-10">
            {t("request.equipment")}: {fleet.brand} {fleet.model}
          </h2>
        </div>
      )}

      <div className={isDialog ? "" : "grid grid-cols-1 lg:grid-cols-3 gap-8"}>
        {/* Left column: Equipment card + Price summary (page mode) or inline price (dialog) */}
        {!isDialog && (
          <div className="lg:col-span-1 space-y-6">
            {fleet && (
              <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm border border-slate-200 p-6">
                {fleet.imageUrl && (
                  <img src={fleet.imageUrl} alt={`${fleet.brand} ${fleet.model}`} className="w-full h-48 object-cover rounded-lg mb-4" />
                )}
                <h2 className="text-lg font-bold text-slate-900">{fleet.brand} {fleet.model}</h2>
                {fleet.category && <p className="text-sm text-slate-500 mt-1">{fleet.category}</p>}
                <div className="mt-3 space-y-1 text-sm">
                  {resolvedRates.dailyRate && resolvedRates.dailyRate !== "0" && <div className="flex justify-between"><span className="text-slate-500">{t("daily")}</span><span className="font-medium">${resolvedRates.dailyRate}/{t("daily").toLowerCase()}</span></div>}
                  {resolvedRates.weeklyRate && resolvedRates.weeklyRate !== "0" && <div className="flex justify-between"><span className="text-slate-500">{t("weekly")}</span><span className="font-medium">${resolvedRates.weeklyRate}/{t("weekly").toLowerCase()}</span></div>}
                  {resolvedRates.monthlyRate && resolvedRates.monthlyRate !== "0" && <div className="flex justify-between"><span className="text-slate-500">{t("monthly")}</span><span className="font-medium">${resolvedRates.monthlyRate}/{t("monthly").toLowerCase()}</span></div>}
                </div>
              </div>
            )}
            <PriceSummary costEstimate={costEstimate} quantity={quantity} t={t} />
          </div>
        )}

        {/* Form column */}
        <div className={isDialog ? "" : "lg:col-span-2"}>
          <form onSubmit={handleReview} className="space-y-6">
            {/* 1. Rental Period */}
            <div ref={sectionRefs.rental} data-section="rental" className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm border border-slate-200 p-6">
              <h3 className="text-lg font-bold text-slate-900 mb-4">{t("request.rentalPeriod")}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-500 mb-1">{t("request.startDate")} *</label>
                  <input type="date" required min={today} value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                </div>
                <div>
                  <label className="block text-sm text-slate-500 mb-1">{t("request.endDate")} *</label>
                  <input type="date" required min={startDate || today} value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                </div>
              </div>
              {maxQuantity > 1 && (
                <div className="mt-4">
                  <label className="block text-sm text-slate-500 mb-1">
                    {t("request.quantity")}
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                      disabled={quantity <= 1}
                      className="w-9 h-9 rounded-lg border border-slate-300 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 transition"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={maxQuantity}
                      value={quantity}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        if (!isNaN(n)) setQuantity(Math.min(maxQuantity, Math.max(1, n)));
                      }}
                      className="w-20 text-center bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
                      disabled={quantity >= maxQuantity}
                      className="w-9 h-9 rounded-lg border border-slate-300 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-100 transition"
                    >
                      +
                    </button>
                    <span className="text-sm text-slate-500 ml-2">{t("unitsCount", { count: quantity })}</span>
                  </div>
                </div>
              )}
              {availability && !availability.isAvailable && (
                <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                  {t("request.unavailableDates")}
                </div>
              )}
              {availability && availability.isAvailable && startDate && endDate && (
                <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                  {t("request.availableDates")}
                </div>
              )}
              <div className="mt-4">
                <AvailabilityCalendar
                  fleetIds={fleetIdPool}
                  selectedStartDate={startDate}
                  selectedEndDate={endDate}
                  onDateSelect={(date) => {
                    if (!startDate || (startDate && endDate)) {
                      setStartDate(date);
                      setEndDate("");
                    } else {
                      if (date < startDate) {
                        setEndDate(startDate);
                        setStartDate(date);
                      } else {
                        setEndDate(date);
                      }
                    }
                  }}
                />
              </div>
            </div>

            {/* Attachment compatibility ack — gates submission for attachment rentals */}
            {isAttachment && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-3">
                <h3 className="text-base font-bold text-amber-900">
                  {t("request.attachmentTitle")}
                </h3>
                {compatibleMachines && compatibleMachines.length > 0 ? (
                  <div className="bg-white border border-amber-200 rounded-lg p-3">
                    <p className="text-xs font-medium text-amber-700 uppercase tracking-wide mb-2">
                      {t("request.attachmentCompatibleList")}
                    </p>
                    <ul className="text-sm text-slate-700 space-y-1">
                      {compatibleMachines.map((m) => (
                        <li key={m.id} className="flex items-baseline gap-2">
                          <span className="text-amber-600">•</span>
                          <span>{m.machineBrand} {m.machineModel}{m.machineModelYear ? ` (${m.machineModelYear})` : ""}</span>
                          <span className="text-xs text-slate-400">{m.machineCategory}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-amber-800">{t("request.attachmentNoCompat")}</p>
                )}
                <div>
                  <label className="block text-sm text-slate-700 mb-1">
                    {t("request.ownMachineNote")}
                  </label>
                  <input
                    value={ownMachineNote}
                    onChange={(e) => setOwnMachineNote(e.target.value)}
                    placeholder={t("request.ownMachinePlaceholder")}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
                  />
                  <p className="text-xs text-slate-500 mt-1">{t("request.ownMachineHint")}</p>
                </div>
                <label className="flex items-start gap-2 text-sm text-amber-900 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={compatibilityAck}
                    onChange={(e) => setCompatibilityAck(e.target.checked)}
                    className="mt-0.5 rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                  />
                  <span>{t("request.attachmentAckLabel")}</span>
                </label>
              </div>
            )}

            {/* 2. Delivery Method */}
            <div ref={sectionRefs.delivery} data-section="delivery" className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm border border-slate-200 p-6">
              <h3 className="text-lg font-bold text-slate-900 mb-4">{t("request.deliveryMethod")}</h3>
              <div className="space-y-3">
                {Object.keys(DELIVERY_METHODS).map((key) => {
                  const translated = tDeliveryMethod(t, key);
                  return (
                    <label key={key} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${deliveryMethod === key ? "border-[#2563EB] bg-[var(--primary)]/5" : "border-slate-200 hover:border-slate-300"}`}>
                      <input type="radio" name="deliveryMethod" value={key} checked={deliveryMethod === key} onChange={() => setDeliveryMethod(key as DeliveryMethod)} className="mt-1" />
                      <div>
                        <div className="font-medium text-slate-900">{translated.label}</div>
                        <div className="text-sm text-slate-500">{translated.description}</div>
                      </div>
                    </label>
                  );
                })}
              </div>

              {deliveryMethod === "pickup" && warehouses && warehouses.length > 0 && (
                <div className="mt-4">
                  <label className="block text-sm text-slate-500 mb-1">{t("request.pickupLocation")}</label>
                  <div className="text-sm text-slate-700 p-3 bg-slate-50 rounded-lg">
                    {warehouses[0]?.name} - {warehouses[0]?.address}, {warehouses[0]?.city}
                  </div>
                </div>
              )}

              {deliveryMethod !== "pickup" && (
                <div className="mt-4">
                  <label className="block text-sm text-slate-500 mb-1">{t("request.deliveryAddress")} *</label>
                  <AddressAutocomplete
                    value={deliveryAddress}
                    onChange={setDeliveryAddress}
                    onPlaceSelected={handlePlaceSelected}
                    required
                    placeholder={t("request.enterDeliveryAddress")}
                  />
                  {deliveryProvince && (
                    <p className="mt-1 text-xs text-slate-400">{t("request.province")}: {deliveryProvince} {t("request.provinceTaxNote")}</p>
                  )}
                </div>
              )}

              {/* Preferred delivery time */}
              {deliveryMethod !== "pickup" && (
                <div className="mt-4">
                  <label className="block text-sm text-slate-500 mb-1">{t("request.preferredDeliveryTime")}</label>
                  <select
                    value={scheduledDeliveryTime}
                    onChange={(e) => setScheduledDeliveryTime(e.target.value)}
                    className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900"
                  >
                    <option value="">{t("request.deliveryTime.noPreference")}</option>
                    <option value="07:00">{t("request.deliveryTime.morning")}</option>
                    <option value="12:00">{t("request.deliveryTime.afternoon")}</option>
                  </select>
                </div>
              )}
            </div>

            {/* 3. Insurance */}
            <div ref={sectionRefs.insurance} data-section="insurance" className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm border border-slate-200 p-6">
              <h3 className="text-lg font-bold text-slate-900 mb-4">{t("request.insurance")}</h3>
              <div className="space-y-3">
                {(Object.entries(INSURANCE_OPTIONS) as [string, (typeof INSURANCE_OPTIONS)[InsuranceType]][]).map(([key, option]) => {
                  const translated = tInsurance(t, key);
                  return (
                    <label key={key} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${insuranceType === key ? "border-[#2563EB] bg-[var(--primary)]/5" : "border-slate-200 hover:border-slate-300"}`}>
                      <input type="radio" name="insuranceType" value={key} checked={insuranceType === key} onChange={() => setInsuranceType(key as InsuranceType)} className="mt-1" />
                      <div className="flex-1">
                        <div className="flex justify-between">
                          <span className="font-medium text-slate-900">{translated.label}</span>
                          <span className="text-sm text-slate-500">{option.costPercentage > 0 ? t("request.costPercentage", { percentage: (option.costPercentage * 100).toFixed(0) }) : t("request.free")}</span>
                        </div>
                        <div className="text-sm text-slate-500">{translated.description}</div>
                        {option.deductible !== null && <div className="text-xs text-slate-400 mt-1">{t("request.deductible", { amount: option.deductible?.toLocaleString() })}</div>}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* 4. Customer Information */}
            <div ref={sectionRefs.info} data-section="info" className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm border border-slate-200 p-6">
              <h3 className="text-lg font-bold text-slate-900 mb-4">{t("request.yourInfo")}</h3>

              {/* Returning customer banner */}
              {returningCustomer && !returningDismissed && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <UserCheck size={18} className="text-green-600" />
                    <div>
                      <div className="text-sm font-medium text-green-800">
                        {t("request.welcomeBack", { name: returningCustomer.customer.name })}
                      </div>
                      {returningCustomer.lastRental && (
                        <div className="text-xs text-green-600">
                          {t("request.lastRentalInfo", {
                            equipment: `${returningCustomer.lastRental.fleetBrand || ""} ${returningCustomer.lastRental.fleetModel || ""}`.trim() || "-",
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={applyReturningCustomer} className="text-xs bg-green-600 text-white px-3 py-1 rounded-full hover:bg-green-700 transition">
                      {t("request.autofill")}
                    </button>
                    <button onClick={() => setReturningDismissed(true)} className="text-green-400 hover:text-green-600">
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-slate-500 mb-1">{t("request.fullName")} *</label>
                  <input type="text" value={customerName} onChange={(e) => setCustomerName(e.target.value)} className={fieldClass("name")} />
                  {fieldError("name")}
                </div>
                <div>
                  <label className="block text-sm text-slate-500 mb-1">{t("request.email")} *</label>
                  <input type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} onBlur={handleEmailBlur} className={fieldClass("email")} />
                  {fieldError("email")}
                </div>
                <div>
                  <label className="block text-sm text-slate-500 mb-1">{t("request.phone")} *</label>
                  <input type="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} className={fieldClass("phone")} placeholder={t("request.phonePlaceholder")} />
                  {fieldError("phone")}
                </div>
                <div>
                  <label className="block text-sm text-slate-500 mb-1">{t("request.company")}</label>
                  <input type="text" value={customerCompany} onChange={(e) => setCustomerCompany(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900" />
                </div>
              </div>
              <div className="mt-4">
                <label className="block text-sm text-slate-500 mb-1">{t("request.projectDescription")}</label>
                <textarea value={projectDescription} onChange={(e) => setProjectDescription(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900 h-20 resize-none" placeholder={t("request.projectPlaceholder")} />
              </div>
              <div className="mt-4">
                <label className="block text-sm text-slate-500 mb-1">{t("request.additionalNotes")}</label>
                <textarea value={customerNotes} onChange={(e) => setCustomerNotes(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900 h-20 resize-none" placeholder={t("request.notesPlaceholder")} />
              </div>
              <div className="mt-4">
                <label className="block text-sm text-slate-500 mb-1">{t("request.referralCode")}</label>
                <input
                  value={referralCode}
                  onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                  className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900"
                  placeholder={t("request.referralCodePlaceholder")}
                  maxLength={50}
                />
              </div>
            </div>

            {/* Price summary inline for dialog mode */}
            {isDialog && <PriceSummary costEstimate={costEstimate} quantity={quantity} t={t} />}

            {/* Review & Submit */}
            {!showReview ? (
              <button type="submit" className="w-full bg-[var(--primary)] text-white font-medium py-3 px-6 rounded-xl hover:bg-[var(--accent-hover)] transition">
                {t("request.reviewRequest")}
              </button>
            ) : (
              <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm border border-slate-200 p-6 space-y-4">
                <h3 className="text-lg font-bold text-slate-900">{t("request.reviewTitle")}</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">{t("request.equipment")}</span>
                    <span className="font-medium text-slate-900">{fleet ? `${fleet.brand} ${fleet.model}` : "-"}</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">{t("request.dates")}</span>
                    <span className="font-medium text-slate-900">{startDate} {t("request.to")} {endDate}</span>
                  </div>
                  {quantity > 1 && (
                    <div className="flex justify-between py-2 border-b border-slate-100">
                      <span className="text-slate-500">{t("request.quantity")}</span>
                      <span className="font-medium text-slate-900">{t("unitsCount", { count: quantity })}</span>
                    </div>
                  )}
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">{t("request.delivery")}</span>
                    <span className="font-medium text-slate-900">{tDeliveryMethod(t, deliveryMethod).label}</span>
                  </div>
                  {deliveryAddress && (
                    <div className="flex justify-between py-2 border-b border-slate-100">
                      <span className="text-slate-500">{t("request.address")}</span>
                      <span className="font-medium text-slate-900 text-right max-w-[60%]">{deliveryAddress}</span>
                    </div>
                  )}
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">{t("request.insurance")}</span>
                    <span className="font-medium text-slate-900">{tInsurance(t, insuranceType).label}</span>
                  </div>
                  {costEstimate && (
                    <div className="flex justify-between py-2 border-b border-slate-100">
                      <span className="text-slate-500">{t("request.estimatedTotal")}</span>
                      <span className="font-bold text-[var(--primary)]">
                        {formatCurrency(costEstimate.totalAmount * quantity)}
                        {quantity > 1 && (
                          <span className="ml-1 text-xs text-slate-400 font-normal">
                            ({formatCurrency(costEstimate.totalAmount)} × {quantity})
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">{t("request.name")}</span>
                    <span className="font-medium text-slate-900">{customerName}</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-slate-100">
                    <span className="text-slate-500">{t("request.email")}</span>
                    <span className="font-medium text-slate-900">{customerEmail}</span>
                  </div>
                  <div className="flex justify-between py-2">
                    <span className="text-slate-500">{t("request.phone")}</span>
                    <span className="font-medium text-slate-900">{customerPhone}</span>
                  </div>
                </div>

                {/* Terms */}
                <div className="border-t border-slate-200 pt-4">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={agreedToTerms}
                      onChange={(e) => setAgreedToTerms(e.target.checked)}
                      className="mt-1 w-4 h-4 accent-[#2563EB]"
                    />
                    <span className="text-sm text-slate-600">
                      {t("request.agreeTerms")}{" "}
                      <button type="button" onClick={() => setShowTerms(!showTerms)} className="text-[var(--primary)] underline hover:text-[#A31F16]">
                        {t("request.termsLink")}
                      </button>
                    </span>
                  </label>
                  {showTerms && (
                    <div className="mt-3 p-4 bg-slate-50 rounded-lg text-xs text-slate-600 max-h-48 overflow-y-auto space-y-2">
                      <p>{t("request.terms.1")}</p>
                      <p>{t("request.terms.2")}</p>
                      <p>{t("request.terms.3")}</p>
                      <p>{t("request.terms.4")}</p>
                      <p>{t("request.terms.5")}</p>
                      <p>{t("request.terms.6")}</p>
                    </div>
                  )}
                </div>

                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setShowReview(false)}
                    className="flex-1 bg-slate-100 text-slate-700 font-medium py-3 px-6 rounded-xl hover:bg-slate-200 transition"
                  >
                    {t("request.editRequest")}
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={isSubmitting || !agreedToTerms}
                    className="flex-1 bg-[var(--primary)] text-white font-medium py-3 px-6 rounded-xl hover:bg-[var(--accent-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submitProgress
                      ? t("request.submittingProgress", { current: submitProgress.current, total: submitProgress.total })
                      : isSubmitting
                        ? t("request.submitting")
                        : t("request.confirmSubmit")}
                  </button>
                </div>
              </div>
            )}
          </form>
        </div>
      </div>
    </>
  );
}

function PriceSummary({ costEstimate, quantity = 1, t }: { costEstimate: CostEstimate | null; quantity?: number; t: TFunction<"rental"> }) {
  if (!costEstimate) return null;
  const isMulti = quantity > 1;
  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm border border-slate-200 p-6">
      <h3 className="text-lg font-bold text-slate-900 mb-4">
        {t("request.priceEstimate")}
        {isMulti && (
          <span className="ml-2 text-sm font-normal text-slate-500">({t("request.perUnit")})</span>
        )}
      </h3>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-slate-500">{t("request.rentalFee")}</span>
          <span className="font-medium">{formatCurrency(costEstimate.rentalFee)}</span>
        </div>
        {costEstimate.rentalBreakdown && (
          <p className="text-xs text-slate-400 -mt-1">{costEstimate.rentalBreakdown}</p>
        )}
        {costEstimate.freightCost > 0 && (
          <div className="flex justify-between">
            <span className="text-slate-500">{t("request.freight")}</span>
            <span className="font-medium">{formatCurrency(costEstimate.freightCost)}</span>
          </div>
        )}
        {costEstimate.insuranceCost > 0 && (
          <div className="flex justify-between">
            <span className="text-slate-500">{t("request.insurance")}</span>
            <span className="font-medium">{formatCurrency(costEstimate.insuranceCost)}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-slate-500">{t("request.tax")} ({costEstimate.taxBreakdown})</span>
          <span className="font-medium">{formatCurrency(costEstimate.taxAmount)}</span>
        </div>
        <div className="border-t border-slate-200 pt-2 flex justify-between">
          <span className="text-slate-500">{t("request.deposit")}</span>
          <span className="font-medium">{formatCurrency(costEstimate.depositAmount)}</span>
        </div>
        <div className="border-t border-slate-200 pt-2 flex justify-between text-base">
          <span className="font-bold text-slate-900">{isMulti ? t("request.totalPerUnit") : t("request.total")}</span>
          <span className="font-bold text-[var(--primary)]">{formatCurrency(costEstimate.totalAmount)}</span>
        </div>
        {isMulti && (
          <div className="border-t-2 border-slate-300 pt-2 flex justify-between text-base">
            <span className="font-bold text-slate-900">
              {t("request.grandTotal")} <span className="text-sm font-normal text-slate-500">× {quantity}</span>
            </span>
            <span className="font-bold text-[var(--primary)]">{formatCurrency(costEstimate.totalAmount * quantity)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function RentalRequest() {
  const { fleetId } = useParams<{ fleetId: string }>();
  const { t } = useTranslation("rental");
  const branding = useBranding();

  // Section refs for scroll progress
  const sectionRefs = {
    rental: useRef<HTMLDivElement>(null),
    delivery: useRef<HTMLDivElement>(null),
    insurance: useRef<HTMLDivElement>(null),
    info: useRef<HTMLDivElement>(null),
  };
  const [activeSection, setActiveSection] = useState("rental");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute("data-section");
            if (id) setActiveSection(id);
          }
        }
      },
      { threshold: 0.3 }
    );
    Object.values(sectionRefs).forEach(ref => {
      if (ref.current) observer.observe(ref.current);
    });
    return () => observer.disconnect();

  }, []);

  return (
    <div className="min-h-screen bg-[var(--surface)]">
      <header className="border-b border-slate-200 bg-[var(--surface-container-lowest)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-slate-900">{branding.companyName} - {t("request.title")}</h1>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <a href="/" className="text-sm text-[var(--primary)] hover:text-[#A31F16]">{t("request.backToEquipment")}</a>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-8">
        <RentalRequestContent fleetId={Number(fleetId)} />
      </div>

      {/* Scroll Progress Indicator */}
      <div className="fixed right-4 top-1/2 -translate-y-1/2 hidden lg:flex flex-col gap-3 z-20">
        {[
          { id: "rental", label: t("request.rentalPeriod") },
          { id: "delivery", label: t("request.deliveryMethod") },
          { id: "insurance", label: t("request.insurance") },
          { id: "info", label: t("request.yourInfo") },
        ].map((section) => (
          <button
            key={section.id}
            onClick={() => sectionRefs[section.id as keyof typeof sectionRefs].current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className={`flex items-center gap-2 text-xs transition-all ${activeSection === section.id ? "text-[var(--primary)] font-semibold" : "text-slate-400 hover:text-slate-600"}`}
          >
            <div className={`w-2 h-2 rounded-full ${activeSection === section.id ? "bg-[var(--primary)]" : "bg-slate-300"}`} />
            {section.label}
          </button>
        ))}
      </div>
    </div>
  );
}
