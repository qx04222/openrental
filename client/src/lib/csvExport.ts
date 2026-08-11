/**
 * CSV export helper — generates a CSV string from an array of plain objects and
 * triggers a browser download.
 *
 * Escaping rules (RFC 4180):
 *   - Fields containing commas, double-quotes, or newlines are wrapped in double-quotes.
 *   - Double-quote characters inside a quoted field are escaped by doubling them ("").
 */

function escapeField(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  // Need quoting when field contains comma, double-quote, CR, or LF
  if (str.includes(",") || str.includes('"') || str.includes("\r") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";

  const headers = Object.keys(rows[0]);
  const headerRow = headers.map(escapeField).join(",");
  const dataRows = rows.map((row) => headers.map((h) => escapeField(row[h])).join(","));

  return [headerRow, ...dataRows].join("\r\n");
}

/**
 * Generate a CSV file from `rows` and trigger a browser download.
 *
 * @param filename - The suggested filename (should end with `.csv`).
 * @param rows - Array of plain objects. The keys of the first object become column headers.
 */
export function exportCsv(filename: string, rows: Record<string, unknown>[]): void {
  const csv = buildCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";

  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Release the object URL after a short delay to allow the download to start
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
