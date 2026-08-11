import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventClickArg } from "@fullcalendar/core";
import { DISPATCH_STATUS_COLORS } from "@shared/dispatchTransitions";
import type { DispatchStatus } from "@shared/dispatchTransitions";

export interface DispatchRow {
  dispatch_orders: {
    id: number;
    orderType: string;
    status: string;
    scheduledDate: string | Date | null;
    scheduledTimeSlot: string | null;
    notes: string | null;
    priority: string | null;
    rentalRequestId: number | null;
    customerConfirmedAt: string | Date | null;
    confirmationToken: string | null;
    [key: string]: unknown;
  };
  customers: { id: number; name: string } | null;
  rental_fleet: { id: number; brand: string; model: string } | null;
  driver: { id: number; name: string } | null;
}

interface Props {
  data: DispatchRow[];
  onEventClick: (orderId: number) => void;
}

/**
 * Parse a time slot string like "7:00-9:00" or "7:00 - 9:00" into start/end hours.
 * Returns null if the format is not recognized.
 */
function parseTimeSlot(slot: string): { startHour: string; endHour: string } | null {
  const match = slot.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  return { startHour: match[1], endHour: match[2] };
}

export default function DispatchCalendarView({ data, onEventClick }: Props) {
  const { t } = useTranslation("dispatch");
  const [view, setView] = useState<"dayGridMonth" | "timeGridWeek">("dayGridMonth");

  const events = useMemo(() => {
    return data
      .filter((row) => row.dispatch_orders.scheduledDate)
      .map((row) => {
        const d = row.dispatch_orders;
        const customerLabel = row.customers?.name || `Order #${d.id}`;
        const equipmentLabel = row.rental_fleet ? `${row.rental_fleet.brand} ${row.rental_fleet.model}` : "";
        const typeEmoji = d.orderType === "delivery" ? "\u{1F69A}" : "\u{1F4E6}";
        const typeAbbr = t(d.orderType === "delivery" ? "calendarAbbr.delivery" : "calendarAbbr.pickup");

        // Build title: in month view use short format, timeGrid will show the same
        const title = `${typeEmoji} ${typeAbbr}: ${customerLabel}${equipmentLabel ? ` - ${equipmentLabel}` : ""}`;
        const status = d.status as DispatchStatus;

        // Get the date string (YYYY-MM-DD)
        const dateStr = typeof d.scheduledDate === "string"
          ? d.scheduledDate.split("T")[0]
          : d.scheduledDate instanceof Date
            ? d.scheduledDate.toISOString().split("T")[0]
            : "";

        // If there's a time slot, create a timed event
        const timeSlot = d.scheduledTimeSlot;
        const parsed = timeSlot ? parseTimeSlot(timeSlot) : null;

        if (parsed && dateStr) {
          // Pad hours to HH:MM format
          const padTime = (t: string) => {
            const [h, m] = t.split(":");
            return `${h.padStart(2, "0")}:${m}`;
          };
          return {
            id: String(d.id),
            title,
            start: `${dateStr}T${padTime(parsed.startHour)}:00`,
            end: `${dateStr}T${padTime(parsed.endHour)}:00`,
            allDay: false,
            backgroundColor: DISPATCH_STATUS_COLORS[status] || "#6b7280",
            borderColor: DISPATCH_STATUS_COLORS[status] || "#6b7280",
            textColor: "#fff",
            extendedProps: { orderId: d.id, status },
          };
        }

        // No time slot — show as all-day event (backward compatible)
        return {
          id: String(d.id),
          title,
          date: dateStr,
          allDay: true,
          backgroundColor: DISPATCH_STATUS_COLORS[status] || "#6b7280",
          borderColor: DISPATCH_STATUS_COLORS[status] || "#6b7280",
          textColor: "#fff",
          extendedProps: { orderId: d.id, status },
        };
      });
  }, [data, t]);

  const handleEventClick = (info: EventClickArg) => {
    const orderId = info.event.extendedProps.orderId as number;
    onEventClick(orderId);
  };

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setView("dayGridMonth")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            view === "dayGridMonth"
              ? "bg-slate-900 text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          {t("calendar.month")}
        </button>
        <button
          onClick={() => setView("timeGridWeek")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            view === "timeGridWeek"
              ? "bg-slate-900 text-white"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          {t("calendar.week")}
        </button>

        {/* Status legend */}
        <div className="ml-auto flex flex-wrap gap-3 text-xs">
          {(Object.entries(DISPATCH_STATUS_COLORS) as [DispatchStatus, string][]).map(
            ([status, color]) => (
              <span key={status} className="flex items-center gap-1">
                <span
                  className="w-2.5 h-2.5 rounded-full inline-block"
                  style={{ backgroundColor: color }}
                />
                <span className="text-slate-500 capitalize">{t(`kanban.${status === "in_transit" ? "inTransit" : status}`)}</span>
              </span>
            ),
          )}
        </div>
      </div>

      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
        initialView={view}
        key={view}
        events={events}
        eventClick={handleEventClick}
        headerToolbar={{
          left: "prev,next today",
          center: "title",
          right: "",
        }}
        height="auto"
        eventDisplay="block"
        dayMaxEvents={4}
        slotMinTime="07:00:00"
        slotMaxTime="18:00:00"
        businessHours={{
          daysOfWeek: [1, 2, 3, 4, 5],
          startTime: "07:00",
          endTime: "18:00",
        }}
        allDaySlot={true}
      />
    </div>
  );
}
