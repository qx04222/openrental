/**
 * Build and copy a single rental order as one tab-separated row, for pasting
 * straight into Excel / finance software. Column set lives in
 * ./financeRowColumns (the single header source).
 */
import { DEFAULT_TIMEZONE } from "@/lib/dateUtils";
import {
  FINANCE_ROW_COLUMNS,
  type FinanceColumn,
} from "./financeRowColumns";

/** Resolve a dot-path (e.g. "rental_requests.totalAmount") safely. */
function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/** Replace embedded tabs/newlines so a value can't split across cells. */
function sanitizeCell(s: string): string {
  return s.replace(/[\t\r\n]+/g, " ").trim();
}

/** Ordered string values for one order, per the column definitions. */
export function buildFinanceRow(
  order: unknown,
  columns: FinanceColumn[] = FINANCE_ROW_COLUMNS,
): string[] {
  return columns.map((c) => {
    const raw = getNestedValue(order, c.key);
    const out = c.format ? c.format(raw) : raw == null ? "" : String(raw);
    return sanitizeCell(out);
  });
}

export interface FinanceRowOptions {
  withHeader?: boolean;
  columns?: FinanceColumn[];
}

/** A single TSV row (optionally preceded by a header line). */
export function financeRowTSV(
  order: unknown,
  { withHeader = false, columns = FINANCE_ROW_COLUMNS }: FinanceRowOptions = {},
): string {
  const row = buildFinanceRow(order, columns).join("\t");
  if (!withHeader) return row;
  const header = columns.map((c) => sanitizeCell(c.label)).join("\t");
  return `${header}\n${row}`;
}

/** Multiple orders as header + one row each (for batch copy). */
export function financeRowsTSV(
  orders: unknown[],
  columns: FinanceColumn[] = FINANCE_ROW_COLUMNS,
): string {
  const header = columns.map((c) => sanitizeCell(c.label)).join("\t");
  const rows = orders.map((o) => buildFinanceRow(o, columns).join("\t"));
  return [header, ...rows].join("\n");
}

async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for older browsers / insecure contexts.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

/** Copy one order's finance row to the clipboard. */
export async function copyFinanceRowTSV(
  order: unknown,
  options: FinanceRowOptions = {},
): Promise<void> {
  await writeClipboard(financeRowTSV(order, options));
}

// ─── WeChat dispatch message ──────────────────────────────────────────────
// A short, human-readable block for pasting straight into the dispatch WeChat
// group — NOT a spreadsheet row. One field per line (line breaks matter).

/** Toronto-anchored M/D/YYYY (e.g. 6/22/2026); empty/invalid → "". */
function formatWeChatDate(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(String(value));
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(d);
}

/**
 * Build the WeChat dispatch block from a hydrated `rentals.getById` order.
 * Lines with no value are omitted so pickups (no address) stay tidy.
 *
 *   Add: 159 Coons Rd, Richmond Hill, ON L4E 2P7
 *   Tel: 555-010-0300
 *   Del Time: 6/22/2026
 *   Machine: ER620H (1day)
 *   SN: <serial>
 *   Note: Delivery
 */
export function buildWeChatDispatch(order: unknown): string {
  const o = (order ?? {}) as {
    rental_requests?: Record<string, unknown>;
    rental_fleet?: Record<string, unknown> | null;
    _export?: Record<string, unknown>;
  };
  const rr = o.rental_requests ?? {};
  const ex = o._export ?? {};
  const fleet = o.rental_fleet ?? null;

  const address = rr.deliveryAddress ? String(rr.deliveryAddress) : "";
  const phone = rr.customerPhone ? String(rr.customerPhone) : "";
  const delTime = formatWeChatDate(rr.startDate);
  const model = ex.machineModel ? String(ex.machineModel) : "";
  const days = Number(ex.days);
  const serial = fleet?.serialNumber ? String(fleet.serialNumber) : "";
  const note = ex.deliveryMethodLabel ? String(ex.deliveryMethodLabel) : "";

  const machine = model
    ? Number.isFinite(days) && days > 0
      ? `${model} (${days}day${days === 1 ? "" : "s"})`
      : model
    : "";

  const lines: string[] = [];
  if (address) lines.push(`Add: ${address}`);
  if (phone) lines.push(`Tel: ${phone}`);
  if (delTime) lines.push(`Del Time: ${delTime}`);
  if (machine) lines.push(`Machine: ${machine}`);
  if (serial) lines.push(`SN: ${serial}`);
  if (note) lines.push(`Note: ${note}`);
  return lines.join("\n");
}

/** Copy one order's WeChat dispatch block to the clipboard. */
export async function copyWeChatDispatch(order: unknown): Promise<void> {
  await writeClipboard(buildWeChatDispatch(order));
}
