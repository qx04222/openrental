import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Download, Printer, ChevronDown } from "lucide-react";
import { exportToCSV, exportToPDF, printCurrentPage } from "@/lib/exportUtils";
import type { ExportColumn } from "@/lib/exportUtils";

interface ExportToolbarProps {
  allData: Record<string, unknown>[];
  pageData: Record<string, unknown>[];
  selectedData: Record<string, unknown>[];
  columns: ExportColumn[];
  fileName: string;
  title: string;
  onPrint?: () => void;
}

export default function ExportToolbar({
  allData,
  pageData,
  selectedData,
  columns,
  fileName,
  title,
  onPrint,
}: ExportToolbarProps) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const hasSelected = selectedData.length > 0;

  const doExport = async (format: "csv" | "pdf", scope: "selected" | "page" | "all") => {
    const data = scope === "selected" ? selectedData : scope === "page" ? pageData : allData;
    if (data.length === 0) return;
    if (format === "csv") {
      exportToCSV(data, fileName, columns);
    } else {
      await exportToPDF({ data, columns, fileName, title });
    }
    setOpen(false);
  };

  const itemBase =
    "w-full text-left px-4 py-2 text-sm hover:bg-slate-50 transition-colors flex items-center justify-between";

  return (
    <div className="flex gap-2 print:hidden" ref={ref}>
      {/* Export dropdown */}
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition"
        >
          <Download size={14} />
          {t("export.export")}
          <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {open && (
          <div className="absolute right-0 mt-1 w-56 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 animate-fade-in">
            {/* CSV section */}
            <div className="px-4 py-1.5 text-xs font-semibold text-slate-400 uppercase">CSV</div>
            {hasSelected && (
              <button
                onClick={() => doExport("csv", "selected")}
                className={itemBase}
              >
                {t("export.exportSelected", { count: selectedData.length })}
              </button>
            )}
            <button onClick={() => doExport("csv", "page")} className={itemBase}>
              {t("export.exportPage")}
            </button>
            <button onClick={() => doExport("csv", "all")} className={itemBase}>
              {t("export.exportAll", { count: allData.length })}
            </button>

            <div className="border-t border-slate-100 my-1" />

            {/* PDF section */}
            <div className="px-4 py-1.5 text-xs font-semibold text-slate-400 uppercase">PDF</div>
            {hasSelected && (
              <button
                onClick={() => doExport("pdf", "selected")}
                className={itemBase}
              >
                {t("export.exportSelected", { count: selectedData.length })}
              </button>
            )}
            <button onClick={() => doExport("pdf", "page")} className={itemBase}>
              {t("export.exportPage")}
            </button>
            <button onClick={() => doExport("pdf", "all")} className={itemBase}>
              {t("export.exportAll", { count: allData.length })}
            </button>
          </div>
        )}
      </div>

      {/* Print button */}
      <button
        onClick={onPrint || printCurrentPage}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition"
      >
        <Printer size={14} />
        {t("export.print")}
      </button>
    </div>
  );
}
