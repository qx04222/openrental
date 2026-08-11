/**
 * Transportation-row column definitions — the SINGLE source of truth for the
 * "复制财务运输行 / Copy transportation row" feature.
 *
 * This is the SIMPLIFIED dispatch/transportation view (7 columns), matching the
 * internal transportation log the delivery crew works from. It deliberately
 * drops the old 36-column finance layout (all the VEHICLES-lookup formula
 * columns): the crew only needs date, order #, who/where, delivery-or-pickup,
 * and any extra attachment. Copying a rental emits one tab-separated row in this
 * exact order so it pastes column-aligned under that header.
 *
 *   日期    rental start date (Toronto-anchored YYYY-MM-DD)
 *   单号    financial order number (SOT/SOR), falling back to our rentalNumber
 *   公司    company (falls back to customer name)
 *   电话    customer phone
 *   地址    delivery address
 *   NOTE    delivery method — "Delivery" / "Self pickup"
 *   NOTE 2  extra attachments / accessories (recorded in adminNotes, e.g. "Pallet fork")
 *
 * `key` is a dot-path into the object returned by `rentals.getById`
 * ({ rental_requests, rental_fleet, customers, _export }). Dates arrive as Date
 * or ISO string. `_export.*` holds server-computed cells (order number, delivery
 * method label).
 */
import { formatCalendarDateISO } from "./dateUtils";

export interface FinanceColumn {
  key: string;
  label: string;
  format?: (value: unknown) => string;
}

/** Money: strip $ / thousands separators, render with 2 decimals; null → "". */
export function formatFinanceMoney(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const n =
    typeof value === "number"
      ? value
      : parseFloat(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

/** Toronto-anchored YYYY-MM-DD; null → "". */
function formatFinanceDate(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return formatCalendarDateISO(value as string | Date);
}

/** "公司": prefer company, fall back to the customer name. */
function companyOrName(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const o = value as { customerCompany?: unknown; customerName?: unknown };
    return String(o.customerCompany || o.customerName || "");
  }
  return String(value);
}

/**
 * Transportation log layout — 7 columns, header order left→right.
 * Labels match the log's headers verbatim.
 */
export const FINANCE_ROW_COLUMNS: FinanceColumn[] = [
  { key: "rental_requests.startDate", label: "日期", format: formatFinanceDate }, // 租赁开始日期
  { key: "_export.orderNumber", label: "单号" },                                  // 财务单号 (SOT/SOR, 回退我方号)
  { key: "rental_requests", label: "公司", format: companyOrName },               // 公司 (回退客户名)
  { key: "rental_requests.customerPhone", label: "电话" },                        // 电话
  { key: "rental_requests.deliveryAddress", label: "地址" },                      // 送货地址
  { key: "_export.deliveryMethodLabel", label: "NOTE" },                          // Delivery / Self pickup
  { key: "rental_requests.adminNotes", label: "NOTE 2" },                         // 额外属具/配件 (如 Pallet fork)
];
