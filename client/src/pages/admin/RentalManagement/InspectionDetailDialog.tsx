import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { compressImage } from "@/lib/imageUtils";
import { Upload, X as XIcon } from "lucide-react";
import { serverErrorText } from "@/lib/serverError";
import { translateDynamic } from "@/lib/i18nHelpers";

type Angle = "photoFront" | "photoBack" | "photoLeft" | "photoRight" | "photoAdditional";
type Condition = "excellent" | "good" | "fair" | "poor";
type DamageSeverity = "none" | "minor" | "moderate" | "severe";
type InspType = "dispatch" | "return" | "general";

// Pending = newly-dropped photos waiting for an angle assignment + upload
interface PendingPhoto {
  id: string;
  preview: string;
  angle: Angle;
}

interface ExistingPhotos {
  photoFront: string | null;
  photoBack: string | null;
  photoLeft: string | null;
  photoRight: string | null;
  photoAdditional: string | null;
}

const ANGLE_KEYS: Angle[] = ["photoFront", "photoBack", "photoLeft", "photoRight", "photoAdditional"];

interface Props {
  // Edit mode: pass inspectionId. Create mode: omit and pass rentalId + rentalFleetId
  inspectionId?: number;
  rentalId?: number;
  rentalFleetId?: number;
  defaultType?: InspType;
  onClose: () => void;
}

