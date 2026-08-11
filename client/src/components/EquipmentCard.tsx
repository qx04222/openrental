import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, MapPin, FileText, Video, Construction } from "lucide-react";
import PhotoLightbox from "./PhotoLightbox";

interface CatalogInfo {
  id: number | null;
  brand: string | null;
  model: string | null;
  category: string | null;
  modelYear: number | null;
  imageUrl: string | null;
  operatingWeight: string | null;
  description: string | null;
  specifications: string | null;
  enginePower: string | null;
  bucketCapacity: string | null;
  ratedLoad: string | null;
  galleryImages: string | null;
  brochureUrl: string | null;
  videoUrl: string | null;
}

interface WarehouseInfo {
  id: number | null;
  name: string | null;
  city: string | null;
  province: string | null;
}

interface FleetItem {
  id: number;
  brand: string;
  model: string;
  category: string | null;
  year: number | null;
  dailyRate: string | null;
  weeklyRate: string | null;
  monthlyRate: string | null;
  imageUrl: string | null;
  currentStatus: string;
}

interface ResolvedPricing {
  resolvedDailyRate?: string;
  resolvedWeeklyRate?: string;
  resolvedMonthlyRate?: string;
}

interface EquipmentCardProps {
  fleet: FleetItem;
  catalog: CatalogInfo | null;
  warehouse: WarehouseInfo | null;
  displayName: string | null;
  availableForDates: boolean | null;
  /** True when grouped units span multiple warehouses — show a generic location label. */
  multipleLocations?: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onRequestRental: () => void;
  onAddToCart?: () => void;
  resolvedPricing?: ResolvedPricing;
  /** Per-group counts. When provided, the card shows "X / Y available". */
  totalUnits?: number;
  availableUnits?: number | null;
  rentedUnits?: number;
  maintenanceUnits?: number;
}

function parseSpecs(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // not JSON — ignore
  }
  return {};
}

