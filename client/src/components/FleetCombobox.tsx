import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Check, ChevronDown } from "lucide-react";

export type FleetComboboxItem = {
  id: number;
  brand: string;
  model: string;
  year?: number | null;
  category?: string | null;
  assetNumber?: string | null;
  serialNumber?: string | null;
  availabilityStatus: "available" | "rented" | "maintenance" | "blocked";
  conflictingRentalEnd?: string | null;
  /** Why a "blocked" unit is held — it is in our yard, not out on rent. */
  blockReason?: "return" | "work_order" | null;
  /** Document numbers behind the hold, so the operator knows what to go close. */
  blockRefs?: string[] | null;
};

interface FleetComboboxProps {
  items: FleetComboboxItem[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Allow picking rented/maintenance units (e.g. work orders target broken machines). */
  allowUnavailable?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
  autoAssignLabel?: string;
  labels?: {
    available?: string;
    rented?: string;
    maintenance?: string;
    until?: string;
    blockedWorkOrder?: string;
    blockedReturn?: string;
  };
}

function formatLabel(item: FleetComboboxItem): string {
  // Identify the unit by S/N only (asset numbers like FLEET-061 are internal).
  const id = item.serialNumber ? `S/N: ${item.serialNumber}` : null;
  const model = `${item.brand} ${item.model}${item.year ? ` (${item.year})` : ""}`;
  return id ? `${id} — ${model}` : model;
}

function matchesQuery(item: FleetComboboxItem, q: string): boolean {
  if (!q) return true;
  const haystack = [
    item.assetNumber,
    item.serialNumber,
    item.brand,
    item.model,
    item.year ? String(item.year) : null,
  ].filter(Boolean).join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).every(token => haystack.includes(token));
}

export default function FleetCombobox({
  items,
  value,
  onChange,
  disabled,
  allowUnavailable,
  placeholder,
  searchPlaceholder,
  noResultsLabel,
  autoAssignLabel,
  labels,
}: FleetComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => items.find(i => String(i.id) === value) || null,
    [items, value],
  );

  const filtered = useMemo(
    () => items.filter(i => matchesQuery(i, query)),
    [items, query],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [query, open]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${highlightIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx, open]);

  const openDropdown = () => {
    if (disabled) return;
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSelect = (item: FleetComboboxItem) => {
    if (!allowUnavailable && item.availabilityStatus !== "available") return;
    onChange(String(item.id));
    setOpen(false);
    setQuery("");
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[highlightIdx];
      if (item) handleSelect(item);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  };

  const statusChip = (item: FleetComboboxItem) => {
    if (item.availabilityStatus === "available") {
      return (
        <span className="text-xs text-green-600 inline-flex items-center gap-1 shrink-0">
          <Check size={12} /> {labels?.available || "Available"}
        </span>
      );
    }
    if (item.availabilityStatus === "rented") {
      return (
        <span className="text-xs text-red-500 shrink-0">
          ✗ {labels?.rented || "Rented"}
          {item.conflictingRentalEnd ? ` (${labels?.until || "until"} ${item.conflictingRentalEnd})` : ""}
        </span>
      );
    }
    if (item.availabilityStatus === "blocked") {
      // Held in our own yard. Name the document so the operator knows exactly
      // what to close instead of assuming a customer has the machine.
      const refs = (item.blockRefs || []).join(", ");
      const label = item.blockReason === "return"
        ? (labels?.blockedReturn || "Return in progress")
        : (labels?.blockedWorkOrder || "Held by work order");
      return (
        <span className="text-xs text-amber-600 shrink-0">
          ⚠ {label}{refs ? ` (${refs})` : ""}
        </span>
      );
    }
    return (
      <span className="text-xs text-amber-600 shrink-0">
        ⚠ {labels?.maintenance || "Maintenance"}
      </span>
    );
  };

  return (
    <div ref={wrapperRef} className="relative">
      {/* Trigger / Display */}
      {!open && (
        <button
          type="button"
          disabled={disabled}
          onClick={openDropdown}
          className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-left text-sm flex items-center justify-between gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50"
        >
          <span className={`truncate ${selected ? "text-black font-bold" : "text-slate-400"}`}>
            {selected ? formatLabel(selected) : (placeholder || autoAssignLabel || "Select equipment...")}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {selected && !disabled && (
              <X
                size={14}
                className="text-slate-400 hover:text-slate-600"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange("");
                }}
              />
            )}
            <ChevronDown size={14} className="text-slate-400" />
          </div>
        </button>
      )}

      {/* Open: Search input + dropdown */}
      {open && (
        <>
          <div className="w-full bg-white border border-[var(--primary,#2563EB)] rounded-lg px-3 py-2 flex items-center gap-2">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKey}
              placeholder={searchPlaceholder || "Search SN / asset # / model..."}
              className="flex-1 bg-transparent outline-none text-sm text-slate-900 placeholder-slate-400 min-w-0"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                className="text-slate-400 hover:text-slate-600 shrink-0"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div
            ref={listRef}
            className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-72 overflow-y-auto"
          >
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-slate-400">
                {noResultsLabel || "No matching equipment"}
              </div>
            ) : (
              filtered.map((item, idx) => {
                const isAvail = allowUnavailable || item.availabilityStatus === "available";
                const isSelected = String(item.id) === value;
                const isHighlighted = idx === highlightIdx;
                return (
                  <div
                    key={item.id}
                    data-idx={idx}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelect(item);
                    }}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    className={`px-3 py-2 flex items-start justify-between gap-3 border-b border-slate-100 last:border-b-0 ${
                      isAvail ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                    } ${isHighlighted && isAvail ? "bg-slate-100" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-black font-mono flex items-center gap-2">
                        <span className="truncate">
                          {item.serialNumber ? `S/N: ${item.serialNumber}` : `${item.brand} ${item.model}${item.year ? ` (${item.year})` : ""}`}
                        </span>
                        {isSelected && <Check size={12} className="text-[var(--primary,#2563EB)] shrink-0" />}
                      </div>
                      {(item.serialNumber || item.category) && (
                        <div className="text-xs text-slate-500 mt-0.5 truncate">
                          {item.serialNumber ? `${item.brand} ${item.model}${item.year ? ` (${item.year})` : ""}` : ""}
                          {item.category ? `${item.serialNumber ? " · " : ""}${item.category}` : ""}
                        </div>
                      )}
                    </div>
                    {statusChip(item)}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}