export default function InspectionDetailDialog({
  inspectionId,
  rentalId,
  rentalFleetId,
  defaultType = "general",
  onClose,
}: Props) {
  const { t } = useTranslation(["rental", "common", "inspection"]);
  const utils = trpc.useUtils();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isEditMode = !!inspectionId;

  const { data: existing, isLoading } = trpc.inspections.getById.useQuery(
    { id: inspectionId! },
    { enabled: isEditMode },
  );

  // Form state
  const [type, setType] = useState<InspType>(defaultType);
  const [inspectorName, setInspectorName] = useState("");
  const [engineHours, setEngineHours] = useState("");
  const [odometerReading, setOdometerReading] = useState("");
  const [fuelLevel, setFuelLevel] = useState<number>(100);
  const [overallCondition, setOverallCondition] = useState<Condition | "">("");
  const [damageSeverity, setDamageSeverity] = useState<DamageSeverity>("none");
  const [damageNotes, setDamageNotes] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [notes, setNotes] = useState("");

  // Photos
  const [existingPhotos, setExistingPhotos] = useState<ExistingPhotos>({
    photoFront: null, photoBack: null, photoLeft: null, photoRight: null, photoAdditional: null,
  });
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [dragHover, setDragHover] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Populate form on load
  useEffect(() => {
    if (!isEditMode || !existing) return;
    const insp = existing.inspections;
    setType(insp.type);
    setInspectorName(insp.inspectorName ?? "");
    setEngineHours(insp.engineHours?.toString() ?? "");
    setOdometerReading(insp.odometerReading?.toString() ?? "");
    setFuelLevel(insp.fuelLevel ?? insp.fuelLevelPercent ?? 100);
    setOverallCondition((insp.overallCondition as Condition) ?? "");
    setDamageSeverity((insp.damageSeverity as DamageSeverity) ?? "none");
    setDamageNotes(insp.damageNotes ?? "");
    setLocationAddress(insp.locationAddress ?? "");
    setNotes(insp.notes ?? "");
    setExistingPhotos({
      photoFront: insp.photoFront,
      photoBack: insp.photoBack,
      photoLeft: insp.photoLeft,
      photoRight: insp.photoRight,
      photoAdditional: insp.photoAdditional,
    });
  }, [existing, isEditMode]);

  const createMut = trpc.inspections.create.useMutation();
  const updateMut = trpc.inspections.update.useMutation();

  const pickNextEmptyAngle = useCallback((occupied: Angle[]): Angle => {
    for (const a of ANGLE_KEYS) {
      const used = occupied.includes(a) || (existingPhotos[a] && !existingPhotos[a]?.startsWith("data:"));
      if (!used) return a;
    }
    return "photoAdditional";
  }, [existingPhotos]);

  const ingestFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      toast.error(t("management.adminUploadOnlyImages"));
      return;
    }

    const occupied: Angle[] = [...pending.map((p) => p.angle)];
    const newOnes: PendingPhoto[] = [];

    for (const file of imageFiles) {
      const raw: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const compressed = await compressImage(raw, 1024, 0.8);
      const angle = pickNextEmptyAngle(occupied);
      occupied.push(angle);
      newOnes.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        preview: compressed,
        angle,
      });
    }
    setPending((cur) => [...cur, ...newOnes]);
  }, [pending, pickNextEmptyAngle, t]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragHover(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) ingestFiles(files);
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) ingestFiles(files);
    e.target.value = "";
  };

  // Paste support
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file") {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) ingestFiles(files);
    };
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, [ingestFiles]);

  const updatePendingAngle = (id: string, angle: Angle) => {
    setPending((cur) => cur.map((p) => (p.id === id ? { ...p, angle } : p)));
  };

  const removePending = (id: string) => {
    setPending((cur) => cur.filter((p) => p.id !== id));
  };

  const clearExistingPhoto = (angle: Angle) => {
    setExistingPhotos((cur) => ({ ...cur, [angle]: null }));
  };

  const handleSubmit = async () => {
    if (!isEditMode && !rentalFleetId && !rentalId) {
      toast.error(t("management.adminUploadNeedsRentalContext"));
      return;
    }

    setSubmitting(true);
    try {
      // Merge pending → photo fields. Later pending photos on the same angle
      // overwrite earlier ones (admin can keep the most recent take).
      const merged: ExistingPhotos = { ...existingPhotos };
      for (const p of pending) {
        merged[p.angle] = p.preview;
      }

      const common = {
        inspectorName: inspectorName || undefined,
        engineHours: engineHours ? parseInt(engineHours, 10) : undefined,
        odometerReading: odometerReading ? parseInt(odometerReading, 10) : undefined,
        fuelLevel,
        fuelLevelPercent: fuelLevel,
        overallCondition: overallCondition || undefined,
        damageSeverity: damageSeverity !== "none" ? damageSeverity : undefined,
        damageNotes: damageNotes || undefined,
        locationAddress: locationAddress || undefined,
        notes: notes || undefined,
      };

      if (isEditMode) {
        await updateMut.mutateAsync({
          id: inspectionId!,
          ...common,
          // For update, send each photo slot explicitly: base64 (new), URL (kept),
          // or null (cleared). Untouched slots are omitted.
          photoFront: photoFieldForUpdate("photoFront", merged, existing?.inspections?.photoFront),
          photoBack: photoFieldForUpdate("photoBack", merged, existing?.inspections?.photoBack),
          photoLeft: photoFieldForUpdate("photoLeft", merged, existing?.inspections?.photoLeft),
          photoRight: photoFieldForUpdate("photoRight", merged, existing?.inspections?.photoRight),
          photoAdditional: photoFieldForUpdate("photoAdditional", merged, existing?.inspections?.photoAdditional),
        });
        toast.success(t("management.adminInspectionUpdated"));
      } else {
        await createMut.mutateAsync({
          type,
          rentalId,
          rentalFleetId,
          ...common,
          photoFront: merged.photoFront ?? undefined,
          photoBack: merged.photoBack ?? undefined,
          photoLeft: merged.photoLeft ?? undefined,
          photoRight: merged.photoRight ?? undefined,
          photoAdditional: merged.photoAdditional ?? undefined,
        });
        toast.success(t("management.adminInspectionCreated"));
      }

      if (rentalId) {
        utils.inspections.getByRentalId.invalidate({ rentalId });
        utils.inspections.getComparisonForRental.invalidate({ rentalId });
        utils.rentalAssetProgress.byRental.invalidate({ rentalId });
        utils.rentalAssetProgress.fieldList.invalidate();
      }
      if (isEditMode) {
        utils.inspections.getById.invalidate({ id: inspectionId! });
      }
      onClose();
    } catch (err) {
      toast.error(serverErrorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (isEditMode && isLoading) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/50" onClick={onClose} />
        <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full p-8 text-center">
          <p className="text-slate-500">{t("management.loadingDetails")}</p>
        </div>
      </div>
    );
  }

  const totalPhotos = ANGLE_KEYS.filter((k) => existingPhotos[k]).length + pending.length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              {isEditMode
                ? `${t("management.editInspection")} #${inspectionId}`
                : t("management.newAdminInspection")}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {t("management.adminInspectionHint")}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl" aria-label={t("close", { ns: "common" })}>&times;</button>
        </div>

        <div className="p-6 space-y-5">
          {!isEditMode && (
            <div className="grid grid-cols-3 gap-2">
              {(["dispatch", "return", "general"] as InspType[]).map((tp) => (
                <button
                  key={tp}
                  onClick={() => setType(tp)}
                  className={`text-sm px-3 py-2 rounded border font-medium ${type === tp ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"}`}
                >
                  {translateDynamic(t, `management.inspType_${tp}`)}
                </button>
              ))}
            </div>
          )}

          {/* Drag-drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragHover(true); }}
            onDragLeave={() => setDragHover(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${dragHover ? "border-emerald-500 bg-emerald-50" : "border-slate-300 bg-slate-50 hover:bg-slate-100"}`}
          >
            <Upload size={28} className="mx-auto text-slate-400 mb-2" />
            <p className="text-sm font-medium text-slate-700">
              {t("management.adminUploadDropHere")}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {t("management.adminUploadHint")}
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onFileSelect}
            />
          </div>

          {/* Photo grid: existing + pending */}
          {totalPhotos > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                {t("management.photos")} · {totalPhotos}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {ANGLE_KEYS.map((angle) => {
                  const src = existingPhotos[angle];
                  if (!src) return null;
                  return (
                    <div key={`exist-${angle}`} className="relative group">
                      <img src={src} alt={t("management.photos")} className="w-full h-32 object-cover rounded-lg border border-slate-200" />
                      <div className="absolute top-1 right-1 flex gap-1">
                        <button
                          onClick={() => clearExistingPhoto(angle)}
                          className="bg-white/90 hover:bg-red-50 text-red-600 rounded-full p-1 shadow"
                          aria-label={t("delete", { ns: "common" })}
                        >
                          <XIcon size={12} />
                        </button>
                      </div>
                      <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-xs px-2 py-1 rounded-b-lg">
                        {translateDynamic(t, `photo.${angle.replace("photo", "").toLowerCase()}`, { ns: "common" })}
                      </div>
                    </div>
                  );
                })}
                {pending.map((p) => (
                  <div key={p.id} className="relative group">
                    <img src={p.preview} alt={t("management.pending")} className="w-full h-32 object-cover rounded-lg border-2 border-emerald-300" />
                    <button
                      onClick={() => removePending(p.id)}
                      className="absolute top-1 right-1 bg-white/90 hover:bg-red-50 text-red-600 rounded-full p-1 shadow"
                      aria-label={t("delete", { ns: "common" })}
                    >
                      <XIcon size={12} />
                    </button>
                    <select
                      value={p.angle}
                      onChange={(e) => updatePendingAngle(p.id, e.target.value as Angle)}
                      className="absolute bottom-1 inset-x-1 text-xs bg-white/95 border border-emerald-300 rounded px-1 py-0.5 text-slate-900"
                    >
                      {ANGLE_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {translateDynamic(t, `photo.${k.replace("photo", "").toLowerCase()}`, { ns: "common" })}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {pending.length > 0 && (
                <p className="text-xs text-emerald-700 mt-2">
                  {t("management.adminUploadPendingHint", { count: pending.length })}
                </p>
              )}
            </div>
          )}

          {/* Readings */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                {t("management.inspectorName")}
              </label>
              <input
                type="text"
                value={inspectorName}
                onChange={(e) => setInspectorName(e.target.value)}
                placeholder={t("management.adminInspectorPlaceholder")}
                className="w-full text-sm border border-slate-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                {t("management.engine")}
              </label>
              <input
                type="number"
                value={engineHours}
                onChange={(e) => setEngineHours(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                {t("management.odometer")}
              </label>
              <input
                type="number"
                value={odometerReading}
                onChange={(e) => setOdometerReading(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded px-3 py-2"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                {t("management.fuel")} ({fuelLevel}%)
              </label>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={fuelLevel}
                onChange={(e) => setFuelLevel(parseInt(e.target.value, 10))}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                {t("management.condition")}
              </label>
              <select
                value={overallCondition}
                onChange={(e) => setOverallCondition(e.target.value as Condition | "")}
                className="w-full text-sm border border-slate-300 rounded px-3 py-2 bg-white"
              >
                <option value="">—</option>
                {(["excellent", "good", "fair", "poor"] as Condition[]).map((c) => (
                  <option key={c} value={c}>{t(`condition.${c}`, { ns: "common" })}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1">
                {t("management.damageSeverity", { defaultValue: "Damage severity" })}
              </label>
              <select
                value={damageSeverity}
                onChange={(e) => setDamageSeverity(e.target.value as DamageSeverity)}
                className="w-full text-sm border border-slate-300 rounded px-3 py-2 bg-white"
              >
                {(["none", "minor", "moderate", "severe"] as DamageSeverity[]).map((d) => (
                  <option key={d} value={d}>
                    {t(`field.damage${d.charAt(0).toUpperCase()}${d.slice(1)}`, { ns: "inspection", defaultValue: d })}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 block mb-1">
              {t("management.location")}
            </label>
            <input
              type="text"
              value={locationAddress}
              onChange={(e) => setLocationAddress(e.target.value)}
              className="w-full text-sm border border-slate-300 rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 block mb-1">
              {t("management.damageNotes", { defaultValue: "Damage notes" })}
            </label>
            <textarea
              value={damageNotes}
              onChange={(e) => setDamageNotes(e.target.value)}
              rows={2}
              className="w-full text-sm border border-slate-300 rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 block mb-1">
              {t("management.notes", { defaultValue: "Notes" })}
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full text-sm border border-slate-300 rounded px-3 py-2"
            />
          </div>
        </div>

        <div className="sticky bottom-0 bg-white border-t border-slate-200 px-6 py-3 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="text-sm px-4 py-2 rounded border border-slate-300 text-slate-700 hover:bg-slate-50"
          >
            {t("management.cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="text-sm px-4 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50"
          >
            {submitting ? t("management.creating") : (isEditMode ? t("management.saveChanges") : t("management.create"))}
          </button>
        </div>
      </div>
    </div>
  );
}

function photoFieldForUpdate(
  angle: Angle,
  merged: ExistingPhotos,
  original: string | null | undefined,
): string | null | undefined {
  const current = merged[angle];
  const orig = original ?? null;
  // No change
  if ((current ?? null) === orig) return undefined;
  // Explicitly cleared
  if (current === null) return null;
  // New value (base64 or URL)
  return current;
}
