import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { isOpenEndedEndDate } from "@shared/creditOrders";

/**
 * Display timezone. Must match the server's APP_TIMEZONE, otherwise a rental
 * that ends "today" in the yard can render as ending yesterday on screen.
 * Set VITE_APP_TIMEZONE at build time alongside APP_TIMEZONE.
 */
export const DEFAULT_TIMEZONE = import.meta.env.VITE_APP_TIMEZONE || "America/Toronto";

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Render a calendar-date field (startDate, endDate, scheduledDate, etc.) in a
 * fixed timezone instead of the browser's local zone. Use this for fields that
 * represent a *day*, not an *instant*. For real timestamps (createdAt, etc.)
 * keep using toLocaleString in browser-local time.
 */
export function formatCalendarDate(
  value: string | Date | null | undefined,
  timezone: string = DEFAULT_TIMEZONE,
  locale?: string,
  openEndedLabel = "Open",
): string {
  const d = toDate(value);
  if (!d) return "-";
  // Credit (挂账) orders store a far-future sentinel for "open-ended" — never
  // render the literal 2099 date to staff or customers.
  if (isOpenEndedEndDate(d)) return openEndedLabel;
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Same as formatCalendarDate but in `YYYY-MM-DD` form (sortable / CSV-safe). */
export function formatCalendarDateISO(
  value: string | Date | null | undefined,
  timezone: string = DEFAULT_TIMEZONE,
): string {
  const d = toDate(value);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "";
  const m = parts.find((p) => p.type === "month")?.value ?? "";
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  return `${y}-${m}-${day}`;
}

export function useAppTimezone(): string {
  const { data } = trpc.siteSettings.getAll.useQuery(undefined, {
    staleTime: 10 * 60 * 1000,
  });
  return (data?.timezone as string | undefined) || DEFAULT_TIMEZONE;
}

/**
 * Bound formatter that pulls the configured timezone from site_settings.
 * Drop-in replacement for the old per-page `fmtDate` helpers.
 */
export function useFormatCalendarDate() {
  const tz = useAppTimezone();
  const { t } = useTranslation("common");
  const openLabel = t("openEnded", "Open");
  return (value: string | Date | null | undefined) => formatCalendarDate(value, tz, undefined, openLabel);
}
