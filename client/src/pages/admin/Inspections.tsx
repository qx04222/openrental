import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import DataTable, { Column } from "@/components/DataTable";
import PhotoLightbox from "@/components/PhotoLightbox";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { toast } from "sonner";
import { Link2, Eye, ArrowLeftRight, Clock, CheckCircle2, XCircle, Trash2, FileDown, Camera, Pencil } from "lucide-react";
import InspectionEditor from "./RentalManagement/InspectionDetailDialog";
import ExportToolbar from "@/components/ExportToolbar";
import { conditionColors, inspectionTypeBadges as typeBadges } from "@/lib/statusColors";
import type { Inspection } from "../../../../drizzle/schema";
import { useFormatCalendarDate, useAppTimezone, formatCalendarDate } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";
import { translateDynamic } from "@/lib/i18nHelpers";

type InspectionType = "dispatch" | "return" | "general";
type ConditionType = "excellent" | "good" | "fair" | "poor";

type InspectionListRow = RouterOutputs["inspections"]["list"][number];
type TokenRow = RouterOutputs["inspections"]["listTokens"][number];

const photoLabels: { key: keyof Inspection; labelKey: string }[] = [
  { key: "photoFront", labelKey: "front" },
  { key: "photoBack", labelKey: "back" },
  { key: "photoLeft", labelKey: "left" },
  { key: "photoRight", labelKey: "right" },
  { key: "photoAdditional", labelKey: "additional" },
];

type DateFilter = "all" | "24h" | "7d" | "30d";

function getDateFilterStart(filter: DateFilter): string | undefined {
  if (filter === "all") return undefined;
  const now = Date.now();
  const ms = filter === "24h" ? 86400000 : filter === "7d" ? 604800000 : 2592000000;
  return new Date(now - ms).toISOString();
}

