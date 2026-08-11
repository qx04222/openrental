import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { matchesTableSearch } from "@/lib/tableSearch";
import { compareCellValues } from "@/lib/tableSort";

// ─── Types ───────────────────────────────────────────────────

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  /** Whether this column is included in search filtering (default true) */
  searchable?: boolean;
  /** Hide this column on small screens (< 768px) */
  hideOnMobile?: boolean;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  isLoading?: boolean;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  defaultPageSize?: number;
  searchPlaceholder?: string;
  /** Enable checkbox selection column */
  selectable?: boolean;
  /** Controlled selected keys */
  selectedKeys?: Set<string | number>;
  /** Callback when selection changes */
  onSelectionChange?: (keys: Set<string | number>) => void;
  /** Extract a unique key from each row (defaults to index) */
  rowKey?: (row: T) => string | number;
  /** Callback exposing filtered and page data when they change */
  onDataReady?: (info: { filtered: T[]; pageData: T[] }) => void;
  /** Optional page-owned search text for rendered/computed values not represented by column keys. */
  getSearchText?: (row: T) => string;
  /** Column key to sort by on first render. Omit to keep the source order. */
  defaultSortKey?: string | null;
  /** Direction for `defaultSortKey`. Ignored when no default key is given. */
  defaultSortDir?: "asc" | "desc";
}

// ─── Helpers ─────────────────────────────────────────────────

/** Access a potentially nested value via dot-separated path, e.g. "rental_requests.customerName" */
/* eslint-disable @typescript-eslint/no-explicit-any -- sorting needs dynamic property access for arbitrary nested rows */
function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((acc: any, part: string) => acc?.[part], obj);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Debounce hook */
function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// ─── Component ───────────────────────────────────────────────

