import { useState, useRef, useCallback } from "react";
import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { useBranding } from "@/config/branding";
import { toast } from "sonner";
import { Camera, CheckCircle, Loader2, MapPin, X, ChevronDown, ChevronUp } from "lucide-react";
import { compressImage } from "@/lib/imageUtils";
import { useTranslation } from "react-i18next";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { FuelGauge } from "@/components/FuelGauge";
import { useSignaturePad } from "@/hooks/useSignaturePad";
import { serverErrorText } from "@/lib/serverError";

const severityColors: Record<string, string> = {
  none: "text-green-600 border-green-500",
  minor: "text-yellow-600 border-yellow-500",
  moderate: "text-orange-600 border-orange-500",
  severe: "text-red-600 border-red-500",
};

export default function StaffInspection() {
  const { token } = useParams<{ token: string }>();
  const branding = useBranding();
  const { t } = useTranslation("inspection");
  const { data, isLoading, error } = trpc.inspections.verifyToken.useQuery({ token: token || "" });

  const photoFields = [
    { key: "front", label: t("front") },
    { key: "back", label: t("back") },
    { key: "left", label: t("left") },
    { key: "right", label: t("right") },
    { key: "additional", label: t("additional") },
  ];

  const severityOptions = [
    { value: "none", label: t("field.damageNone"), color: severityColors.none },
    { value: "minor", label: t("field.damageMinor"), color: severityColors.minor },
    { value: "moderate", label: t("field.damageModerate"), color: severityColors.moderate },
    { value: "severe", label: t("field.damageSevere"), color: severityColors.severe },
  ];

  const conditionLabels: Record<string, string> = {
    excellent: t("condition.excellent", { ns: "common" }),
    good: t("condition.good", { ns: "common" }),
    fair: t("condition.fair", { ns: "common" }),
    poor: t("condition.poor", { ns: "common" }),
  };

  // Form state
  const [overallCondition, setOverallCondition] = useState<"excellent" | "good" | "fair" | "poor">("good");
  const [damageSeverity, setDamageSeverity] = useState<"none" | "minor" | "moderate" | "severe">("none");
  const [notes, setNotes] = useState("");
  const [damageNotes, setDamageNotes] = useState("");
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [engineHours, setEngineHours] = useState("");
  const [fuelLevel, setFuelLevel] = useState(50);
  const [odometerReading, setOdometerReading] = useState("");
  const [coords, setCoords] = useState<{ lat: string; lng: string } | null>(null);
  const { canvasRef: signatureCanvasRef, signature, handlers: signatureHandlers, clear: clearSignature } = useSignaturePad({ strokeStyle: "#2563EB" });
  const [submitted, setSubmitted] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [manualFuelPrice, setManualFuelPrice] = useState("3.00");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentPhotoField, setCurrentPhotoField] = useState("");
  const [processingPhotos, setProcessingPhotos] = useState<Record<string, boolean>>({});
  const isProcessingPhotos = Object.keys(processingPhotos).length > 0;

  // Fuel data for charge calculation
  const { data: fuelData } = trpc.inspections.getFuelData.useQuery(
    { rentalId: data?.rentalId || undefined, fleetId: data?.rentalFleetId || undefined },
    { enabled: !!data }
  );

  const isReturn = data?.inspectionType === "return";
  const tankCapacity = fuelData?.fuelTankCapacityLitres || 0;
  const effectiveFuelPrice = fuelData?.fuelPricePerLitre || parseFloat(manualFuelPrice) || 3.00;
  const fuelDeficitPct = Math.max(0, 100 - fuelLevel);
  const estimatedFuelCharge = isReturn && tankCapacity > 0 && fuelDeficitPct > 0
    ? Math.round(((fuelDeficitPct / 100) * tankCapacity * effectiveFuelPrice) * 100) / 100
    : 0;

  const createInspection = trpc.inspections.createWithToken.useMutation({
    onSuccess: () => {
      setSubmitted(true);
      toast.success(t("staff.submitSuccess"));
    },
    onError: (err) => {
      toast.error(t("staff.submitError") + " " + serverErrorText(err));
    },
  });

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

  const removePhoto = (field: string) => {
    setPhotos((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  // GPS
  const getLocation = useCallback(() => {
    if (!navigator.geolocation) {
      toast.error(t("staff.geoNotSupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude.toString(), lng: pos.coords.longitude.toString() });
        toast.success(t("staff.locationCaptured", { defaultValue: "Location captured" }));
      },
      () => toast.error(t("staff.locationError"))
    );
  }, [t]);

  const handleSubmit = () => {
    if (!data || !token) return;
    if (isProcessingPhotos) {
      toast.error(t("field.photoStillSaving"));
      return;
    }
    createInspection.mutate({
      token,
      type: data.inspectionType as "dispatch" | "return" | "general",
      rentalId: data.rentalId ?? undefined,
      rentalFleetId: data.rentalFleetId ?? undefined,
      overallCondition,
      damageSeverity,
      damageNotes: damageNotes || undefined,
      notes: notes || undefined,
      engineHours: engineHours ? parseFloat(engineHours) : undefined,
      fuelLevel: fuelLevel,
      fuelLevelPercent: fuelLevel,
      fuelChargeAmount: estimatedFuelCharge > 0 ? estimatedFuelCharge : undefined,
      odometerReading: odometerReading ? parseInt(odometerReading) : undefined,
      latitude: coords?.lat,
      longitude: coords?.lng,
      photoFront: photos.front || undefined,
      photoBack: photos.back || undefined,
      photoLeft: photos.left || undefined,
      photoRight: photos.right || undefined,
      photoAdditional: photos.additional || undefined,
      customerSignature: signature || undefined,
      customerSignedAt: signature ? new Date().toISOString() : undefined,
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-900">{t("staff.verifying")}</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="card max-w-md text-center">
          <h1 className="text-xl font-bold text-red-400 mb-2">{t("staff.invalidToken")}</h1>
          <p className="text-slate-500">{t("staff.invalidMessage")}</p>
          <p className="text-sm text-slate-400 mt-4">{t("staff.contact")} {branding.companyName} {t("staff.forNewLink")}</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="card max-w-md text-center space-y-4">
          <CheckCircle size={48} className="text-green-500 mx-auto" />
          <h1 className="text-xl font-bold text-slate-900">{t("staff.submitted")}</h1>
          <p className="text-slate-500">{t("staff.thankYou")}</p>

          {/* Post-submission summary for return inspections */}
          {isReturn && (
            <div className="text-left bg-slate-50 rounded-lg p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">{t("staff.fuelLabel")}</span>
                <span className="text-slate-900 font-medium">{fuelLevel}%</span>
              </div>
              {estimatedFuelCharge > 0 && (
                <div className="flex justify-between">
                  <span className="text-amber-600 font-medium">{t("field.fuelChargeLabel")}</span>
                  <span className="text-amber-900 font-bold">${estimatedFuelCharge.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-500">{t("field.damageClaimLabel")}</span>
                <span className="text-slate-900">{(damageSeverity === "moderate" || damageSeverity === "severe") ? t("yes", { ns: "common" }) : t("no", { ns: "common" })}</span>
              </div>
              {signature && (
                <div className="flex justify-between">
                  <span className="text-slate-500">{t("staff.signatureLabel")}</span>
                  <span className="text-green-600">{t("field.capturedText")}</span>
                </div>
              )}
            </div>
          )}

          <p className="text-sm text-slate-400">{t("staff.closePage")}</p>
        </div>
      </div>
    );
  }

  const equipment = data.equipment;
  const isPending = createInspection.isPending;
  const photoCapturedCount = Object.keys(photos).length;

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-lg mx-auto">
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoCapture} />

        {/* Header */}
        <div className="text-center mb-6 relative">
          <div className="absolute right-0 top-0">
            <LanguageSwitcher />
          </div>
          <h1 className="text-xl font-bold text-slate-900">{branding.companyName}</h1>
          <p className="text-slate-500">{t("staff.title")}</p>
        </div>

        {/* Equipment Info */}
        <div className="card mb-6">
          <h2 className="text-lg font-bold text-slate-900 capitalize">{t("staff.inspectionType")}: {t(data.inspectionType)}</h2>
          {equipment && (
            <div className="mt-2 text-slate-600">
              <p>{equipment.rental_fleet?.brand} {equipment.rental_fleet?.model}</p>
              {equipment.rental_fleet?.serialNumber && (
                <p className="text-sm text-slate-500">{t("sn")} {equipment.rental_fleet.serialNumber}</p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-6">
          {/* Overall Condition */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 uppercase">{t("staff.overallCondition")}</h3>
            <div className="grid grid-cols-2 gap-2">
              {(["excellent", "good", "fair", "poor"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setOverallCondition(c)}
                  className={`py-2 px-3 rounded-lg border text-sm font-medium transition ${overallCondition === c ? "border-red-500 bg-red-50 text-red-700" : "border-slate-200 text-slate-600 hover:border-slate-300"}`}
                >
                  {conditionLabels[c]}
                </button>
              ))}
            </div>
          </div>

          {/* Damage Severity */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 uppercase">{t("field.damageSeverity")}</h3>
            <div className="grid grid-cols-2 gap-2">
              {severityOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setDamageSeverity(opt.value as "none" | "minor" | "moderate" | "severe")}
                  className={`py-2 px-3 rounded-lg border text-sm font-medium transition ${damageSeverity === opt.value ? `${opt.color} bg-opacity-10` : "border-slate-200 text-slate-600 hover:border-slate-300"}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {damageSeverity !== "none" && (
              <div>
                <label className="block text-sm text-slate-500 mb-1">{t("staff.damageNotes")}</label>
                <textarea
                  value={damageNotes}
                  onChange={(e) => setDamageNotes(e.target.value)}
                  placeholder={t("staff.describeDamage")}
                  className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900 h-20 resize-none"
                />
              </div>
            )}
          </div>

          {/* Equipment Readings */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 uppercase">{t("staff.equipmentReadings")}</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">{t("engineHours")}</label>
                <input type="number" inputMode="decimal" step="0.1" value={engineHours} onChange={(e) => setEngineHours(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" placeholder="0" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">{t("odometer")}</label>
                <input type="number" inputMode="numeric" value={odometerReading} onChange={(e) => setOdometerReading(e.target.value)} className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" placeholder="0" />
              </div>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-2">{t("staff.fuelPercent")}</label>
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
          </div>

          {/* GPS Location */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 uppercase">{t("location")}</h3>
            <button onClick={getLocation} className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm text-slate-700 transition">
              <MapPin size={16} /> {coords ? t("staff.updateLocation") : t("staff.captureLocation")}
            </button>
            {coords && <p className="text-xs text-green-600">{t("staff.locationCaptured")} {parseFloat(coords.lat).toFixed(5)}, {parseFloat(coords.lng).toFixed(5)}</p>}
          </div>

          {/* Notes */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 uppercase">{t("staff.notes")}</h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("staff.notesPlaceholder")}
              className="w-full bg-[var(--surface-container-lowest)] border border-slate-300 rounded-lg px-3 py-2 text-slate-900 h-24 resize-none"
            />
          </div>

          {/* Photos */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 uppercase">{t("staff.photos", { current: photoCapturedCount, max: 5 })}</h3>
            <div className="grid grid-cols-3 gap-3">
              {photoFields.map((pf) => (
                <div key={pf.key} className="relative">
                  {processingPhotos[pf.key] ? (
                    <div className="w-full h-32 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg bg-slate-50">
                      <Loader2 size={24} className="animate-spin text-red-600 mb-1" />
                      <span className="text-xs text-slate-500">{t("field.photoSaving")}</span>
                    </div>
                  ) : photos[pf.key] ? (
                    <div className="relative">
                      <img src={photos[pf.key]} alt={pf.label} className="w-full h-32 object-cover rounded-lg border border-slate-200" />
                      <button
                        onClick={() => removePhoto(pf.key)}
                        className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center shadow"
                        aria-label={`Remove ${pf.label} photo`}
                      >
                        <X size={14} />
                      </button>
                      <button
                        onClick={() => capturePhoto(pf.key)}
                        className="absolute bottom-1 right-1 w-7 h-7 bg-[var(--surface-container-lowest)]/80 rounded-full flex items-center justify-center shadow"
                        aria-label={`Retake ${pf.label} photo`}
                      >
                        <Camera size={14} className="text-slate-600" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => capturePhoto(pf.key)}
                      className="w-full h-32 flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg hover:border-red-500 transition-colors"
                    >
                      <Camera size={24} className="text-slate-400 mb-1" />
                      <span className="text-xs text-slate-500">{pf.label}</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Signature */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 uppercase">{t("signature")}</h3>
            <div className="border border-slate-300 rounded-lg overflow-hidden">
              <canvas
                ref={signatureCanvasRef}
                className="w-full bg-[var(--surface-container-lowest)] touch-none"
                style={{ height: "150px" }}
                {...signatureHandlers}
              />
            </div>
            <button onClick={clearSignature} className="text-sm text-slate-500 hover:text-slate-700">{t("field.clearSignature")}</button>
          </div>

          {/* Review Panel */}
          <div className="card">
            <button
              onClick={() => setShowReview(!showReview)}
              className="w-full flex items-center justify-between text-sm font-semibold text-slate-700 uppercase"
            >
              <span>{t("staff.reviewSummary")}</span>
              {showReview ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showReview && (
              <div className="mt-3 space-y-2 text-sm border-t border-slate-200 pt-3">
                <div className="flex justify-between"><span className="text-slate-500">{t("staff.conditionLabel")}</span><span className="text-slate-900">{conditionLabels[overallCondition]}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("staff.damageLabel")}</span><span className="text-slate-900">{severityOptions.find(o => o.value === damageSeverity)?.label}</span></div>
                {damageNotes && <div className="flex justify-between"><span className="text-slate-500">{t("staff.damageNotesLabel")}</span><span className="text-slate-900 truncate ml-2">{damageNotes}</span></div>}
                <div className="flex justify-between"><span className="text-slate-500">{t("staff.engineLabel")}</span><span className="text-slate-900">{engineHours || t("na")}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("staff.fuelLabel")}</span><span className="text-slate-900">{fuelLevel}%</span></div>
                {isReturn && estimatedFuelCharge > 0 && (
                  <div className="flex justify-between"><span className="text-amber-600 font-medium">{t("field.fuelChargeLabel")}</span><span className="text-amber-900 font-bold">${estimatedFuelCharge.toFixed(2)}</span></div>
                )}
                {isReturn && (damageSeverity === "moderate" || damageSeverity === "severe") && (
                  <div className="flex justify-between"><span className="text-red-600 font-medium">{t("field.damageClaimLabel")}</span><span className="text-red-700">{t("yes", { ns: "common" })}</span></div>
                )}
                <div className="flex justify-between"><span className="text-slate-500">{t("staff.odometerLabel")}</span><span className="text-slate-900">{odometerReading || t("na")}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("staff.locationLabel")}</span><span className="text-slate-900">{coords ? t("field.capturedText") : t("staff.notCaptured")}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("staff.photosLabel")}</span><span className="text-slate-900">{photoCapturedCount} {t("staff.ofMax", { max: 5 })}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">{t("staff.signatureLabel")}</span><span className="text-slate-900">{signature ? t("yes", { ns: "common" }) : t("no", { ns: "common" })}</span></div>
                {notes && <div className="flex justify-between"><span className="text-slate-500">{t("staff.notesLabel")}</span><span className="text-slate-900 truncate ml-2">{notes}</span></div>}
              </div>
            )}
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={isPending || isProcessingPhotos}
            className="btn-primary w-full py-3 disabled:opacity-50"
          >
            {isPending ? t("field.submitting") : isProcessingPhotos ? t("field.photoStillSaving") : t("field.submitInspection")}
          </button>
        </div>
      </div>
    </div>
  );
}
