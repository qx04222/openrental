/**
 * Column ordering rules for DataTable, kept out of the .tsx so they can be
 * unit-tested directly (the test runner has no JSX transform).
 */

/**
 * True for strings that are entirely a decimal number, e.g. "8435.43" or "-12".
 * Deliberately strict: document numbers like "INV-2026-0189" must keep using
 * the locale string comparison, which orders them the way people read them.
 */
function isNumericString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim());
}

/**
 * Column comparator, exported so the ordering rules can be tested directly.
 * Nulls sort last in both directions.
 */
export function compareCellValues(aVal: unknown, bVal: unknown, sortDir: "asc" | "desc"): number {
  if (aVal == null && bVal == null) return 0;
  if (aVal == null) return 1;
  if (bVal == null) return -1;

  // Dates — without this branch they fall through to the string path and get
  // sorted by `"Mon May 12 2026..."` text, i.e. by weekday name (Fri < Mon <
  // Sat). superjson hydrates timestamp columns as real Date instances, so this
  // is the common case for any "sort by date column" click.
  if (aVal instanceof Date && bVal instanceof Date) {
    return sortDir === "asc" ? aVal.getTime() - bVal.getTime() : bVal.getTime() - aVal.getTime();
  }

  if (typeof aVal === "number" && typeof bVal === "number") {
    return sortDir === "asc" ? aVal - bVal : bVal - aVal;
  }

  // Numeric *strings* — postgres.js returns every NUMERIC column as a string,
  // so money columns land here. localeCompare's numeric collation compares
  // digit runs segment by segment and gets decimals wrong: "100.5" sorts below
  // "100.45" because it reads 5 < 45. Compare as numbers when both sides are
  // plainly numeric.
  if (isNumericString(aVal) && isNumericString(bVal)) {
    const aNum = Number(aVal);
    const bNum = Number(bVal);
    return sortDir === "asc" ? aNum - bNum : bNum - aNum;
  }

  const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true, sensitivity: "base" });
  return sortDir === "asc" ? cmp : -cmp;
}