function parseGallery(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string" && s.length > 0);
  } catch {
    // try comma-separated
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export default function EquipmentCard({
  fleet,
  catalog,
  warehouse,
  displayName,
  availableForDates,
  multipleLocations,
  isExpanded,
  onToggleExpand,
  onRequestRental,
  onAddToCart,
  resolvedPricing,
  totalUnits: _totalUnits,
  availableUnits: _availableUnits,
  rentedUnits: _rentedUnits,
  maintenanceUnits: _maintenanceUnits,
}: EquipmentCardProps) {
  const { t } = useTranslation(["rental", "fleet"]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const isUnavailable = availableForDates === false;

  const imageUrl = fleet.imageUrl || catalog?.imageUrl;
  const repLocation = warehouse?.city && warehouse?.province
    ? `${warehouse.city}, ${warehouse.province}`
    : warehouse?.name || null;
  const location = multipleLocations ? t("multipleLocations") : repLocation;

  // Build specs list
  const specEntries: { label: string; value: string }[] = [];
  if (catalog?.enginePower) specEntries.push({ label: t("specs.enginePower", { ns: "fleet" }), value: catalog.enginePower });
  if (catalog?.operatingWeight) specEntries.push({ label: t("specs.operatingWeight", { ns: "fleet" }), value: catalog.operatingWeight });
  if (catalog?.bucketCapacity) specEntries.push({ label: t("specs.bucketCapacity", { ns: "fleet" }), value: catalog.bucketCapacity });
  if (catalog?.ratedLoad) specEntries.push({ label: t("specs.ratedLoad", { ns: "fleet" }), value: catalog.ratedLoad });
  const extraSpecs = parseSpecs(catalog?.specifications);
  for (const [key, val] of Object.entries(extraSpecs)) {
    specEntries.push({ label: key, value: val });
  }

  const gallery = parseGallery(catalog?.galleryImages);
  const hasDetails = catalog?.description || specEntries.length > 0 || gallery.length > 0 || catalog?.brochureUrl || catalog?.videoUrl;

  // Price display — use resolved rates (fleet override → category → none)
  const daily = resolvedPricing?.resolvedDailyRate || fleet.dailyRate;
  const weekly = resolvedPricing?.resolvedWeeklyRate || fleet.weeklyRate;
  const monthly = resolvedPricing?.resolvedMonthlyRate || fleet.monthlyRate;
  const prices: { amount: string; suffix: string }[] = [];
  if (daily && daily !== "0") prices.push({ amount: daily, suffix: t("perDay") });
  if (weekly && weekly !== "0") prices.push({ amount: weekly, suffix: t("perWeek") });
  if (monthly && monthly !== "0") prices.push({ amount: monthly, suffix: t("perMonth") });

  return (
    <div className={`card transition-colors relative h-full flex flex-col ${isUnavailable ? "opacity-60" : "hover:border-[var(--primary)]/50"}`}>
      {/* Availability Badge — binary green/red, no stock counts shown to customer */}
      {availableForDates !== null && (
        <span className={`absolute top-3 right-3 px-2 py-0.5 rounded-full text-xs font-medium z-10 ${
          isUnavailable
            ? "bg-[var(--primary)]/10 text-[var(--primary)]"
            : "bg-green-100 text-green-600"
        }`}>
          {isUnavailable ? t("unavailable") : t("availableBadge")}
        </span>
      )}

      {/* Maintenance badge for the no-date case */}
      {fleet.currentStatus === "maintenance" && availableForDates === null && (
        <span className="absolute top-3 right-3 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-600 z-10">
          {t("maintenance")}
        </span>
      )}


      {/* Image — always reserve the same block so titles line up across a row,
          even for units without a photo (consistent grid, no layout shift). */}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`${fleet.brand} ${fleet.model}`}
          loading="lazy"
          className="w-full h-48 object-cover rounded-lg mb-4"
        />
      ) : (
        <div className="w-full h-48 rounded-lg mb-4 bg-slate-100 flex items-center justify-center text-slate-300">
          <Construction size={48} strokeWidth={1.25} />
        </div>
      )}

      {/* Title */}
      <h4 className="text-lg font-bold text-slate-900 leading-snug">
        {displayName || fleet.category || `${fleet.brand} ${fleet.model}`}
      </h4>

      {/* Brand / Model / Year */}
      <p className="mt-1 text-sm text-slate-500">
        {fleet.brand} {fleet.model}
        {fleet.year ? ` \u00B7 ${fleet.year}` : ""}
      </p>

      {/* Location */}
      {location && (
        <p className="mt-1 text-sm text-slate-500 inline-flex items-center gap-1">
          <MapPin size={13} className="text-slate-400 shrink-0" />
          <span>{location}</span>
        </p>
      )}

      {/* Per-status unit breakdown intentionally hidden from customer view —
          the totals are admin-only signal. Props are kept for forward use. */}

      {/* Price row */}
      {prices.length > 0 && (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {prices.map((p, i) => (
            <span key={i} className="text-sm">
              <span className="text-[var(--primary)] font-semibold text-base">${p.amount}</span>
              <span className="text-slate-500 ml-0.5">{p.suffix}</span>
            </span>
          ))}
        </div>
      )}

      {/* Expand / Collapse Details */}
      {hasDetails && (
        <button
          onClick={onToggleExpand}
          className="mt-3 flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {isExpanded ? t("hideDetails") : t("showDetails")}
        </button>
      )}

      {/* Expanded Details */}
      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-slate-200 space-y-3">
          {/* Description */}
          {catalog?.description && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">{t("description")}</p>
              <p className="text-sm text-slate-700 whitespace-pre-line">{catalog.description}</p>
            </div>
          )}

          {/* Specifications */}
          {specEntries.length > 0 && (
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">{t("specifications")}</p>
              <ul className="space-y-0.5">
                {specEntries.map((s, i) => (
                  <li key={i} className="text-sm text-slate-700 flex">
                    <span className="text-slate-500 mr-2">&bull;</span>
                    <span className="font-medium mr-1">{s.label}:</span>
                    {s.value}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Document links */}
          {(catalog?.brochureUrl || catalog?.videoUrl) && (
            <div className="flex gap-3">
              {catalog.brochureUrl && (
                <a
                  href={catalog.brochureUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
                >
                  <FileText size={14} /> {t("viewBrochure")}
                </a>
              )}
              {catalog.videoUrl && (
                <a
                  href={catalog.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
                >
                  <Video size={14} /> {t("watchVideo")}
                </a>
              )}
            </div>
          )}

          {/* Gallery thumbnails */}
          {gallery.length > 0 && (
            <div className="flex gap-2 overflow-x-auto">
              {gallery.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt={`Gallery ${i + 1}`}
                  className="h-16 w-16 object-cover rounded cursor-pointer hover:ring-2 hover:ring-[var(--primary)]/50 flex-shrink-0"
                  onClick={() => setLightboxIndex(i)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Spacer pushes CTA to the card bottom for row alignment, with a 1rem minimum gap */}
      <div className="mt-4 flex-1" />

      {/* CTA Buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => !isUnavailable && onRequestRental()}
          disabled={isUnavailable}
          className={`flex-1 text-center py-2 rounded-lg font-medium text-sm transition-colors ${
            isUnavailable
              ? "bg-slate-200 text-slate-400 cursor-not-allowed"
              : "btn-primary"
          }`}
        >
          {isUnavailable ? t("unavailableForDates") : t("requestRental")}
        </button>
        {onAddToCart && !isUnavailable && (
          <button
            onClick={() => onAddToCart()}
            className="px-3 py-2 rounded-lg font-medium text-sm border border-slate-300 text-slate-700 hover:bg-slate-50"
            aria-label={t("addToCart")}
            title={t("addToCart")}
          >
            +
          </button>
        )}
      </div>

      {/* Lightbox */}
      {lightboxIndex !== null && (
        <PhotoLightbox
          photos={gallery.map((src, i) => ({ src, label: `${fleet.brand} ${fleet.model} - ${i + 1}` }))}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