export default function DataTable<T>({
  data: propData,
  columns,
  isLoading = false,
  onRowClick,
  emptyMessage,
  defaultPageSize = 10,
  searchPlaceholder,
  selectable = false,
  selectedKeys,
  onSelectionChange,
  rowKey,
  onDataReady,
  getSearchText,
  defaultSortKey = null,
  defaultSortDir = "asc",
}: DataTableProps<T>) {
  const { t } = useTranslation("common");

  // Some callers pass `data={query.data || []}` which yields a fresh empty
  // array literal on every render while the query is loading. That churn
  // cascades through filtered → sorted → pageData identity and re-fires
  // the onDataReady effect in a loop. Pin to a single stable empty ref
  // so loading-phase data is identity-stable.
  const stableEmptyRef = useRef<T[]>([]);
  const data = !propData || propData.length === 0 ? stableEmptyRef.current : propData;

  // Search state
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);

  // Sort state
  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSortDir);

  // Pagination state
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  // Reset to first page when search/sort/pageSize changes
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, sortKey, sortDir, pageSize]);

  // ─── Helpers ─────────────────────────────────────────────
  const getKey = useCallback(
    (row: T, idx: number): string | number => (rowKey ? rowKey(row) : idx),
    [rowKey],
  );

  // ─── Filtering ─────────────────────────────────────────────

  const filtered = useMemo(() => {
    if (!debouncedSearch) return data;
    return data.filter((row) => matchesTableSearch(row, columns, debouncedSearch, getSearchText));
    // `columns` is rebuilt every parent render (literal array w/ inline
    // render fns), but its searchable schema is static — including it
    // in deps causes filtered → sorted → pageData to churn identity
    // every render, which fires the onDataReady effect in a loop.
  }, [data, debouncedSearch, getSearchText]);

  // ─── Sorting ───────────────────────────────────────────────

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => compareCellValues(getNestedValue(a, sortKey), getNestedValue(b, sortKey), sortDir));
    return arr;
  }, [filtered, sortKey, sortDir]);

  // ─── Pagination ────────────────────────────────────────────

  const totalRows = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const startIdx = safePage * pageSize;
  const endIdx = Math.min(startIdx + pageSize, totalRows);
  const pageData = useMemo(
    () => sorted.slice(startIdx, endIdx),
    [sorted, startIdx, endIdx],
  );

  // ─── Data Ready Callback ──────────────────────────────────

  useEffect(() => {
    onDataReady?.({ filtered: sorted, pageData });
  }, [sorted, pageData, onDataReady]);

  // ─── Selection ─────────────────────────────────────────────

  const selected = selectedKeys ?? new Set<string | number>();

  const toggleRow = (key: string | number) => {
    if (!onSelectionChange) return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  };

  const toggleAll = () => {
    if (!onSelectionChange) return;
    // Check if all page rows are selected
    const pageKeys = pageData.map((row, idx) => getKey(row, startIdx + idx));
    const allSelected = pageKeys.every((k) => selected.has(k));
    const next = new Set(selected);
    if (allSelected) {
      pageKeys.forEach((k) => next.delete(k));
    } else {
      pageKeys.forEach((k) => next.add(k));
    }
    onSelectionChange(next);
  };

  const pageKeys = pageData.map((row, idx) => getKey(row, startIdx + idx));
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const somePageSelected = pageKeys.some((k) => selected.has(k)) && !allPageSelected;

  // ─── Handlers ──────────────────────────────────────────────

  const handleSort = useCallback(
    (key: string) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("asc");
      }
    },
    [sortKey]
  );

  // ─── Render ────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-8">
        <p className="text-[var(--muted-foreground)]">{t("loading")}</p>
      </div>
    );
  }

  return (
    <div className="bg-[var(--surface-container-lowest)] rounded-xl overflow-hidden shadow-sm">
      {/* Toolbar: Search + Page Size */}
      <div className="flex items-center justify-between flex-wrap gap-3 px-6 lg:px-8 py-5 border-b border-[var(--outline-variant)]/10" data-datatable-search>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <label htmlFor="datatable-search" className="sr-only">{t("search")}</label>
          <input
            id="datatable-search"
            type="text"
            placeholder={searchPlaceholder ?? t("search")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="bg-[var(--surface-container-low)] border-none rounded-lg pl-10 pr-4 py-2.5 text-[var(--on-surface)] text-sm w-full sm:w-72 focus:ring-1 focus:ring-[var(--primary)]/20 placeholder:text-slate-400"
          />
        </div>
        <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          {selectable && selected.size > 0 && (
            <span className="text-[var(--primary)] font-bold mr-2">
              {selected.size} {t("export.selected") || "selected"}
            </span>
          )}
          <label htmlFor="datatable-pagesize">{t("show")}</label>
          <select
            id="datatable-pagesize"
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="bg-[var(--surface-container-low)] border-none rounded-lg px-3 py-1.5 text-sm text-[var(--on-surface)]"
            aria-label={t("perPage")}
          >
            {[10, 25, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span>{t("perPage")}</span>
        </div>
      </div>

      {/* Mobile cards (< md) */}
      <div className="md:hidden space-y-2 px-4 pb-4">
        {pageData.map((row, idx) => {
          const key = getKey(row, startIdx + idx);
          const isSelected = selectable && selected.has(key);
          const [first, ...rest] = columns;
          if (!first) return null;
          return (
            <div
              key={key}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`bg-[var(--surface-container-lowest)] border border-slate-200 rounded-xl p-3 ${onRowClick ? "cursor-pointer active:bg-slate-50" : ""} ${isSelected ? "ring-2 ring-[var(--primary)]/40" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-slate-900 flex-1 min-w-0">
                  {first.render ? first.render(row) : (getNestedValue(row, first.key) ?? "-")}
                </div>
                {selectable && (
                  <input
                    type="checkbox"
                    checked={!!isSelected}
                    onChange={() => toggleRow(key)}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded border-slate-300 text-[var(--primary)] focus:ring-[var(--primary)] mt-1 shrink-0"
                    aria-label={`Select row ${key}`}
                  />
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                {rest.map((col) => {
                  const val = col.render ? col.render(row) : (getNestedValue(row, col.key) ?? "-");
                  if (val === null || val === undefined || val === "" || val === "-") return null;
                  return (
                    <div key={col.key} className="flex flex-col min-w-0">
                      <span className="text-slate-400 uppercase tracking-wide text-[9px]">{col.label}</span>
                      <span className={`text-slate-700 ${col.key === "_actions" ? "" : "truncate"}`}>{val}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {pageData.length === 0 && (
          <div className="py-12 text-center text-slate-400">
            {debouncedSearch ? t("noData") : (emptyMessage ?? t("noData"))}
          </div>
        )}
      </div>

      {/* Table (>= md) */}
      <div className="overflow-x-auto hidden md:block">
        <table className="w-full text-sm text-left border-collapse">
          <thead>
            <tr className="bg-[var(--surface-container-low)]/50">
              {selectable && (
                <th className="py-4 px-4 w-10 print:hidden">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    ref={(el) => { if (el) el.indeterminate = somePageSelected; }}
                    onChange={toggleAll}
                    className="rounded border-slate-300 text-[var(--primary)] focus:ring-[var(--primary)]"
                    aria-label="Select all rows on page"
                  />
                </th>
              )}
              {columns.map((col) => {
                const isSortable = col.sortable !== false;
                const isActive = sortKey === col.key;
                const hideMobile = col.hideOnMobile ? "hidden md:table-cell" : "";
                return (
                  <th
                    key={col.key}
                    className={`py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)] select-none ${isSortable ? "cursor-pointer hover:text-[var(--on-surface)]" : ""} ${hideMobile}`}
                    onClick={isSortable ? () => handleSort(col.key) : undefined}
                    onKeyDown={isSortable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSort(col.key); } } : undefined}
                    tabIndex={isSortable ? 0 : undefined}
                    role={isSortable ? "columnheader" : undefined}
                    aria-sort={isActive ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {isSortable && (
                        <span className="inline-flex flex-col text-slate-300">
                          {isActive ? (
                            sortDir === "asc" ? (
                              <ChevronUp size={14} className="text-[var(--on-surface)]" />
                            ) : (
                              <ChevronDown size={14} className="text-[var(--on-surface)]" />
                            )
                          ) : (
                            <ChevronsUpDown size={14} />
                          )}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--outline-variant)]/5">
            {pageData.map((row, idx) => {
              const key = getKey(row, startIdx + idx);
              const isSelected = selectable && selected.has(key);
              return (
                <tr
                  key={key}
                  className={`hover:bg-[var(--surface-container-low)]/30 transition-colors group ${onRowClick ? "cursor-pointer" : ""} ${isSelected ? "bg-[var(--primary)]/5" : ""}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(row); } } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? "button" : undefined}
                >
                  {selectable && (
                    <td className="py-5 px-4 print:hidden" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(key)}
                        className="rounded border-slate-300 text-[var(--primary)] focus:ring-[var(--primary)]"
                        aria-label={`Select row ${key}`}
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td key={col.key} className={`py-5 px-6 text-[var(--on-surface)] ${col.hideOnMobile ? "hidden md:table-cell" : ""}`}>
                      {col.render ? col.render(row) : (getNestedValue(row, col.key) ?? "-")}
                    </td>
                  ))}
                </tr>
              );
            })}
            {pageData.length === 0 && (
              <tr>
                <td colSpan={columns.length + (selectable ? 1 : 0)} className="py-12 text-center text-slate-400">
                  {debouncedSearch ? t("noData") : (emptyMessage ?? t("noData"))}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {totalRows > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-3 px-6 lg:px-8 py-5 bg-[var(--surface-container-low)]/20 text-xs text-[var(--muted-foreground)]" data-datatable-pagination>
          <span>
            {startIdx + 1}-{endIdx} / {totalRows}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              aria-label={t("previous")}
              className="p-2 border border-[var(--outline-variant)]/10 rounded-lg hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("previous")}
            </button>
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              const pageNum = i;
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  className={`px-3 py-1 rounded text-xs font-bold transition-colors ${
                    safePage === pageNum
                      ? "bg-[var(--primary)] text-[var(--on-primary)]"
                      : "hover:bg-[var(--surface-container-high)] text-[var(--muted-foreground)]"
                  }`}
                >
                  {pageNum + 1}
                </button>
              );
            })}
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              aria-label={t("next")}
              className="p-2 border border-[var(--outline-variant)]/10 rounded-lg hover:bg-[var(--surface-container-high)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("next")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
