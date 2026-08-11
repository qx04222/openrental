import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";

interface Props {
  /** Single-unit calendar (admin or back-compat). */
  fleetId?: number;
  /** Whole-group calendar — a day is available as long as ≥1 unit is free.
   *  When provided, fleetId is ignored. */
  fleetIds?: number[];
  onDateSelect?: (date: string) => void;
  selectedStartDate?: string;
  selectedEndDate?: string;
}

export default function AvailabilityCalendar({
  fleetId,
  fleetIds,
  onDateSelect,
  selectedStartDate,
  selectedEndDate,
}: Props) {
  const { t, i18n } = useTranslation("common");
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-indexed

  const useGroup = !!(fleetIds && fleetIds.length > 0);
  const { data: calendarData, isLoading } = trpc.availability.getCalendar.useQuery(
    useGroup ? { fleetIds, year, month } : { fleetId: fleetId!, year, month },
    { enabled: useGroup ? (fleetIds!.length > 0) : !!fleetId }
  );

  // Locale-aware month/day names
  const monthName = useMemo(() => {
    const d = new Date(year, month - 1, 1);
    return d.toLocaleString(i18n.language, { month: "long" });
  }, [year, month, i18n.language]);

  const dayNames = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(2024, 0, i); // 2024-01-07 is a Sunday
      return d.toLocaleString(i18n.language, { weekday: "short" });
    });
  }, [i18n.language]);

  // Build a lookup map: date string -> status
  const statusMap = useMemo(() => {
    const map = new Map<string, string>();
    if (calendarData) {
      for (const entry of calendarData) {
        map.set(entry.date, entry.status);
      }
    }
    return map;
  }, [calendarData]);

  // Calculate grid cells
  const gridCells = useMemo(() => {
    const firstDayOfMonth = new Date(year, month - 1, 1);
    const startDow = firstDayOfMonth.getDay(); // 0=Sun
    const daysInMonth = new Date(year, month, 0).getDate();
    const daysInPrevMonth = new Date(year, month - 1, 0).getDate();

    const cells: Array<{
      day: number;
      dateStr: string;
      isCurrentMonth: boolean;
      status: string | null;
    }> = [];

    // Previous month fill
    for (let i = startDow - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i;
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear = month === 1 ? year - 1 : year;
      const dateStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({ day: d, dateStr, isCurrentMonth: false, status: null });
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({
        day: d,
        dateStr,
        isCurrentMonth: true,
        status: statusMap.get(dateStr) || null,
      });
    }

    // Next month fill (complete last row)
    const remaining = 7 - (cells.length % 7);
    if (remaining < 7) {
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      for (let d = 1; d <= remaining; d++) {
        const dateStr = `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        cells.push({ day: d, dateStr, isCurrentMonth: false, status: null });
      }
    }

    return cells;
  }, [year, month, statusMap]);

  // Check if a date is in the selected range
  const isInSelectedRange = (dateStr: string): boolean => {
    if (!selectedStartDate || !selectedEndDate) return false;
    return dateStr >= selectedStartDate && dateStr <= selectedEndDate;
  };

  const isSelectedEndpoint = (dateStr: string): boolean => {
    return dateStr === selectedStartDate || dateStr === selectedEndDate;
  };

  // Navigation
  const goToPrevMonth = () => {
    if (month === 1) {
      setMonth(12);
      setYear(year - 1);
    } else {
      setMonth(month - 1);
    }
  };

  const goToNextMonth = () => {
    if (month === 12) {
      setMonth(1);
      setYear(year + 1);
    } else {
      setMonth(month + 1);
    }
  };

  // Get background class for a cell
  const getCellClasses = (cell: (typeof gridCells)[0]): string => {
    const base = "relative flex items-center justify-center h-9 text-sm rounded-md transition-colors";

    if (!cell.isCurrentMonth) {
      return `${base} text-slate-300`;
    }

    // Selected range takes precedence in styling
    if (isSelectedEndpoint(cell.dateStr)) {
      return `${base} bg-blue-600 text-white font-semibold`;
    }

    if (isInSelectedRange(cell.dateStr)) {
      return `${base} bg-blue-100 text-blue-800`;
    }

    // Status colors
    switch (cell.status) {
      case "booked":
        return `${base} bg-red-100 text-red-700`;
      case "maintenance":
        return `${base} bg-yellow-100 text-yellow-700`;
      case "available":
        return `${base} bg-green-50 text-green-700 hover:bg-green-100 cursor-pointer`;
      default:
        return `${base} text-slate-400`;
    }
  };

  const handleCellClick = (cell: (typeof gridCells)[0]) => {
    if (!cell.isCurrentMonth) return;
    if (cell.status !== "available") return;
    onDateSelect?.(cell.dateStr);
  };

  // Today string for highlighting
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={goToPrevMonth}
          className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 transition-colors"
          aria-label={t("calendar.previousMonth")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h4 className="text-sm font-semibold text-slate-900">
          {monthName} {year}
        </h4>
        <button
          type="button"
          onClick={goToNextMonth}
          className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 transition-colors"
          aria-label={t("calendar.nextMonth")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {dayNames.map((name, i) => (
          <div key={i} className="text-center text-xs font-medium text-slate-400 py-1">
            {name}
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-sm text-slate-400">
          {t("loading")}
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {gridCells.map((cell, idx) => (
            <div
              key={idx}
              className={getCellClasses(cell)}
              onClick={() => handleCellClick(cell)}
            >
              {cell.day}
              {/* Today indicator */}
              {cell.dateStr === todayStr && cell.isCurrentMonth && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-current" />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-green-50 border border-green-200" />
          {t("calendar.available")}
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-red-100 border border-red-200" />
          {t("calendar.booked")}
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-yellow-100 border border-yellow-200" />
          {t("calendar.maintenance")}
        </div>
        {(selectedStartDate || selectedEndDate) && (
          <div className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-sm bg-blue-600" />
            {t("calendar.selected")}
          </div>
        )}
      </div>
    </div>
  );
}
