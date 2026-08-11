/**
 * Export utilities for CSV download, PDF export, and print
 */
import type jsPDF from "jspdf";

export interface ExportColumn {
  key: string;
  label: string;
}

// ─── Helpers ─────────────────────────────────────────────────

function escapeCSV(value: string): string {
  if (value == null) return "";
  const str = String(value);
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Access a potentially nested value via dot-separated path */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce((acc: unknown, part: string) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[part];
    return undefined;
  }, obj);
}

// ─── CJK Font Loader ────────────────────────────────────────

let cjkFontLoaded = false;

async function loadCJKFont(doc: jsPDF): Promise<void> {
  if (cjkFontLoaded) {
    doc.addFont("NotoSansSC-Regular.ttf", "NotoSansSC", "normal");
    return;
  }
  try {
    const response = await fetch("/fonts/NotoSansSC-Regular.ttf");
    if (!response.ok) return;
    const buffer = await response.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ""),
    );
    doc.addFileToVFS("NotoSansSC-Regular.ttf", base64);
    doc.addFont("NotoSansSC-Regular.ttf", "NotoSansSC", "normal");
    cjkFontLoaded = true;
  } catch {
    // Font loading failed; fall back to default Helvetica
  }
}

// ─── CSV Export ──────────────────────────────────────────────

export function exportToCSV(
  data: Record<string, unknown>[],
  fileName: string,
  columns: ExportColumn[],
) {
  if (data.length === 0) return;

  const header = columns.map((c) => escapeCSV(c.label)).join(",");
  const rows = data.map((row) =>
    columns.map((c) => escapeCSV(String(getNestedValue(row, c.key) ?? ""))).join(","),
  );

  const csv = [header, ...rows].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${fileName}_${new Date().toISOString().split("T")[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ─── PDF Export ──────────────────────────────────────────────

export interface PDFExportOptions {
  data: Record<string, unknown>[];
  columns: ExportColumn[];
  fileName: string;
  title: string;
  companyName?: string;
  accentColor?: string;
}

export async function exportToPDF({
  data,
  columns,
  fileName,
  title,
  companyName = "OpenRental",
  accentColor = "#2563EB",
}: PDFExportOptions) {
  if (data.length === 0) return;

  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  // Auto-detect orientation: landscape for many columns
  const orientation = columns.length > 6 ? "landscape" : "portrait";
  const doc = new jsPDF({ orientation, unit: "mm", format: "a4" });

  // Load CJK font for Chinese text support
  await loadCJKFont(doc);
  const fontName = cjkFontLoaded ? "NotoSansSC" : "helvetica";

  const pageWidth = doc.internal.pageSize.getWidth();

  // ── Header ──
  doc.setFont(fontName);
  doc.setFontSize(16);
  doc.setTextColor(accentColor);
  doc.text(companyName, 14, 18);

  doc.setFontSize(12);
  doc.setTextColor("#1C1917");
  doc.text(title, 14, 26);

  doc.setFontSize(9);
  doc.setTextColor("#78716C");
  const dateStr = new Date().toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  doc.text(dateStr, pageWidth - 14, 18, { align: "right" });
  doc.text(`${data.length} records`, pageWidth - 14, 24, { align: "right" });

  // ── Table ──
  const tableHead = columns.map((c) => c.label);
  const tableBody = data.map((row) =>
    columns.map((c) => {
      const val = getNestedValue(row, c.key);
      return val != null ? String(val) : "";
    }),
  );

  // Parse hex color to RGB
  const hexToRGB = (hex: string): [number, number, number] => {
    const h = hex.replace("#", "");
    return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
  };

  const [r, g, b] = hexToRGB(accentColor);

  autoTable(doc, {
    startY: 32,
    head: [tableHead],
    body: tableBody,
    styles: {
      fontSize: 9,
      cellPadding: 3,
      lineColor: [229, 231, 235],
      lineWidth: 0.1,
      font: fontName,
    },
    headStyles: {
      fillColor: [r, g, b],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      fontSize: 9,
    },
    alternateRowStyles: {
      fillColor: [249, 250, 251],
    },
    margin: { top: 32, left: 14, right: 14 },
    didDrawPage: (hookData) => {
      // Page footer
      const pageCount = doc.getNumberOfPages();
      const pageNum = hookData.pageNumber;
      doc.setFont(fontName);
      doc.setFontSize(8);
      doc.setTextColor("#9CA3AF");
      doc.text(
        `Page ${pageNum} of ${pageCount}`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 10,
        { align: "center" },
      );
    },
  });

  doc.save(`${fileName}_${new Date().toISOString().split("T")[0]}.pdf`);
}

// ─── Print ───────────────────────────────────────────────────

export function printCurrentPage() {
  window.print();
}
