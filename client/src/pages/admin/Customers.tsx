import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import DashboardLayout from "@/components/DashboardLayout";
import DataTable, { Column } from "@/components/DataTable";
import CustomerProfileDialog from "@/components/CustomerProfileDialog";
import ProvinceSelect from "@/components/ProvinceSelect";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/pricing";
import { Plus, Pencil, Trash2, X, Tag } from "lucide-react";
import ExportToolbar from "@/components/ExportToolbar";
import { MemoryInput } from "@/components/MemoryInput";
import type { CustomerTier } from "@server/services/customerSegmentation";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { serverErrorText } from "@/lib/serverError";
import { canUseModulePermission } from "@/lib/modulePermissions";
import { CUSTOMER_INDUSTRIES, CUSTOMER_LANGUAGES, industryI18nKey, languageI18nKey } from "@shared/customerClassification";
import type { CustomerIndustry } from "@shared/customerClassification";

const emptyForm = {
  name: "", email: "", phone: "", company: "", address: "", city: "", province: "", postalCode: "",
  notes: "", tags: [] as string[], source: "admin" as const,
  birthday: "", greetingOptIn: true, discountPercent: "",
};

// One fixed color per industry so the pill is recognizable at a glance across
// the list; "unset" simply renders nothing (see industryBadge below).
const INDUSTRY_COLORS: Record<typeof CUSTOMER_INDUSTRIES[number], string> = {
  landscaping: "bg-green-100 text-green-700 border border-green-200",
  renovation: "bg-orange-100 text-orange-700 border border-orange-200",
  general_contractor: "bg-blue-100 text-blue-700 border border-blue-200",
  mechanical: "bg-purple-100 text-purple-700 border border-purple-200",
  property: "bg-teal-100 text-teal-700 border border-teal-200",
  individual: "bg-pink-100 text-pink-700 border border-pink-200",
  other: "bg-slate-100 text-slate-600 border border-slate-200",
};