export default function Inspections() {
  const { t } = useTranslation(["inspection", "common"]);
  const utils = trpc.useUtils();
  const [activeTab, setActiveTab] = useState<"inspections" | "tokens">("inspections");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [conditionFilter, setConditionFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [selectedInspection, setSelectedInspection] = useState<InspectionListRow | null>(null);
  const [comparisonRentalId, setComparisonRentalId] = useState<number | null>(null);

  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set());
  const [filteredData, setFilteredData] = useState<InspectionListRow[]>([]);
  const [pageTableData, setPageTableData] = useState<InspectionListRow[]>([]);

  const handleDataReady = useCallback((info: { filtered: InspectionListRow[]; pageData: InspectionListRow[] }) => {
    setFilteredData(info.filtered);
    setPageTableData(info.pageData);
  }, []);

  // Token creation state
  const [tokenType, setTokenType] = useState<"dispatch" | "return" | "general">("general");
  const [tokenRentalId, setTokenRentalId] = useState("");
  const [tokenFleetId, setTokenFleetId] = useState("");

  // Admin inspection editor state (shared with the rental dialog editor).
  // mode=create needs at least a fleetId or rentalId.
  const [editorState, setEditorState] = useState<
    | { mode: "create"; type: InspectionType; rentalId?: number; rentalFleetId?: number }
    | { mode: "edit"; id: number }
    | null
  >(null);
  const [createPickerOpen, setCreatePickerOpen] = useState(false);
  const [createPickerType, setCreatePickerType] = useState<InspectionType>("general");
  const [createPickerRental, setCreatePickerRental] = useState("");
  const [createPickerFleet, setCreatePickerFleet] = useState("");

  // Queries
  const { data: inspectionsData, isLoading } = trpc.inspections.list.useQuery({
    type: typeFilter !== "all" ? typeFilter as InspectionType : undefined,
    condition: conditionFilter !== "all" ? conditionFilter as ConditionType : undefined,
    startDate: getDateFilterStart(dateFilter),
  });

  const { data: tokensData, isLoading: tokensLoading } = trpc.inspections.listTokens.useQuery(
    undefined,
    { enabled: activeTab === "tokens" }
  );

  const createToken = trpc.inspections.createToken.useMutation({
    onSuccess: (result) => {
      const url = `${window.location.origin}/inspect/${result.token}`;
      navigator.clipboard.writeText(url);
      toast.success(t("linkCopied"));
      utils.inspections.listTokens.invalidate();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deleteToken = trpc.inspections.deleteToken.useMutation({
    onSuccess: () => { utils.inspections.listTokens.invalidate(); toast.success(t("tokenDeleted")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const deleteTokens = trpc.inspections.deleteTokens.useMutation({
    onSuccess: (result) => { utils.inspections.listTokens.invalidate(); setSelectedTokenKeys(new Set()); toast.success(t("tokensDeleted", { count: result.deleted })); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const bulkDeleteInspections = trpc.inspections.bulkDelete.useMutation({
    onSuccess: (result) => { utils.inspections.list.invalidate(); setSelectedKeys(new Set()); toast.success(t("inspectionsDeleted", { count: result.deleted })); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [selectedTokenKeys, setSelectedTokenKeys] = useState<Set<string | number>>(new Set());

  const fmtDate = useFormatCalendarDate();
  const tz = useAppTimezone();
  const fmtDateTime = (d: string | Date | null | undefined) => d ? new Date(d).toLocaleString() : "-";

  // Inspection columns for DataTable
  const inspectionColumns: Column<InspectionListRow>[] = [
    {
      key: "inspections.id",
      label: t("columnId"),
      render: (row) => <span className="font-medium text-slate-900">#{row.inspections.id}</span>,
    },
    {
      key: "inspections.type",
      label: t("type"),
      render: (row) => (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${typeBadges[row.inspections.type] || ""}`}>
          {t(row.inspections.type, { defaultValue: row.inspections.type })}
        </span>
      ),
    },
    {
      key: "rental_fleet.brand",
      label: t("equipment"),
      render: (row) => {
        const fleet = row.rental_fleet;
        return fleet ? `${fleet.brand} ${fleet.model}` : row.inspections.equipmentSelected || "-";
      },
    },
    {
      key: "rental_requests.id",
      label: t("rental") + "#",
      render: (row) => row.rental_requests?.rentalNumber || (row.rental_requests?.id ? `#${row.rental_requests.id}` : "-"),
      hideOnMobile: true,
    },
    {
      key: "inspections.inspectorName",
      label: t("inspector"),
      render: (row) => row.inspections.inspectorName || "-",
      hideOnMobile: true,
    },
    {
      key: "inspections.overallCondition",
      label: t("condition"),
      render: (row) => (
        <span className={`font-medium capitalize ${conditionColors[row.inspections.overallCondition || ""] || "text-slate-400"}`}>
          {row.inspections.overallCondition
            ? t(`condition.${row.inspections.overallCondition}`, { ns: "common", defaultValue: row.inspections.overallCondition })
            : "-"}
        </span>
      ),
    },
    {
      key: "inspections.createdAt",
      label: t("date"),
      render: (row) => <span className="text-sm">{fmtDate(row.inspections.createdAt)}</span>,
      hideOnMobile: true,
    },
    {
      key: "_actions",
      label: "",
      sortable: false,
      searchable: false,
      render: (row) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setSelectedInspection(row)} className="tap-target p-1 text-slate-400 hover:text-slate-600" title={t("viewDetails")} aria-label={t("viewDetails")}>
            <Eye size={16} />
          </button>
          <button
            onClick={() => setEditorState({ mode: "edit", id: row.inspections.id })}
            className="tap-target p-1 text-slate-400 hover:text-emerald-600"
            title={t("editInspection")}
            aria-label={t("editInspection")}
          >
            <Pencil size={16} />
          </button>
          {row.inspections.rentalId && (
            <button onClick={() => setComparisonRentalId(row.inspections.rentalId)} className="tap-target p-1 text-slate-400 hover:text-blue-600" title={t("compareInspections")} aria-label={t("compareInspections")}>
              <ArrowLeftRight size={16} />
            </button>
          )}
        </div>
      ),
    },
  ];

  // Token columns for DataTable
  const tokenColumns: Column<TokenRow>[] = [
    {
      key: "id",
      label: t("columnId"),
      render: (row) => <span className="font-medium text-slate-900">#{row.id}</span>,
    },
    {
      key: "inspectionType",
      label: t("type"),
      render: (row) => (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${typeBadges[row.inspectionType] || ""}`}>
          {t(row.inspectionType, { defaultValue: row.inspectionType })}
        </span>
      ),
    },
    {
      key: "rentalCustomerName",
      label: t("rental"),
      render: (row) => row.rentalId ? (
        <div>
          <span className="text-slate-900">{row.rentalNumber || `#${row.rentalId}`}</span>
          {row.rentalCustomerName && <span className="text-xs text-slate-400 ml-1">({row.rentalCustomerName})</span>}
        </div>
      ) : "-",
    },
    {
      key: "fleetBrand",
      label: t("equipment"),
      render: (row) => row.fleetBrand ? `${row.fleetBrand} ${row.fleetModel}` : "-",
      hideOnMobile: true,
    },
    {
      key: "isUsed",
      label: t("status"),
      render: (row) => {
        const expired = new Date() > new Date(row.expiresAt);
        if (row.isUsed) return <span className="flex items-center gap-1 text-green-600 text-xs"><CheckCircle2 size={14} /> {t("tokenUsed")}</span>;
        if (expired) return <span className="flex items-center gap-1 text-red-500 text-xs"><XCircle size={14} /> {t("tokenExpired")}</span>;
        return <span className="flex items-center gap-1 text-blue-600 text-xs"><Clock size={14} /> {t("tokenActive")}</span>;
      },
    },
    {
      key: "createdAt",
      label: t("created"),
      render: (row) => <span className="text-sm">{fmtDate(row.createdAt)}</span>,
      hideOnMobile: true,
    },
    {
      key: "expiresAt",
      label: t("expires"),
      render: (row) => <span className="text-sm">{fmtDateTime(row.expiresAt)}</span>,
      hideOnMobile: true,
    },
    {
      key: "_actions",
      label: "",
      sortable: false,
      searchable: false,
      render: (row) => (
        <button
          onClick={(e) => { e.stopPropagation(); if (confirm(t("deleteTokenConfirm"))) deleteToken.mutate({ id: row.id }); }}
          className="tap-target p-1 text-slate-400 hover:text-[var(--primary)]"
          title={t("deleteToken")}
        >
          <Trash2 size={16} />
        </button>
      ),
    },
  ];

  const exportColumns = [
    { key: "id", label: t("columnId") },
    { key: "type", label: t("type") },
    { key: "equipment", label: t("equipment") },
    { key: "rental", label: t("rental") + "#" },
    { key: "inspector", label: t("inspector") },
    { key: "condition", label: t("condition") },
    { key: "date", label: t("date") },
  ];

  const mapInspectionForExport = (r: InspectionListRow) => ({
    id: r.inspections.id,
    type: t(r.inspections.type, { defaultValue: r.inspections.type }),
    equipment: `${r.rental_fleet?.brand || ""} ${r.rental_fleet?.model || ""}`.trim(),
    rental: r.rental_requests?.rentalNumber || r.rental_requests?.id || "",
    inspector: r.inspections.inspectorName || "",
    condition: r.inspections.overallCondition
      ? t(`condition.${r.inspections.overallCondition}`, { ns: "common", defaultValue: r.inspections.overallCondition })
      : "",
    date: r.inspections.createdAt ? formatCalendarDate(r.inspections.createdAt, tz) : "",
  });

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("title")}</h1>
          <ExportToolbar
            allData={filteredData.map(mapInspectionForExport)}
            pageData={pageTableData.map(mapInspectionForExport)}
            selectedData={Array.from(selectedKeys).map(k => {
              const r = (inspectionsData || []).find((_, i) => i === k);
              return r ? mapInspectionForExport(r) : null;
            }).filter(Boolean) as Record<string, unknown>[]}
            columns={exportColumns}
            fileName="inspections"
            title={t("title")}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-slate-200">
          <button
            onClick={() => setActiveTab("inspections")}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === "inspections" ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          >
            {t("title")}
          </button>
          <button
            onClick={() => setActiveTab("tokens")}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${activeTab === "tokens" ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-slate-500 hover:text-slate-700"}`}
          >
            {t("tokens")}
          </button>
        </div>

        {activeTab === "inspections" && (
          <>
            {/* Filters */}
            <div className="flex gap-3 flex-wrap">
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900">
                <option value="all">{t("allTypes")}</option>
                <option value="dispatch">{t("dispatch")}</option>
                <option value="return">{t("return")}</option>
                <option value="general">{t("general")}</option>
              </select>
              <select value={conditionFilter} onChange={(e) => setConditionFilter(e.target.value)} className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900">
                <option value="all">{t("allConditions")}</option>
                <option value="excellent">{t("condition.excellent", { ns: "common" })}</option>
                <option value="good">{t("condition.good", { ns: "common" })}</option>
                <option value="fair">{t("condition.fair", { ns: "common" })}</option>
                <option value="poor">{t("condition.poor", { ns: "common" })}</option>
              </select>
              <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value as DateFilter)} className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900">
                <option value="all">{t("allTime")}</option>
                <option value="24h">{t("last24h")}</option>
                <option value="7d">{t("last7days")}</option>
                <option value="30d">{t("last30days")}</option>
              </select>
              <div className="ml-auto">
                <button
                  onClick={() => setCreatePickerOpen((v) => !v)}
                  className="text-sm bg-emerald-50 text-emerald-700 hover:bg-emerald-100 px-3 py-2 rounded-lg border border-emerald-200 flex items-center gap-1.5"
                >
                  <Camera size={14} /> {t("newAdminInspection")}
                </button>
              </div>
            </div>

            {/* Admin inspection create picker — choose rental/fleet then open editor */}
            {createPickerOpen && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-emerald-800 mb-3">{t("newAdminInspection")}</h3>
                <div className="flex gap-3 flex-wrap items-end">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">{t("type")}</label>
                    <select
                      value={createPickerType}
                      onChange={(e) => setCreatePickerType(e.target.value as InspectionType)}
                      className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900"
                    >
                      <option value="general">{t("general")}</option>
                      <option value="dispatch">{t("dispatch")}</option>
                      <option value="return">{t("return")}</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">{t("rentalIdOptional")}</label>
                    <input
                      type="number"
                      value={createPickerRental}
                      onChange={(e) => setCreatePickerRental(e.target.value)}
                      placeholder="#"
                      className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 w-24"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">{t("fleetIdOptional")}</label>
                    <input
                      type="number"
                      value={createPickerFleet}
                      onChange={(e) => setCreatePickerFleet(e.target.value)}
                      placeholder="#"
                      className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 w-24"
                    />
                  </div>
                  <button
                    onClick={() => {
                      const rid = createPickerRental ? parseInt(createPickerRental, 10) : undefined;
                      const fid = createPickerFleet ? parseInt(createPickerFleet, 10) : undefined;
                      if (!rid && !fid) {
                        toast.error(t("adminInspectionPickerNeedsId"));
                        return;
                      }
                      setEditorState({ mode: "create", type: createPickerType, rentalId: rid, rentalFleetId: fid });
                      setCreatePickerOpen(false);
                      setCreatePickerRental("");
                      setCreatePickerFleet("");
                    }}
                    className="btn-primary text-sm"
                  >
                    {t("openEditor")}
                  </button>
                  <button
                    onClick={() => setCreatePickerOpen(false)}
                    className="text-sm px-3 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"
                  >
                    {t("cancel", { ns: "common" })}
                  </button>
                </div>
              </div>
            )}

            {selectedKeys.size > 0 && (
              <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2">
                <span className="text-sm text-slate-600">{t("selectedCount", { count: selectedKeys.size })}</span>
                <button
                  onClick={() => {
                    if (confirm(t("deleteInspectionsConfirm", { count: selectedKeys.size }))) {
                      const ids = Array.from(selectedKeys) as number[];
                      if (ids.length > 0) bulkDeleteInspections.mutate({ ids });
                    }
                  }}
                  disabled={bulkDeleteInspections.isPending}
                  className="text-sm text-red-600 hover:text-red-800 font-medium flex items-center gap-1"
                >
                  <Trash2 size={14} /> {t("deleteSelected", { count: selectedKeys.size })}
                </button>
              </div>
            )}

            <DataTable
              data={inspectionsData || []}
              columns={inspectionColumns}
              isLoading={isLoading}
              onRowClick={(row) => setSelectedInspection(row)}
              emptyMessage={t("noInspections")}
              searchPlaceholder={t("searchInspections")}
              selectable
              rowKey={(row) => row.inspections.id}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
              onDataReady={handleDataReady}
            />
          </>
        )}

        {activeTab === "tokens" && (
          <>
            {/* Token Creation */}
            <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-semibold text-slate-500 uppercase mb-3">{t("createToken")}</h3>
              <div className="flex gap-3 flex-wrap items-end">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("type")}</label>
                  <select value={tokenType} onChange={(e) => setTokenType(e.target.value as InspectionType)} className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900">
                    <option value="general">{t("general")}</option>
                    <option value="dispatch">{t("dispatch")}</option>
                    <option value="return">{t("return")}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("rentalIdOptional")}</label>
                  <input type="number" value={tokenRentalId} onChange={(e) => setTokenRentalId(e.target.value)} placeholder="#" className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 w-24" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("fleetIdOptional")}</label>
                  <input type="number" value={tokenFleetId} onChange={(e) => setTokenFleetId(e.target.value)} placeholder="#" className="bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 w-24" />
                </div>
                <button
                  onClick={() => createToken.mutate({
                    inspectionType: tokenType,
                    rentalId: tokenRentalId ? parseInt(tokenRentalId) : undefined,
                    rentalFleetId: tokenFleetId ? parseInt(tokenFleetId) : undefined,
                  })}
                  disabled={createToken.isPending}
                  className="btn-primary flex items-center gap-2"
                >
                  <Link2 size={16} /> {t("createToken")}
                </button>
              </div>
            </div>

            {selectedTokenKeys.size > 0 && (
              <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2">
                <span className="text-sm text-slate-600">{t("selectedCount", { count: selectedTokenKeys.size })}</span>
                <button
                  onClick={() => {
                    if (confirm(t("deleteTokensConfirm", { count: selectedTokenKeys.size })))
                      deleteTokens.mutate({ ids: Array.from(selectedTokenKeys) as number[] });
                  }}
                  disabled={deleteTokens.isPending}
                  className="text-sm text-red-600 hover:text-red-800 font-medium flex items-center gap-1"
                >
                  <Trash2 size={14} /> {t("deleteSelected", { count: selectedTokenKeys.size })}
                </button>
              </div>
            )}

            <DataTable
              data={tokensData || []}
              columns={tokenColumns}
              isLoading={tokensLoading}
              emptyMessage={t("noTokens")}
              searchPlaceholder={t("searchTokens")}
              selectable
              rowKey={(row) => row.id}
              selectedKeys={selectedTokenKeys}
              onSelectionChange={setSelectedTokenKeys}
            />
          </>
        )}
      </div>

      {/* Inspection Detail Dialog (read-only viewer) */}
      {selectedInspection && (
        <InspectionDetailDialog
          inspection={selectedInspection}
          onClose={() => setSelectedInspection(null)}
          onEdit={(id) => {
            setSelectedInspection(null);
            setEditorState({ mode: "edit", id });
          }}
        />
      )}

      {/* Comparison Dialog */}
      {comparisonRentalId && (
        <ComparisonDialog
          rentalId={comparisonRentalId}
          onClose={() => setComparisonRentalId(null)}
        />
      )}

      {/* Admin inspection editor (drag-drop upload + edit fields).
          Shared with the rental detail dialog so data is the same. */}
      {editorState && (
        <InspectionEditor
          inspectionId={editorState.mode === "edit" ? editorState.id : undefined}
          rentalId={editorState.mode === "create" ? editorState.rentalId : undefined}
          rentalFleetId={editorState.mode === "create" ? editorState.rentalFleetId : undefined}
          defaultType={editorState.mode === "create" ? editorState.type : undefined}
          onClose={() => {
            setEditorState(null);
            utils.inspections.list.invalidate();
          }}
        />
      )}
    </DashboardLayout>
  );
}

// ─── Inspection Detail Dialog ────────────────────────────────────

function InspectionDetailDialog({ inspection, onClose, onEdit }: { inspection: InspectionListRow; onClose: () => void; onEdit?: (id: number) => void }) {
  const { t } = useTranslation(["inspection", "common"]);
  const [lightboxPhotos, setLightboxPhotos] = useState<{ src: string; label: string }[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const generatePDF = trpc.inspections.generatePDF.useMutation({
    onSuccess: (result) => { window.open(result.url, "_blank"); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const insp = inspection.inspections;
  const fleet = inspection.rental_fleet;
  const fmtDate = (d: string | Date | null | undefined) => d ? new Date(d).toLocaleString() : "-";

  const allPhotos = photoLabels
    .filter(({ key }) => insp[key])
    .map(({ key, labelKey }) => ({ src: insp[key] as string, label: translateDynamic(t, labelKey) }));

  if (insp.customerSignature) {
    allPhotos.push({ src: insp.customerSignature, label: t("signature") as string });
  }

  const openLightbox = (idx: number) => {
    setLightboxPhotos(allPhotos);
    setLightboxIndex(idx);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/60" onClick={onClose} />
        <div className="relative bg-[var(--surface-container-lowest)] rounded-xl shadow-sm max-w-3xl w-full max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex justify-between items-center z-10">
            <h2 className="text-lg font-bold text-slate-900">
              {t("inspectionDetailTitle", { type: t(insp.type, { defaultValue: insp.type }), id: insp.id })}
            </h2>
            <div className="flex items-center gap-2">
              {onEdit && (
                <button
                  onClick={() => onEdit(insp.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-emerald-300 text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition"
                  title={t("editInspection")}
                >
                  <Pencil size={14} /> {t("editInspection")}
                </button>
              )}
              <button
                onClick={() => generatePDF.mutate({ id: insp.id })}
                disabled={generatePDF.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 transition"
                title={t("downloadPDF")}
              >
                <FileDown size={16} />
                {generatePDF.isPending ? "..." : "PDF"}
              </button>
              <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl" aria-label="Close">&times;</button>
            </div>
          </div>

          <div className="p-6 space-y-6">
            {/* Equipment Info */}
            <div className="bg-slate-50 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-slate-500 uppercase mb-2">{t("equipment")}</h3>
              <p className="text-slate-900 font-medium">{fleet ? `${fleet.brand} ${fleet.model}` : insp.equipmentSelected || t("na")}</p>
              {fleet?.serialNumber && <p className="text-sm text-slate-500">{t("sn")} {fleet.serialNumber}</p>}
              {insp.rentalId && <p className="text-sm text-slate-500">{t("rentalLabel")} {inspection.rental_requests?.rentalNumber || `#${insp.rentalId}`}</p>}
            </div>

            {/* Readings Grid */}
            <div>
              <h3 className="text-sm font-semibold text-slate-500 uppercase mb-2">{t("readings")}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="text-xs text-slate-400">{t("engineHours")}</div>
                  <div className="text-lg font-semibold text-slate-900">{insp.engineHours ?? "-"}</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="text-xs text-slate-400">{t("fuelLevel")}</div>
                  {(insp.fuelLevelPercent != null || insp.fuelLevel != null) ? (
                    <>
                      <div className="text-lg font-semibold text-slate-900 mb-1">{insp.fuelLevelPercent ?? insp.fuelLevel}%</div>
                      {/* Fuel gauge bar */}
                      <div className="w-full h-3 bg-slate-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            (insp.fuelLevelPercent ?? insp.fuelLevel ?? 0) <= 25 ? "bg-red-500" :
                            (insp.fuelLevelPercent ?? insp.fuelLevel ?? 0) <= 50 ? "bg-amber-500" :
                            (insp.fuelLevelPercent ?? insp.fuelLevel ?? 0) <= 75 ? "bg-lime-500" :
                            "bg-green-500"
                          }`}
                          style={{ width: `${insp.fuelLevelPercent ?? insp.fuelLevel ?? 0}%` }}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="text-lg font-semibold text-slate-900">-</div>
                  )}
                </div>
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="text-xs text-slate-400">{t("odometer")}</div>
                  <div className="text-lg font-semibold text-slate-900">{insp.odometerReading ?? "-"}</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="text-xs text-slate-400">{t("location")}</div>
                  <div className="text-sm font-medium text-slate-900 truncate">{insp.locationAddress || "-"}</div>
                </div>
              </div>
            </div>

            {/* Fuel Charge */}
            {insp.fuelChargeAmount && parseFloat(insp.fuelChargeAmount) > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-amber-700 uppercase mb-2">{t("fuelCharge")}</h3>
                <p className="text-xl font-bold text-amber-900">${parseFloat(insp.fuelChargeAmount).toFixed(2)}</p>
                <p className="text-xs text-amber-600 mt-1">{t("fuelChargeAutoInvoice")}</p>
              </div>
            )}

            {/* Damage Claim Auto-Created */}
            {insp.type === "return" && (insp.damageSeverity === "moderate" || insp.damageSeverity === "severe") && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-red-700 uppercase mb-1">{t("damageClaimCreated")}</h3>
                <p className="text-xs text-red-600">{t("damageClaimAutoNote")}</p>
              </div>
            )}

            {/* Condition */}
            <div>
              <h3 className="text-sm font-semibold text-slate-500 uppercase mb-2">{t("condition")}</h3>
              <div className="flex items-center gap-4">
                <span className={`text-lg font-semibold capitalize ${conditionColors[insp.overallCondition || ""] || "text-slate-400"}`}>
                  {insp.overallCondition
                    ? t(`condition.${insp.overallCondition}`, { ns: "common", defaultValue: insp.overallCondition })
                    : t("na")}
                </span>
                {insp.damageSeverity && insp.damageSeverity !== "none" && (
                  <span className="px-2 py-1 bg-red-50 text-red-600 rounded text-xs font-medium">
                    {t("damage")} {t(`damage.${insp.damageSeverity}`, { ns: "common", defaultValue: insp.damageSeverity })}
                  </span>
                )}
              </div>
              {insp.damageNotes && (
                <div className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-800">
                  {insp.damageNotes}
                </div>
              )}
              {insp.notes && <p className="mt-2 text-sm text-slate-600">{insp.notes}</p>}
            </div>

            {/* Photos Grid */}
            {allPhotos.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-500 uppercase mb-2">{t("photosSignature")}</h3>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                  {allPhotos.map((photo, idx) => (
                    <button key={idx} onClick={() => openLightbox(idx)} className="group">
                      <img src={photo.src} alt={photo.label} className="w-full h-28 object-cover rounded-lg border border-slate-200 group-hover:ring-2 group-hover:ring-[var(--primary)] transition" />
                      <span className="text-xs text-slate-400 mt-1 block">{photo.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Metadata */}
            <div className="text-xs text-slate-400 space-y-1">
              <div>{t("createdLabel")} {fmtDate(insp.createdAt)}</div>
              {insp.inspectorName && <div>{t("inspectorLabel")} {insp.inspectorName}</div>}
              {insp.customerSignedAt && <div>{t("signed")} {fmtDate(insp.customerSignedAt)}</div>}
              {insp.latitude && insp.longitude && <div>{t("gps")} {insp.latitude}, {insp.longitude}</div>}
            </div>
          </div>
        </div>
      </div>

      {/* Photo Lightbox */}
      {lightboxPhotos && (
        <PhotoLightbox
          photos={lightboxPhotos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxPhotos(null)}
        />
      )}
    </>
  );
}

// ─── Comparison Dialog ──────────────────────────────────────────

function ComparisonDialog({ rentalId, onClose }: { rentalId: number; onClose: () => void }) {
  const { t } = useTranslation(["inspection", "common"]);
  const { data, isLoading } = trpc.inspections.getComparisonForRental.useQuery({ rentalId });
  const [lightboxPhotos, setLightboxPhotos] = useState<{ src: string; label: string }[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  const fmtDate = (d: string | Date | null | undefined) => d ? new Date(d).toLocaleString() : "-";

  const renderSide = (insp: Inspection | null | undefined, label: string, noInspectionKey: string) => {
    if (!insp) return (
      <div className="flex-1 p-4 bg-slate-50 rounded-lg flex items-center justify-center text-slate-400 text-sm">
        {translateDynamic(t, noInspectionKey)}
      </div>
    );

    const photos = photoLabels
      .filter(({ key }) => insp[key])
      .map(({ key, labelKey }) => ({ src: insp[key] as string, label: `${label} - ${translateDynamic(t, labelKey)}` }));

    return (
      <div className="flex-1 space-y-3">
        <h4 className="font-semibold text-slate-900 capitalize">{label}</h4>
        <p className="text-xs text-slate-400">{fmtDate(insp.createdAt)}</p>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div><span className="text-slate-400">{t("conditionLabel")}</span> <span className={`capitalize font-medium ${conditionColors[insp.overallCondition || ""] || ""}`}>{insp.overallCondition ? t(`condition.${insp.overallCondition}`, { ns: "common", defaultValue: insp.overallCondition }) : "-"}</span></div>
          <div><span className="text-slate-400">{t("engineHoursLabel")}</span> <span className="font-medium">{insp.engineHours ?? "-"}</span></div>
          <div><span className="text-slate-400">{t("fuelLabel")}</span> <span className="font-medium">{insp.fuelLevel != null ? `${insp.fuelLevel}%` : "-"}</span></div>
          <div><span className="text-slate-400">{t("odometerLabel")}</span> <span className="font-medium">{insp.odometerReading ?? "-"}</span></div>
        </div>
        {insp.damageNotes && <p className="text-sm text-yellow-700 bg-yellow-50 p-2 rounded">{insp.damageNotes}</p>}
        {photos.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {photos.map((p, i) => (
              <button key={i} onClick={() => { setLightboxPhotos(photos); setLightboxIndex(i); }}>
                <img src={p.src} alt={p.label} className="w-full h-20 object-cover rounded border border-slate-200 hover:ring-2 hover:ring-[var(--primary)]" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="fixed inset-0 bg-black/60" onClick={onClose} />
        <div className="relative bg-[var(--surface-container-lowest)] rounded-xl shadow-sm max-w-5xl w-full max-h-[90vh] overflow-y-auto">
          <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex justify-between items-center z-10">
            <h2 className="text-lg font-bold text-slate-900">{t("dispatchVsReturn", { id: rentalId })}</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl" aria-label="Close">&times;</button>
          </div>

          <div className="p-6">
            {isLoading ? (
              <div className="flex items-center justify-center py-12"><div className="spinner" /><span className="ml-3 text-sm text-slate-500">{t("loadingComparison")}</span></div>
            ) : (
              <div className="flex gap-6 flex-col md:flex-row">
                {renderSide(data?.dispatch, t("dispatch"), "noDispatchInspection")}
                <div className="hidden md:block w-px bg-slate-200" />
                <div className="md:hidden h-px bg-slate-200" />
                {renderSide(data?.return, t("return"), "noReturnInspection")}
              </div>
            )}
          </div>
        </div>
      </div>

      {lightboxPhotos && (
        <PhotoLightbox
          photos={lightboxPhotos}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxPhotos(null)}
        />
      )}
    </>
  );
}
