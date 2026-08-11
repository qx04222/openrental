import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface BatchActionBarProps {
  /** Number of currently selected rows. */
  selectedCount: number;
  /** Called when the user clicks the clear selection button. */
  onClear: () => void;
  /** Action buttons to render inside the bar. */
  children: ReactNode;
}

/**
 * A sticky bar that slides into view at the bottom of a table container when
 * one or more rows are selected. Displays the selection count, a clear button,
 * and a slot for action buttons.
 *
 * Renders nothing when `selectedCount` is 0.
 */
export default function BatchActionBar({ selectedCount, onClear, children }: BatchActionBarProps) {
  const { t } = useTranslation("common");
  if (selectedCount === 0) return null;

  return (
    <div
      role="toolbar"
      aria-label={t("batch.actions")}
      className="sticky bottom-0 z-10 flex items-center gap-3 flex-wrap px-6 py-4 bg-[var(--surface-container)] border-t border-[var(--outline-variant)]/20 shadow-[0_-2px_8px_rgba(0,0,0,0.08)] rounded-b-xl print:hidden"
    >
      <span className="text-sm font-semibold text-[var(--on-surface)] shrink-0">
        {t("batch.selected", { count: selectedCount })}
      </span>

      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--on-surface)] transition-colors"
        aria-label={t("batch.clearSelection")}
      >
        <X size={14} aria-hidden="true" />
        {t("batch.clear")}
      </button>

      <span className="flex-1" aria-hidden="true" />

      {children}
    </div>
  );
}
