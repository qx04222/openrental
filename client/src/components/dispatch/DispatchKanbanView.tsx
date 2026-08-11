import { useCallback, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";
import {
  DISPATCH_STATUSES,
  DISPATCH_STATUS_COLORS,
  isValidTransition,
} from "@shared/dispatchTransitions";
import type { DispatchStatus } from "@shared/dispatchTransitions";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import type { DispatchRow } from "./DispatchCalendarView";
import { useFormatCalendarDate } from "@/lib/dateUtils";

interface Props {
  data: DispatchRow[];
  onStatusChange: (id: number, newStatus: DispatchStatus) => void;
  onCardClick: (orderId: number) => void;
}

function priorityBadge(p: string | null | undefined) {
  if (!p || p === "normal") return null;
  const colors =
    p === "urgent"
      ? "bg-red-100 text-red-700"
      : "bg-yellow-100 text-yellow-700";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${colors}`}>
      {p}
    </span>
  );
}

export default function DispatchKanbanView({ data, onStatusChange, onCardClick }: Props) {
  const { t } = useTranslation("dispatch");
  const fmtDate = useFormatCalendarDate();

  const STATUS_LABELS: Record<DispatchStatus, string> = {
    pending: t("kanban.pending"),
    assigned: t("kanban.assigned"),
    in_transit: t("kanban.inTransit"),
    delivered: t("kanban.delivered"),
    completed: t("kanban.completed"),
    cancelled: t("kanban.cancelled"),
  };

  const columns = DISPATCH_STATUSES.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    color: DISPATCH_STATUS_COLORS[status],
    items: data.filter((row) => row.dispatch_orders.status === status),
  }));

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      if (!result.destination) return;

      const fromStatus = result.source.droppableId as DispatchStatus;
      const toStatus = result.destination.droppableId as DispatchStatus;

      if (fromStatus === toStatus) return;

      const orderId = Number(result.draggableId);

      if (!isValidTransition(fromStatus, toStatus)) {
        toast.error(
          t("kanban.invalidTransition", { from: STATUS_LABELS[fromStatus], to: STATUS_LABELS[toStatus] }),
        );
        return;
      }

      onStatusChange(orderId, toStatus);
    },
    [onStatusChange],
  );

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-4 min-h-[500px]">
        {columns.map((col) => (
          <div
            key={col.status}
            className="flex-shrink-0 w-[260px] bg-slate-50 rounded-xl border border-slate-200"
          >
            {/* Column header */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-200">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: col.color }}
              />
              <span className="text-sm font-semibold text-slate-700">
                {col.label}
              </span>
              <span className="ml-auto text-xs text-slate-400 bg-slate-200 rounded-full px-2 py-0.5">
                {col.items.length}
              </span>
            </div>

            {/* Droppable area */}
            <Droppable droppableId={col.status}>
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={`p-2 space-y-2 min-h-[80px] transition-colors ${
                    snapshot.isDraggingOver ? "bg-blue-50/60" : ""
                  }`}
                >
                  {col.items.map((row, index) => {
                    const d = row.dispatch_orders;
                    return (
                      <Draggable
                        key={d.id}
                        draggableId={String(d.id)}
                        index={index}
                      >
                        {(dragProvided, dragSnapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            {...dragProvided.dragHandleProps}
                            // react-beautiful-dnd's DraggingStyle predates React 19's
                            // CSSProperties (which now carries a CSS-var index sig) — cast.
                            style={dragProvided.draggableProps.style as CSSProperties}
                            onClick={() => onCardClick(d.id)}
                            className={`bg-white rounded-lg border border-slate-200 p-3 cursor-pointer hover:shadow-sm transition-shadow ${
                              dragSnapshot.isDragging ? "shadow-lg ring-2 ring-blue-300" : ""
                            }`}
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-xs font-bold text-slate-900">
                                #{d.id}
                              </span>
                              <span className="text-[10px] font-medium text-slate-400 uppercase">
                                {d.orderType}
                              </span>
                            </div>

                            {/* Customer */}
                            <p className="text-sm text-slate-700 font-medium truncate">
                              {row.customers?.name || t("kanban.noCustomer")}
                            </p>

                            {/* Equipment */}
                            {row.rental_fleet && (
                              <p className="text-xs text-slate-500 truncate mt-0.5">
                                {row.rental_fleet.brand} {row.rental_fleet.model}
                              </p>
                            )}

                            {/* Driver */}
                            {row.driver && (
                              <p className="text-xs text-blue-600 truncate mt-0.5">
                                {row.driver.name}
                              </p>
                            )}

                            {/* Footer: date + priority */}
                            <div className="flex items-center justify-between mt-2">
                              <span className="text-[11px] text-slate-400">
                                {fmtDate(d.scheduledDate)}
                              </span>
                              {priorityBadge(d.priority)}
                            </div>

                            {/* Customer confirmed badge */}
                            {d.customerConfirmedAt && (
                              <div className="mt-2">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">
                                  {t("kanban.confirmed")}
                                </span>
                              </div>
                            )}

                            {/* Copy confirmation link for in_transit orders */}
                            {d.status === "in_transit" && !d.customerConfirmedAt && d.confirmationToken && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const url = `${window.location.origin}/driver/confirm/${d.confirmationToken}`;
                                  navigator.clipboard.writeText(url);
                                  toast.success(t("kanban.linkCopied"));
                                }}
                                className="mt-2 flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 font-medium"
                              >
                                <Link2 size={12} />
                                {t("kanban.copyConfirmLink")}
                              </button>
                            )}
                          </div>
                        )}
                      </Draggable>
                    );
                  })}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </div>
        ))}
      </div>
    </DragDropContext>
  );
}
