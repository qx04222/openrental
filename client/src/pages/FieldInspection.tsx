import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useBranding } from "@/config/branding";
import { toast } from "sonner";
import { nanoid } from "nanoid";
import { savePendingInspection } from "@/lib/pwa";
import { ArrowLeft, Camera, Loader2, MapPin } from "lucide-react";
import { compressImage } from "@/lib/imageUtils";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { FuelGauge, fuelGaugeLabel } from "@/components/FuelGauge";
import { useSignaturePad } from "@/hooks/useSignaturePad";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";

type Step = "type" | "equipment" | "readings" | "photos" | "condition" | "signature" | "review";

export default function FieldInspection() {
  const branding = useBranding();
  const { t } = useTranslation("inspection");
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const fmtDate = useFormatCalendarDate();

  // Read pre-fill params from delivery flow (e.g., ?type=dispatch&fleetId=5&fleetLabel=CAT+320&rentalId=12)
  const urlParams = new URLSearchParams(window.location.search);
  const prefillType = urlParams.get("type") as "dispatch" | "return" | "general" | null;
  const prefillFleetId = urlParams.get("fleetId");
  const prefillFleetLabel = urlParams.get("fleetLabel");
  const prefillRentalId = urlParams.get("rentalId");
  const hasPrefill = !!(prefillType && prefillFleetId);

  const [step, setStep] = useState<Step>(hasPrefill ? "readings" : "type");

  const STEPS: { key: Step; label: string }[] = [
    { key: "type", label: t("field.type") },
    { key: "equipment", label: t("field.equipment") },
    { key: "readings", label: t("field.readings") },
    { key: "photos", label: t("field.photos") },
    { key: "condition", label: t("field.condition") },
    { key: "signature", label: t("field.signature") },
    { key: "review", label: t("field.review") },
  ];

  // Form data — pre-fill from URL params if coming from delivery
  const [inspectionType, setInspectionType] = useState<"dispatch" | "return" | "general">(prefillType || "dispatch");
  const [selectedFleetId, setSelectedFleetId] = useState<number | null>(prefillFleetId ? Number(prefillFleetId) : null);
  const [selectedEquipmentLabel, setSelectedEquipmentLabel] = useState(prefillFleetLabel || "");
  const [linkedRentalId, setLinkedRentalId] = useState<number | null>(prefillRentalId ? Number(prefillRentalId) : null);
  const [engineHours, setEngineHours] = useState("");
  const [fuelLevel, setFuelLevel] = useState(50);
  const [odometerReading, setOdometerReading] = useState("");
  const [overallCondition, setOverallCondition] = useState<"excellent" | "good" | "fair" | "poor">("good");
  const [damageSeverity, setDamageSeverity] = useState<"none" | "minor" | "moderate" | "severe">("none");
  const [damageNotes, setDamageNotes] = useState("");
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const { canvasRef: signatureCanvasRef, signature, setSignature: _setSignature, handlers: signatureHandlers, clear: clearSignature } = useSignaturePad({ strokeStyle: "#2563EB" });
  const [notes, setNotes] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [coords, setCoords] = useState<{ lat: string; lng: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentPhotoField, setCurrentPhotoField] = useState("");
  const [processingPhotos, setProcessingPhotos] = useState<Record<string, boolean>>({});
  const isProcessingPhotos = Object.keys(processingPhotos).length > 0;

  const [manualFuelPrice, setManualFuelPrice] = useState("3.00");

  const { data: fleetData } = trpc.inspections.getFleetForInspection.useQuery();
  const { data: activeRentals } = trpc.inspections.getActiveRentalsForInspection.useQuery();
  const { data: fuelData } = trpc.inspections.getFuelData.useQuery(
    { rentalId: linkedRentalId || undefined, fleetId: selectedFleetId || undefined },
    { enabled: !!(selectedFleetId || linkedRentalId) }
  );
  const [equipmentMode, setEquipmentMode] = useState<"rental" | "fleet">("rental");

  // Fuel charge calculation for return inspections
  const isReturn = inspectionType === "return";
  const tankCapacity = fuelData?.fuelTankCapacityLitres || 0;
  const effectiveFuelPrice = fuelData?.fuelPricePerLitre || parseFloat(manualFuelPrice) || 3.00;
  const fuelDeficitPct = Math.max(0, 100 - fuelLevel);
  const estimatedFuelCharge = isReturn && tankCapacity > 0 && fuelDeficitPct > 0
    ? Math.round(((fuelDeficitPct / 100) * tankCapacity * effectiveFuelPrice) * 100) / 100
    : 0;

  const createInspection = trpc.inspections.create.useMutation({
    onSuccess: async () => {
      await utils.rentalAssetProgress.fieldList.invalidate();
      if (linkedRentalId) await utils.rentalAssetProgress.byRental.invalidate({ rentalId: linkedRentalId });
      toast.success(t("field.submitSuccess"));
      setLocation(hasPrefill ? "/field-deliveries" : "/field-dashboard");
    },
    onError: (err) => {
      toast.error(t("field.submitError") + " " + serverErrorText(err));
    },
  });

  // Get GPS location
  const getLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude.toString(), lng: pos.coords.longitude.toString() });
        toast.success(t("field.locationCaptured"));
      },
      () => toast.error(t("field.locationError"))
    );
  }, [t]);

  // Photo capture
  const capturePhoto = (field: string) => {
    setCurrentPhotoField(field);
    fileInputRef.current?.click();
  };

  const handlePhotoCapture = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const field = currentPhotoField;
    e.target.value = "";
    if (!field) return;
    if (!file || file.size === 0) {
      // Android/Huawei camera intents occasionally return no file or an empty file
      toast.error(t("field.photoSaveFailed"));
      return;
    }

    setProcessingPhotos((prev) => ({ ...prev, [field]: true }));
    let done = false;
    const finish = (dataUrl?: string) => {
      if (done) return;
      done = true;
      window.clearTimeout(watchdog);
      setProcessingPhotos((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
      if (dataUrl) {
        setPhotos((prev) => ({ ...prev, [field]: dataUrl }));
      } else {
        toast.error(t("field.photoSaveFailed"));
      }
    };
    const watchdog = window.setTimeout(() => finish(), 20000);

    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result !== "string") {
        finish();
        return;
      }
      const compressed = await compressImage(reader.result, 1024, 0.8);
      finish(compressed);
    };
    reader.onerror = () => finish();
    reader.readAsDataURL(file);
  };

  // Submit
  const handleSubmit = async () => {
    if (isProcessingPhotos) {
      toast.error(t("field.photoStillSaving"));
      return;
    }
    const data = {
      type: inspectionType,
      rentalFleetId: selectedFleetId || undefined,
      rentalId: linkedRentalId || undefined,
      equipmentSelected: selectedEquipmentLabel || undefined,
      engineHours: engineHours ? parseFloat(engineHours) : undefined,
      fuelLevel: fuelLevel,
      fuelLevelPercent: fuelLevel,
      fuelChargeAmount: estimatedFuelCharge > 0 ? estimatedFuelCharge : undefined,
      odometerReading: odometerReading ? parseInt(odometerReading) : undefined,
      overallCondition,
      damageSeverity: damageSeverity !== "none" ? damageSeverity : undefined,
      damageNotes: damageNotes || undefined,
      locationAddress: locationAddress || undefined,
      latitude: coords?.lat,
      longitude: coords?.lng,
      photoFront: photos.front || undefined,
      photoBack: photos.back || undefined,
      photoLeft: photos.left || undefined,
      photoRight: photos.right || undefined,
      photoAdditional: photos.additional || undefined,
      customerSignature: signature || undefined,
      customerSignedAt: signature ? new Date().toISOString() : undefined,
      notes: notes || undefined,
      offlineId: nanoid(),
    };

    if (navigator.onLine) {
      createInspection.mutate(data);
    } else {
      await savePendingInspection(data);
      toast.success(t("field.savedOffline"));
      setLocation("/field-dashboard");
    }
  };

  const typeDescriptions: Record<string, string> = {
    dispatch: t("field.beforeDelivery"),
    return: t("field.whenReturned"),
    general: t("field.generalCheck"),
  };

  const conditionLabels: Record<string, string> = {
    excellent: t("condition.excellent", { ns: "common" }),
    good: t("condition.good", { ns: "common" }),
    fair: t("condition.fair", { ns: "common" }),
    poor: t("condition.poor", { ns: "common" }),
  };

  const damageLabels: Record<string, string> = {
    none: t("field.damageNone"),
    minor: t("field.damageMinor"),
    moderate: t("field.damageModerate"),
    severe: t("field.damageSevere"),
  };

  const photoFields = [
    { key: "front", label: t("front") },
    { key: "back", label: t("back") },
    { key: "left", label: t("left") },
    { key: "right", label: t("right") },
    { key: "additional", label: t("additional") },
  ];

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-lg mx-auto">
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoCapture} />

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => {
            const currentIdx = STEPS.findIndex(s => s.key === step);
            const firstStep = hasPrefill ? 2 : 0; // readings is index 2 when pre-filled
            if (currentIdx <= firstStep) {
              setLocation(hasPrefill ? "/field-deliveries" : "/field-dashboard");
            } else {
              setStep(STEPS[currentIdx - 1].key);
            }
          }} className="text-slate-500" aria-label="Go back">
            <ArrowLeft size={24} />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-slate-900">{t("field.title")}</h1>
            <p className="text-xs text-slate-500">{branding.companyName}</p>
          </div>
          <LanguageSwitcher />
        </div>

        {/* Step Progress Bar */}
        <div className="flex items-center justify-between mb-6 px-2">
          {STEPS.map((s, i) => {
            const currentIdx = STEPS.findIndex(st => st.key === step);
            const isComplete = i < currentIdx;
            const isCurrent = i === currentIdx;
            return (
              <div key={s.key} className="flex flex-col items-center flex-1">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 ${isCurrent ? "border-red-600 bg-red-600 text-white" : isComplete ? "border-green-500 bg-green-500 text-white" : "border-slate-300 bg-[var(--surface-container-lowest)] text-slate-400"}`}>
                  {isComplete ? "\u2713" : i + 1}
                </div>
                <span className={`text-[10px] mt-1 ${isCurrent ? "text-red-600 font-semibold" : isComplete ? "text-green-600" : "text-slate-400"}`}>{s.label}</span>
              </div>
            );
          })}
        </div>

        {/* Pre-fill banner from delivery */}
        {hasPrefill && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 text-sm">
            <p className="text-blue-700 font-medium">{t("field.linkedDelivery")}</p>
            <p className="text-blue-600 text-xs mt-1">
              {t(inspectionType)} — {selectedEquipmentLabel}
              {linkedRentalId ? ` · ${t("field.rental")} ${activeRentals?.find(r => r.id === linkedRentalId)?.rentalNumber || `#${linkedRentalId}`}` : ""}
            </p>
          </div>
        )}

        {/* Step: Type */}
        {step === "type" && (
          <div className="space-y-4">
            <h2 className="text-slate-900 font-semibold">{t("field.inspectionType")}</h2>
            {(["dispatch", "return", "general"] as const).map((tp) => (
              <button
                key={tp}
                onClick={() => { setInspectionType(tp); setStep("equipment"); }}
                className={`card w-full text-left hover:border-red-600/50 ${inspectionType === tp ? "border-red-600" : ""}`}
              >
                <div className="text-slate-900 font-semibold capitalize">{t(tp)}</div>
                <div className="text-sm text-slate-500">
                  {typeDescriptions[tp]}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Step: Equipment */}
        {step === "equipment" && (
          <div className="space-y-4">
            {/* Tab: Rental Orders vs All Fleet */}
            <div className="flex gap-2">
              <button
                onClick={() => setEquipmentMode("rental")}
                className={`flex-1 py-2 rounded-lg text-sm font-medium ${equipmentMode === "rental" ? "bg-red-600 text-white" : "bg-[var(--surface-container-lowest)] border border-slate-200 text-slate-600"}`}
              >
                {t("field.fromRentalOrder")} {activeRentals?.length ? `(${activeRentals.length})` : ""}
              </button>
              <button
                onClick={() => setEquipmentMode("fleet")}
                className={`flex-1 py-2 rounded-lg text-sm font-medium ${equipmentMode === "fleet" ? "bg-red-600 text-white" : "bg-[var(--surface-container-lowest)] border border-slate-200 text-slate-600"}`}
              >
                {t("field.fromFleetList")}
              </button>
            </div>

            {equipmentMode === "rental" ? (
              <>
                <h2 className="text-slate-900 font-semibold">{t("field.selectRentalOrder")}</h2>
                {activeRentals && activeRentals.length > 0 ? activeRentals.map((r) => (
                  <button
                    key={`${r.id}-${r.fleetId ?? r.lineItemId ?? "x"}`}
                    onClick={() => {
                      setSelectedFleetId(r.fleetId);
                      setSelectedEquipmentLabel(`${r.fleetBrand} ${r.fleetModel}`);
                      setLinkedRentalId(r.id);
                      if (inspectionType === "general") {
                        // On-hire units (active OR overdue) get a return/check-out
                        // inspection; not-yet-dispatched ones (approved/pending) get dispatch.
                        setInspectionType(r.status === "active" || r.status === "overdue" ? "return" : "dispatch");
                      }
                      setStep("readings");
                    }}
                    className="card w-full text-left hover:border-red-600/50"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-slate-900 font-semibold">{r.fleetBrand} {r.fleetModel}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${r.status === "active" ? "bg-green-100 text-green-700" : r.status === "overdue" ? "bg-red-100 text-red-700" : r.status === "approved" ? "bg-blue-100 text-blue-700" : "bg-yellow-100 text-yellow-700"}`}>
                        {t(`status.${r.status}`, { ns: "common" })}
                      </span>
                    </div>
                    <div className="text-sm text-slate-500 mt-1">
                      {t("field.rental")} {r.rentalNumber || `#${r.id}`} · {r.customerName}
                    </div>
                    {r.fleetSerialNumber && (
                      <div className="text-sm text-slate-700 font-mono mt-0.5">{t("sn")} {r.fleetSerialNumber}</div>
                    )}
                    <div className="text-xs text-slate-400 mt-0.5">
                      {fmtDate(r.startDate)} → {fmtDate(r.endDate)}
                    </div>
                  </button>
                )) : (
                  <div className="text-center py-6 text-slate-400 text-sm">{t("field.noActiveRentals")}</div>
                )}
              </>
            ) : (
              <>
                <h2 className="text-slate-900 font-semibold">{t("field.selectEquipment")}</h2>
                {fleetData?.map((item) => {
                  const f = item.rental_fleet;
                  return (
                    <button
                      key={f.id}
                      onClick={() => { setSelectedFleetId(f.id); setSelectedEquipmentLabel(`${f.brand} ${f.model}`); setLinkedRentalId(null); setStep("readings"); }}
                      className={`card w-full text-left hover:border-red-600/50 ${selectedFleetId === f.id ? "border-red-600" : ""}`}
                    >
                      <div className="text-slate-900 font-semibold">{f.brand} {f.model}</div>
                      {f.serialNumber && <div className="text-sm text-slate-700 font-mono mt-0.5">{t("sn")} {f.serialNumber}</div>}
                      <div className="text-sm text-slate-500">{f.category}</div>
                    </button>
                  );
                })}
                {!fleetData?.length && <div className="text-slate-500">{t("field.noFleetAssets")}</div>}
              </>
            )}
          </div>
        )}

        {/* Step: Readings */}
        {step === "readings" && (
          <div className="space-y-4">
            <h2 className="text-slate-900 font-semibold">{t("field.equipmentReadings")}</h2>
            <div>
              <label className="block text-sm text-slate-500 mb-1">{t("engineHours")}</label>
              <input type="number" inputMode="decimal" step="0.1" value={engineHours} onChange={(e) => setEngineHours(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900" />
            </div>
            <div>
              <label className="block text-sm text-slate-500 mb-2">{t("field.fuelPercent")}</label>
              <FuelGauge value={fuelLevel} onChange={setFuelLevel} />
            </div>

            {/* Fuel charge calculation for return inspections */}
            {isReturn && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1 text-sm">
                <p className="font-semibold text-amber-800">{t("field.fuelChargeCalc")}</p>
                <div className="text-amber-700 space-y-0.5">
                  <p>{t("field.fuelDeficit")}: {fuelDeficitPct}%</p>
                  <p>{t("field.tankCapacity")}: {tankCapacity > 0 ? `${tankCapacity} L` : t("field.notSet")}</p>
                  <p>{t("field.fuelPriceLabel")}: ${effectiveFuelPrice.toFixed(2)}/L</p>
                  {!fuelData?.fuelPricePerLitre && (
                    <div className="mt-1">
                      <label className="block text-xs text-amber-600 mb-1">{t("field.enterFuelPrice")}</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={manualFuelPrice}
                        onChange={(e) => setManualFuelPrice(e.target.value)}
                        className="w-32 bg-[var(--surface-container-lowest)] border border-amber-300 rounded px-2 py-1 text-sm text-slate-900"
                      />
                    </div>
                  )}
                </div>
                <p className="font-bold text-amber-900 text-base pt-1 border-t border-amber-200 mt-1">
                  {t("field.estimatedFuelCharge")}: ${estimatedFuelCharge.toFixed(2)}
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm text-slate-500 mb-1">{t("odometer")}</label>
              <input type="number" inputMode="numeric" value={odometerReading} onChange={(e) => setOdometerReading(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900" />
            </div>

            <div className="flex items-center gap-2">
              <button onClick={getLocation} className="btn-secondary flex items-center gap-2">
                <MapPin size={16} /> {t("field.getLocation")}
              </button>
              {coords && <span className="text-xs text-green-400">{t("field.locationCaptured")}</span>}
            </div>

            <div>
              <label className="block text-sm text-slate-500 mb-1">{t("field.locationAddress")}</label>
              <input type="text" value={locationAddress} onChange={(e) => setLocationAddress(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900" placeholder={t("field.enterOrDetect")} />
            </div>

            <button onClick={() => setStep("photos")} className="btn-primary w-full py-3">{t("field.nextPhotos")}</button>
          </div>
        )}

        {/* Step: Photos */}
        {step === "photos" && (
          <div className="space-y-4">
            <h2 className="text-slate-900 font-semibold">{t("field.equipmentPhotos")}</h2>
            <div className="grid grid-cols-2 gap-3">
              {photoFields.map((pf) => (
                <button
                  key={pf.key}
                  onClick={() => capturePhoto(pf.key)}
                  disabled={!!processingPhotos[pf.key]}
                  className="card flex flex-col items-center justify-center py-6 hover:border-red-600/50"
                >
                  {processingPhotos[pf.key] ? (
                    <div className="w-full h-24 flex flex-col items-center justify-center rounded-lg bg-slate-100">
                      <Loader2 size={28} className="animate-spin text-red-600" />
                      <span className="text-xs text-slate-500 mt-1">{t("field.photoSaving")}</span>
                    </div>
                  ) : photos[pf.key] ? (
                    <img src={photos[pf.key]} alt={pf.label} className="w-full h-24 object-cover rounded-lg" />
                  ) : (
                    <Camera size={32} className="text-slate-400 mb-2" />
                  )}
                  <span className="text-sm text-slate-600 mt-1">{pf.label}</span>
                </button>
              ))}
            </div>
            <button onClick={() => setStep("condition")} disabled={isProcessingPhotos} className="btn-primary w-full py-3 disabled:opacity-50">
              {isProcessingPhotos ? t("field.photoStillSaving") : t("field.nextCondition")}
            </button>
          </div>
        )}

        {/* Step: Condition */}
        {step === "condition" && (
          <div className="space-y-4">
            <h2 className="text-slate-900 font-semibold">{t("field.conditionAssessment")}</h2>
            <div className="grid grid-cols-2 gap-3">
              {(["excellent", "good", "fair", "poor"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setOverallCondition(c)}
                  className={`card text-center py-3 ${overallCondition === c ? "border-red-600 text-red-500" : "text-slate-600"}`}
                >
                  {conditionLabels[c]}
                </button>
              ))}
            </div>
            <div className="mt-4">
              <label className="block text-sm text-slate-500 mb-2">{t("field.damageSeverity")}</label>
              <div className="grid grid-cols-4 gap-2">
                {(["none", "minor", "moderate", "severe"] as const).map((sev) => (
                  <button
                    key={sev}
                    onClick={() => setDamageSeverity(sev)}
                    className={`py-2 rounded-lg border text-xs font-medium ${damageSeverity === sev ? "border-red-600 bg-red-50 text-red-700" : "border-slate-200 text-slate-600"}`}
                  >
                    {damageLabels[sev]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-500 mb-1">{t("field.damageNotes")}</label>
              <textarea value={damageNotes} onChange={(e) => setDamageNotes(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900 h-24 resize-none" placeholder={t("field.describeDamage")} />
            </div>
            <div>
              <label className="block text-sm text-slate-500 mb-1">{t("field.additionalNotes")}</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-3 text-slate-900 h-24 resize-none" />
            </div>
            <button onClick={() => setStep("signature")} className="btn-primary w-full py-3">{t("field.nextSignature")}</button>
          </div>
        )}

        {/* Step: Signature */}
        {step === "signature" && (
          <div className="space-y-4">
            <h2 className="text-slate-900 font-semibold">{t("field.customerSignature")}</h2>
            <div className="card p-2">
              <canvas
                ref={signatureCanvasRef}
                className="w-full bg-[var(--surface-container-lowest)] rounded-lg touch-none"
                style={{ height: "200px" }}
                {...signatureHandlers}
              />
            </div>
            <button
              onClick={clearSignature}
              className="btn-secondary w-full"
            >
              {t("field.clearSignature")}
            </button>
            <button onClick={() => setStep("review")} className="btn-primary w-full py-3">{t("field.reviewSubmit")}</button>
          </div>
        )}

        {/* Step: Review */}
        {step === "review" && (
          <div className="space-y-4">
            <h2 className="text-slate-900 font-semibold">{t("field.reviewInspection")}</h2>
            <div className="card space-y-2 text-sm">
              <div><span className="text-slate-500">{t("field.typeLabel")}</span> <span className="text-slate-900 capitalize">{t(inspectionType)}</span></div>
              <div><span className="text-slate-500">{t("field.equipmentLabel")}</span> <span className="text-slate-900">{selectedEquipmentLabel || t("none", { ns: "common" })}</span></div>
              <div><span className="text-slate-500">{t("field.engineLabel")}</span> <span className="text-slate-900">{engineHours || t("na")}</span></div>
              <div><span className="text-slate-500">{t("field.fuelLabel")}</span> <span className="text-slate-900">{fuelGaugeLabel(fuelLevel)}</span></div>
              <div><span className="text-slate-500">{t("field.conditionLabel")}</span> <span className="text-slate-900">{conditionLabels[overallCondition]}</span></div>
              <div><span className="text-slate-500">{t("field.damageLabel")}</span> <span className="text-slate-900">{damageLabels[damageSeverity]}</span></div>
              <div>
                <span className="text-slate-500">{t("field.photosLabel")}</span> <span className="text-slate-900">{Object.keys(photos).length} {t("field.captured")}</span>
                {Object.keys(photos).length > 0 && (
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    {photoFields.map((pf) => photos[pf.key] ? (
                      <div key={pf.key} className="text-center">
                        <img src={photos[pf.key]} alt={pf.label} className="w-full h-20 object-cover rounded-lg border border-slate-200" />
                        <span className="text-xs text-slate-400">{pf.label}</span>
                      </div>
                    ) : null)}
                  </div>
                )}
              </div>
              {isReturn && estimatedFuelCharge > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded p-2 mt-2 space-y-1">
                  <div><span className="text-amber-700 font-medium">{t("field.fuelChargeLabel")}: </span><span className="text-amber-900 font-bold">${estimatedFuelCharge.toFixed(2)}</span></div>
                </div>
              )}
              {isReturn && (damageSeverity === "moderate" || damageSeverity === "severe") && (
                <div className="bg-red-50 border border-red-200 rounded p-2 mt-2">
                  <span className="text-red-700 font-medium">{t("field.damageClaimWillCreate")}</span>
                </div>
              )}
              <div><span className="text-slate-500">{t("field.signatureLabel")}</span> <span className="text-slate-900">{signature ? t("yes", { ns: "common" }) : t("no", { ns: "common" })}</span></div>
              <div><span className="text-slate-500">{t("field.locationLabel")}</span> <span className="text-slate-900">{coords ? t("field.capturedText") : t("no", { ns: "common" })}</span></div>
            </div>

            <button
              onClick={handleSubmit}
              disabled={createInspection.isPending || isProcessingPhotos}
              className="btn-primary w-full py-3 disabled:opacity-50"
            >
              {createInspection.isPending ? t("field.submitting") : isProcessingPhotos ? t("field.photoStillSaving") : navigator.onLine ? t("field.submitInspection") : t("field.saveOffline")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