export default function Customers() {
  const { t } = useTranslation(["admin", "common"]);
  const birthdayGreetingsEnabled = useFeatureFlag("birthday_greetings");
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const can = (module: Parameters<typeof canUseModulePermission>[1], action: Parameters<typeof canUseModulePermission>[2]) =>
    canUseModulePermission(myPerms, module, action);
  const utils = trpc.useUtils();
  const segmentationEnabled = useFeatureFlag("customer_segmentation");
  const [tierFilter, setTierFilter] = useState<CustomerTier | "">("");
  const [industryFilter, setIndustryFilter] = useState<typeof CUSTOMER_INDUSTRIES[number] | "">("");
  const [languageFilter, setLanguageFilter] = useState<typeof CUSTOMER_LANGUAGES[number] | "">("");
  const { data: rawData, isLoading } = trpc.customers.list.useQuery(
    segmentationEnabled && tierFilter ? { tier: tierFilter } : undefined,
  );
  // Frontend filtering — the customer list is a small (<200 row) table, so
  // no need to round-trip these two filters through the server.
  const data = rawData?.filter((c) => {
    if (industryFilter && c.industry !== industryFilter && !(c.secondaryIndustries ?? []).includes(industryFilter)) return false;
    if (languageFilter && c.preferredLanguage !== languageFilter) return false;
    return true;
  });
  const createMut = trpc.customers.create.useMutation({
    onSuccess: () => { utils.customers.list.invalidate(); setOpen(false); toast.success(t("customers.customerCreated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateMut = trpc.customers.update.useMutation({
    onSuccess: () => { utils.customers.list.invalidate(); setOpen(false); toast.success(t("customers.customerUpdated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteMut = trpc.customers.delete.useMutation({
    onSuccess: () => { utils.customers.list.invalidate(); toast.success(t("customers.customerDeleted")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [profileId, setProfileId] = useState<number | null>(null);
  const closeModal = useCallback(() => setOpen(false), []);
  useEscapeKey(open, closeModal);

  const [selectedKeys, setSelectedKeys] = useState<Set<string | number>>(new Set());
  const [filteredData, setFilteredData] = useState<NonNullable<typeof data>>([]);
  const [pageTableData, setPageTableData] = useState<NonNullable<typeof data>>([]);

  const handleDataReady = useCallback((info: { filtered: NonNullable<typeof data>; pageData: NonNullable<typeof data> }) => {
    setFilteredData(info.filtered);
    setPageTableData(info.pageData);
  }, []);

  const openAdd = () => { setEditId(null); setForm(emptyForm); setOpen(true); };
  const openEdit = (c: { id: number; name: string; email?: string | null; phone?: string | null; company?: string | null; address?: string | null; city?: string | null; province?: string | null; postalCode?: string | null; notes?: string | null; tags?: unknown; birthday?: string | null; greetingOptIn?: boolean | null; discountPercent?: string | null }) => {
    setEditId(c.id);
    setForm({
      name: c.name || "",
      email: c.email || "",
      phone: c.phone || "",
      company: c.company || "",
      address: c.address || "",
      city: c.city || "",
      province: c.province || "",
      postalCode: c.postalCode || "",
      notes: c.notes || "",
      tags: (c.tags as string[]) || [],
      source: "admin",
      birthday: c.birthday || "",
      greetingOptIn: c.greetingOptIn ?? true,
      discountPercent: c.discountPercent != null && parseFloat(c.discountPercent) > 0 ? String(parseFloat(c.discountPercent)) : "",
    });
    setOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name) return toast.error(t("customers.nameIsRequired"));
    const payload = {
      name: form.name,
      email: form.email || undefined,
      phone: form.phone || undefined,
      company: form.company || undefined,
      address: form.address || undefined,
      city: form.city || undefined,
      province: form.province || undefined,
      postalCode: form.postalCode || undefined,
      notes: form.notes || undefined,
      tags: form.tags.length > 0 ? form.tags : undefined,
      birthday: birthdayGreetingsEnabled && form.birthday ? form.birthday : undefined,
      greetingOptIn: birthdayGreetingsEnabled ? form.greetingOptIn : undefined,
      discountPercent: form.discountPercent.trim() !== "" ? Math.max(0, Math.min(100, parseFloat(form.discountPercent) || 0)) : 0,
    };
    if (editId) {
      updateMut.mutate({ id: editId, ...payload });
    } else {
      createMut.mutate(payload);
    }
  };

  const fmtDate = useFormatCalendarDate();

  const tierBadge = (tier: CustomerTier) => {
    const styles: Record<CustomerTier, string> = {
      vip: "bg-yellow-100 text-yellow-800 border border-yellow-300",
      active: "bg-green-100 text-green-800 border border-green-300",
      at_risk: "bg-amber-100 text-amber-800 border border-amber-300",
      churned: "bg-slate-100 text-slate-500 border border-slate-300",
    };
    const labels: Record<CustomerTier, string> = {
      vip: "VIP",
      active: t("customers.tier.active"),
      at_risk: t("customers.tier.atRisk"),
      churned: t("customers.tier.churned"),
    };
    return (
      <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${styles[tier]}`}>
        {labels[tier]}
      </span>
    );
  };

  type Customer = NonNullable<typeof data>[number];
  const columns: Column<Customer>[] = [
    {
      key: "name",
      label: t("customers.name"),
      // Name and company are one identity in practice — most rows carry the
      // business name in `name` with `company` empty or duplicated — so they
      // share a cell instead of wasting a mostly-empty column.
      render: (c) => (
        <div className="min-w-0">
          <button onClick={() => setProfileId(c.id)} className="text-slate-900 font-medium hover:text-[var(--primary)] hover:underline text-left">
            {c.name}
          </button>
          {c.company && c.company !== c.name && (
            <div className="text-xs text-slate-400 truncate">{c.company}</div>
          )}
        </div>
      ),
    },
    {
      key: "industry",
      label: t("customers.industryLabel"),
      render: (c) => c.industry ? (
        <span className="inline-flex items-center gap-1">
          <span
            className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${INDUSTRY_COLORS[c.industry as typeof CUSTOMER_INDUSTRIES[number]] || INDUSTRY_COLORS.other}`}
          >
            {t(industryI18nKey(c.industry as CustomerIndustry))}
          </span>
          {(c.secondaryIndustries ?? []).length > 0 && (
            <span
              className="text-[10px] text-slate-400"
              title={(c.secondaryIndustries ?? []).map((v: string) => t(industryI18nKey(v as CustomerIndustry))).join(" / ")}
            >
              +{(c.secondaryIndustries ?? []).length}
            </span>
          )}
        </span>
      ) : <span className="text-slate-300">-</span>,
    },
    {
      key: "preferredLanguage",
      label: t("customers.langLabel"),
      render: (c) => c.preferredLanguage === "zh" ? (
        <span title={t(languageI18nKey("zh"))} className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">中</span>
      ) : c.preferredLanguage === "en" ? (
        <span title={t(languageI18nKey("en"))} className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200">EN</span>
      ) : c.preferredLanguage === "other" ? (
        <span className="text-xs text-slate-500">{t("customers.lang.other")}</span>
      ) : <span className="text-slate-300">-</span>,
      hideOnMobile: true,
    },
    { key: "email", label: t("customers.email"), render: (c) => c.email || "-", hideOnMobile: true },
    { key: "phone", label: t("customers.phone"), render: (c) => c.phone || "-", hideOnMobile: true },
    {
      key: "totalRentals",
      label: t("customers.totalRentals"),
      render: (c) => (
        <span className={`text-sm ${c.totalRentals > 0 ? "font-medium text-slate-900" : "text-slate-400"}`}>
          {c.totalRentals}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: "totalRevenue",
      label: t("customers.totalRevenue"),
      render: (c) => (
        <span className="text-sm text-slate-700">
          {Number(c.totalRevenue) > 0 ? formatCurrency(Number(c.totalRevenue)) : "-"}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: "tags",
      label: t("customers.tags"),
      sortable: false,
      searchable: false,
      render: (c) => {
        const tags = (c.tags as string[]) || [];
        if (tags.length === 0) return <span className="text-slate-300">-</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {tags.slice(0, 3).map((tag) => (
              <span key={tag} className="inline-flex items-center gap-0.5 bg-slate-100 text-slate-600 text-[10px] px-1.5 py-0.5 rounded-full">
                <Tag size={8} /> {tag}
              </span>
            ))}
            {tags.length > 3 && <span className="text-[10px] text-slate-400">+{tags.length - 3}</span>}
          </div>
        );
      },
      hideOnMobile: true,
    },
    {
      key: "lastRentalDate",
      label: t("customers.lastRental"),
      render: (c) => <span className="text-sm text-slate-500">{fmtDate(c.lastRentalDate)}</span>,
      hideOnMobile: true,
    },
    ...(segmentationEnabled ? [{
      key: "tier" as const,
      label: t("customers.tier"),
      sortable: false,
      searchable: false,
      render: (c: Customer) => "tier" in c ? tierBadge(c.tier as CustomerTier) : null,
      hideOnMobile: true,
    }] : []),
    {
      key: "_actions",
      label: t("actions", { ns: "common" }),
      sortable: false,
      searchable: false,
      render: (c) => (
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {can('customers', 'update') && (
            <button
              onClick={() => openEdit(c)}
              className="tap-target text-slate-500 hover:text-slate-900"
              aria-label={t("customers.editCustomer")}
            >
              <Pencil size={16} />
            </button>
          )}
          {can('customers', 'delete') && (
            <button
              onClick={() => { if (confirm(t("customers.deleteConfirm"))) deleteMut.mutate({ id: c.id }); }}
              className="tap-target text-slate-400 hover:text-[var(--primary)]"
              aria-label={t("customers.deleteCustomer")}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      ),
    },
  ];

  const exportColumns = [
    { key: "name", label: t("customers.name") },
    { key: "email", label: t("customers.email") },
    { key: "phone", label: t("customers.phone") },
    { key: "company", label: t("customers.company") },
    { key: "industry", label: t("customers.industryLabel") },
    { key: "preferredLanguage", label: t("customers.langLabel") },
    { key: "city", label: t("customers.city") },
    { key: "province", label: t("customers.province") },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("customers.title")}</h1>
          <div className="flex items-center gap-2">
            {segmentationEnabled && (
              <select
                value={tierFilter}
                onChange={(e) => setTierFilter(e.target.value as CustomerTier | "")}
                className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-700 text-sm"
                aria-label={t("customers.filterByTier")}
              >
                <option value="">{t("customers.allTiers")}</option>
                <option value="vip">VIP</option>
                <option value="active">{t("customers.tier.active")}</option>
                <option value="at_risk">{t("customers.atRisk")}</option>
                <option value="churned">{t("customers.tier.churned")}</option>
              </select>
            )}
            <select
              value={industryFilter}
              onChange={(e) => setIndustryFilter(e.target.value as typeof CUSTOMER_INDUSTRIES[number] | "")}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-700 text-sm"
              aria-label={t("customers.filterIndustry")}
            >
              <option value="">{t("customers.filterAllIndustries")}</option>
              {CUSTOMER_INDUSTRIES.map((v) => (
                <option key={v} value={v}>{t(industryI18nKey(v))}</option>
              ))}
            </select>
            <select
              value={languageFilter}
              onChange={(e) => setLanguageFilter(e.target.value as typeof CUSTOMER_LANGUAGES[number] | "")}
              className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-700 text-sm"
              aria-label={t("customers.filterLanguage")}
            >
              <option value="">{t("customers.filterAllLanguages")}</option>
              {CUSTOMER_LANGUAGES.map((v) => (
                <option key={v} value={v}>{t(languageI18nKey(v))}</option>
              ))}
            </select>
            <ExportToolbar
              allData={filteredData.map((c) => ({ name: c.name, email: c.email || "", phone: c.phone || "", company: c.company || "", city: c.city || "", province: c.province || "" }))}
              pageData={pageTableData.map((c) => ({ name: c.name, email: c.email || "", phone: c.phone || "", company: c.company || "", city: c.city || "", province: c.province || "" }))}
              selectedData={Array.from(selectedKeys).flatMap(k => { const c = (data || []).find((_c, i) => i === k); return c ? [{ name: c.name, email: c.email || "", phone: c.phone || "", company: c.company || "", city: c.city || "", province: c.province || "" }] : []; })}
              columns={exportColumns}
              fileName="customers"
              title={t("customers.title")}
            />
            {can('customers', 'create') && <button onClick={openAdd} className="btn-primary flex items-center gap-2"><Plus size={18} /> {t("customers.addCustomer")}</button>}
          </div>
        </div>

        <DataTable
          data={data || []}
          columns={columns}
          isLoading={isLoading}
          emptyMessage={t("customers.noCustomers")}
          searchPlaceholder={t("customers.searchCustomers")}
          selectable
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
          onDataReady={handleDataReady}
        />
      </div>

      {/* Customer Profile Dialog */}
      {profileId && (
        <CustomerProfileDialog
          customerId={profileId}
          onClose={() => setProfileId(null)}
        />
      )}

      {/* Add/Edit Dialog */}
      {open && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{editId ? t("customers.editCustomer") : t("customers.addCustomer")}</h2>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label htmlFor="cust-name" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.name")} <span className="text-[var(--primary)]">*</span></label>
                <input id="cust-name" placeholder={t("customers.nameRequired")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="cust-email" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.email")}</label>
                  <input id="cust-email" type="email" placeholder={t("customers.email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label htmlFor="cust-phone" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.phone")}</label>
                  <input id="cust-phone" placeholder={t("customers.phone")} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div>
                <label htmlFor="cust-company" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.company")}</label>
                <MemoryInput id="cust-company" memoryKey="customer-company" placeholder={t("customers.company")} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div>
                <label htmlFor="cust-address" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.address")}</label>
                <MemoryInput id="cust-address" memoryKey="customer-address" placeholder={t("customers.address")} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor="cust-city" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.city")}</label>
                  <input id="cust-city" placeholder={t("customers.city")} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label htmlFor="cust-province" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.province")}</label>
                  <ProvinceSelect id="cust-province" value={form.province} onChange={(v) => setForm({ ...form, province: v })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
                <div>
                  <label htmlFor="cust-postal" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.postalCode")}</label>
                  <input id="cust-postal" placeholder={t("customers.postalCode")} value={form.postalCode} onChange={(e) => setForm({ ...form, postalCode: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
                </div>
              </div>
              <div>
                <label htmlFor="cust-discount" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.discountPercent")}</label>
                <div className="relative w-40">
                  <input id="cust-discount" type="number" min={0} max={100} step="0.5" placeholder="0" value={form.discountPercent} onChange={(e) => setForm({ ...form, discountPercent: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg pl-3 pr-7 py-2 text-slate-900 text-sm" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">%</span>
                </div>
                <p className="text-xs text-slate-400 mt-1">{t("customers.discountPercentHint")}</p>
              </div>
              <div>
                <label htmlFor="cust-notes" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.notes")}</label>
                <textarea id="cust-notes" placeholder={t("customers.notes")} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              </div>
              {birthdayGreetingsEnabled && (
                <div className="border-t border-slate-200 pt-3 space-y-3">
                  <div>
                    <label htmlFor="cust-birthday" className="block text-sm font-medium text-slate-700 mb-1">{t("customers.birthday")}</label>
                    <input
                      id="cust-birthday"
                      type="date"
                      value={form.birthday}
                      onChange={(e) => setForm({ ...form, birthday: e.target.value })}
                      className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm"
                    />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.greetingOptIn}
                      onChange={(e) => setForm({ ...form, greetingOptIn: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 text-[var(--primary)]"
                    />
                    <span className="text-sm text-slate-700">{t("customers.greetingHint")}</span>
                  </label>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleSubmit} disabled={createMut.isPending || updateMut.isPending} className="btn-primary">{editId ? t("update", { ns: "common" }) : t("create", { ns: "common" })}</button>
            </div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}
