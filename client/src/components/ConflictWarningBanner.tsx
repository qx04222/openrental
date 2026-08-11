import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useAppTimezone, formatCalendarDateISO } from "@/lib/dateUtils";

export interface ConflictingRentalInfo {
  id: number;
  rentalNumber: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface AlternativeAsset {
  id: number;
  brand: string;
  model: string;
  assetNumber: string | null;
  serialNumber?: string | null;
}

interface ConflictWarningBannerProps {
  assetLabel: string;
  startDate: string;
  endDate: string;
  conflictingRentals: ConflictingRentalInfo[];
  alternatives: AlternativeAsset[];
  onSelectAlternative?: (fleetId: number) => void;
}

/**
 * Warning banner shown when a selected fleet asset has a booking conflict.
 * Non-blocking: admin can still proceed to submit.
 */
export function ConflictWarningBanner({
  assetLabel,
  startDate,
  endDate,
  conflictingRentals,
  alternatives,
  onSelectAlternative,
}: ConflictWarningBannerProps) {
  const { t } = useTranslation("admin");
  const tz = useAppTimezone();
  const fmtDate = (s: string | null | undefined) => formatCalendarDateISO(s, tz) || "-";
  if (conflictingRentals.length === 0) return null;

  const firstConflict = conflictingRentals[0];
  const rentalRef = firstConflict.rentalNumber
    ? `#${firstConflict.rentalNumber}`
    : `#${firstConflict.id}`;

  return (
    <div
      role="alert"
      className="border border-red-300 bg-red-50 rounded-lg p-3 space-y-1.5 text-sm"
      data-testid="conflict-warning-banner"
    >
      <div className="flex items-start gap-2 text-red-700 font-medium">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>
          {t("conflict.assetOccupied", {
            asset: assetLabel,
            start: fmtDate(startDate),
            end: fmtDate(endDate),
            rental: rentalRef,
          })}
        </span>
      </div>

      {conflictingRentals.length > 1 && (
        <ul className="ml-6 text-red-600 text-xs space-y-0.5">
          {conflictingRentals.slice(1).map((c) => (
            <li key={c.id}>
              {t("conflict.orderRef", {
                rental: c.rentalNumber ? `#${c.rentalNumber}` : `#${c.id}`,
                start: fmtDate(c.startDate),
                end: fmtDate(c.endDate),
              })}
            </li>
          ))}
        </ul>
      )}

      {alternatives.length > 0 && (
        <div className="ml-6">
          <p className="text-slate-600 text-xs mb-1">{t("conflict.suggestAlternative")}</p>
          <ul className="space-y-1">
            {alternatives.map((alt) => (
              <li key={alt.id}>
                <button
                  type="button"
                  onClick={() => onSelectAlternative?.(alt.id)}
                  className="text-xs text-blue-600 hover:underline hover:text-blue-800"
                  data-testid={`alt-asset-${alt.id}`}
                >
                  {alt.brand} {alt.model}
                  {alt.serialNumber ? ` (${alt.serialNumber})` : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {alternatives.length === 0 && (
        <p className="ml-6 text-slate-500 text-xs">{t("conflict.noAlternative")}</p>
      )}
    </div>
  );
}
