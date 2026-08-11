import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { useAuth } from "@/hooks/useAuth";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { formatCurrency } from "@/lib/pricing";
import { rentalStatusColors } from "@/lib/statusColors";
import { useFormatCalendarDate, formatCalendarDateISO } from "@/lib/dateUtils";
import {
  X, User, FileText, MessageSquare, CalendarClock,
  Phone, Mail, Building2, MapPin, Tag, TrendingUp,
  DollarSign, Activity, BarChart3, Plus, Send, ShieldAlert,
} from "lucide-react";
import { serverErrorText } from "@/lib/serverError";
import { CUSTOMER_INDUSTRIES, CUSTOMER_LANGUAGES, industryI18nKey, languageI18nKey } from "@shared/customerClassification";

const INTERACTION_TYPES = ["call", "email", "note", "visit", "complaint", "follow_up"] as const;
type InteractionType = typeof INTERACTION_TYPES[number];

const INTERACTION_ICONS: Record<InteractionType, string> = {
  call: "📞", email: "📧", note: "📝", visit: "🏠", complaint: "⚠️", follow_up: "🔄",
};

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string | number; icon: typeof DollarSign; color: string }) {
  return (
    <div className="bg-slate-50 rounded-lg p-3 text-center">
      <Icon size={16} className={`mx-auto mb-1 ${color}`} />
      <div className="text-lg font-bold text-slate-900">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

export default function CustomerProfileDialog({ customerId, onClose }: { customerId: number; onClose: () => void }) {
  const { t } = useTranslation(["admin", "common"]);
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const creditFlagEnabled = useFeatureFlag("credit_limit");
  const isSuperAdmin = user?.role === "super_admin";

  const [activeTab, setActiveTab] = useState<"overview" | "rentals" | "interactions" | "followup" | "credit">("overview");
  const [newInteractionType, setNewInteractionType] = useState<InteractionType>("note");
  const [newInteractionText, setNewInteractionText] = useState("");
  const [followUpDate, setFollowUpDate] = useState("");
  const [followUpNotes, setFollowUpNotes] = useState("");

  // Credit tab state
  const [creditLimitInput, setCreditLimitInput] = useState("");
  const [blacklistReason, setBlacklistReason] = useState("");

  useEscapeKey(true, useCallback(() => onClose(), [onClose]));

  const { data: profile, isLoading } = trpc.customers.getProfile.useQuery({ id: customerId });
  const { data: interactions } = trpc.customers.getInteractions.useQuery(
    { customerId },
    { enabled: activeTab === "interactions" },
  );

  const addInteraction = trpc.customers.addInteraction.useMutation({
    onSuccess: () => {
      utils.customers.getInteractions.invalidate({ customerId });
      utils.customers.getProfile.invalidate({ id: customerId });
      setNewInteractionText("");
      toast.success(t("customers.interactionAdded"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateFollowUp = trpc.customers.updateFollowUp.useMutation({
    onSuccess: () => {
      utils.customers.getProfile.invalidate({ id: customerId });
      toast.success(t("customers.followUpUpdated"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const updateCustomer = trpc.customers.update.useMutation({
    onSuccess: () => {
      utils.customers.getProfile.invalidate({ id: customerId });
      utils.customers.list.invalidate();
      toast.success(t("customers.customerUpdated"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const setBlacklist = trpc.customers.setBlacklist.useMutation({
    onSuccess: () => {
      utils.customers.getProfile.invalidate({ id: customerId });
      setBlacklistReason("");
      toast.success(t("profile.blacklistUpdated"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const setCreditLimit = trpc.customers.setCreditLimit.useMutation({
    onSuccess: () => {
      utils.customers.getProfile.invalidate({ id: customerId });
      setCreditLimitInput("");
      toast.success(t("profile.creditLimitUpdated"));
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const customer = profile?.customer;
  const rentals = profile?.rentals || [];
  const stats = profile?.stats;

  const fmtDate = useFormatCalendarDate();

  const tabs = [
    { key: "overview" as const, label: t("customers.profile.overview"), icon: User },
    { key: "rentals" as const, label: t("customers.profile.rentalHistory"), icon: FileText },
    { key: "interactions" as const, label: t("customers.profile.interactions"), icon: MessageSquare },
    { key: "followup" as const, label: t("customers.profile.followUp"), icon: CalendarClock },
    ...(creditFlagEnabled ? [{ key: "credit" as const, label: t("customers.profile.credit"), icon: ShieldAlert }] : []),
  ];

  // Tag management
  const customerTags = (customer?.tags as string[]) || [];
  const [tagInput, setTagInput] = useState("");

  const addTag = () => {
    if (!tagInput.trim() || !customer) return;
    const newTags = [...customerTags, tagInput.trim()];
    updateCustomer.mutate({ id: customer.id, tags: newTags });
    setTagInput("");
  };

  const removeTag = (tag: string) => {
    if (!customer) return;
    updateCustomer.mutate({ id: customer.id, tags: customerTags.filter((t) => t !== tag) });
  };

  // Classification (industry / preferred language) — writes go through the
  // same customers.update mutation; touching either field auto-confirms it
  // as human-reviewed on the server.
  const handleIndustryChange = (v: string) => {
    if (!customer) return;
    updateCustomer.mutate({ id: customer.id, industry: v === "" ? null : (v as typeof CUSTOMER_INDUSTRIES[number]) });
  };
  const toggleSecondary = (v: typeof CUSTOMER_INDUSTRIES[number]) => {
    if (!customer) return;
    const cur = (customer.secondaryIndustries ?? []) as typeof CUSTOMER_INDUSTRIES[number][];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    updateCustomer.mutate({ id: customer.id, secondaryIndustries: next });
  };
  const handleLanguageChange = (v: string) => {
    if (!customer) return;
    updateCustomer.mutate({ id: customer.id, preferredLanguage: v === "" ? null : (v as typeof CUSTOMER_LANGUAGES[number]) });
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl border border-slate-200 w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[var(--primary)]/10 flex items-center justify-center">
              <User size={20} className="text-[var(--primary)]" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">{customer?.name || "..."}</h2>
              <div className="flex items-center gap-3 text-xs text-slate-500">
                {customer?.email && <span className="flex items-center gap-1"><Mail size={10} /> {customer.email}</span>}
                {customer?.phone && <span className="flex items-center gap-1"><Phone size={10} /> {customer.phone}</span>}
                {customer?.company && <span className="flex items-center gap-1"><Building2 size={10} /> {customer.company}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {stats && stats.totalRentals > 1 && (
              <span className="bg-green-100 text-green-700 text-xs font-medium px-2 py-0.5 rounded-full">
                {t("customers.profile.returningCustomer")}
              </span>
            )}
            <button onClick={onClose} className="text-slate-500 hover:text-slate-900" aria-label={t("close", { ns: "common" })}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 px-6 gap-1">
          {tabs.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === key
                  ? "border-[var(--primary)] text-[var(--primary)]"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              {t("loading", { ns: "common" })}
            </div>
          ) : !customer ? (
            <div className="text-center py-12 text-slate-400">{t("customers.profile.notFound")}</div>
          ) : (
            <>
              {/* Overview Tab */}
              {activeTab === "overview" && (
                <div className="space-y-6">
                  {/* Stats Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatCard label={t("customers.profile.totalRentals")} value={stats?.totalRentals ?? 0} icon={FileText} color="text-blue-600" />
                    <StatCard label={t("customers.profile.totalRevenue")} value={formatCurrency(stats?.totalRevenue ?? 0)} icon={DollarSign} color="text-green-600" />
                    <StatCard label={t("customers.profile.avgOrder")} value={formatCurrency(stats?.avgOrderValue ?? 0)} icon={TrendingUp} color="text-amber-600" />
                    <StatCard label={t("customers.profile.activeRentals")} value={stats?.activeRentals ?? 0} icon={Activity} color="text-[var(--primary)]" />
                  </div>

                  {/* Top Category */}
                  {stats?.topCategory && (
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                      <BarChart3 size={14} />
                      {t("customers.profile.topCategory")}: <span className="font-medium text-slate-900">{stats.topCategory}</span>
                    </div>
                  )}

                  {/* Tags */}
                  <div>
                    <div className="text-sm font-medium text-slate-700 mb-2 flex items-center gap-1">
                      <Tag size={14} /> {t("customers.profile.tags")}
                    </div>
                    <div className="flex flex-wrap gap-2 items-center">
                      {customerTags.map((tag) => (
                        <span key={tag} className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 text-xs px-2 py-1 rounded-full">
                          {tag}
                          <button onClick={() => removeTag(tag)} className="text-slate-400 hover:text-[var(--primary)]">
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                      <div className="flex items-center gap-1">
                        <input
                          value={tagInput}
                          onChange={(e) => setTagInput(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && addTag()}
                          placeholder={t("customers.profile.addTag")}
                          className="bg-slate-50 border border-slate-200 rounded-full px-2 py-0.5 text-xs w-24"
                        />
                        <button onClick={addTag} className="text-slate-400 hover:text-[var(--primary)]">
                          <Plus size={14} />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Classification */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="cust-industry" className="block text-xs font-medium text-slate-500 mb-1">{t("customers.industryLabel")}</label>
                      <select
                        id="cust-industry"
                        value={customer.industry || ""}
                        onChange={(e) => handleIndustryChange(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900"
                      >
                        <option value="">{t("customers.classificationUnset")}</option>
                        {CUSTOMER_INDUSTRIES.map((v) => (
                          <option key={v} value={v}>{t(industryI18nKey(v))}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="cust-language" className="block text-xs font-medium text-slate-500 mb-1">{t("customers.langLabel")}</label>
                      <select
                        id="cust-language"
                        value={customer.preferredLanguage || ""}
                        onChange={(e) => handleLanguageChange(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900"
                      >
                        <option value="">{t("customers.classificationUnset")}</option>
                        {CUSTOMER_LANGUAGES.map((v) => (
                          <option key={v} value={v}>{t(languageI18nKey(v))}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* 副营 — a customer can straddle industries (a fifth of the
                      base does); the primary above drives reports, these drive
                      filtering and the fuller picture. */}
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">{t("customers.secondaryLabel")}</label>
                    <div className="flex flex-wrap gap-1.5">
                      {CUSTOMER_INDUSTRIES.filter((v) => v !== customer.industry).map((v) => {
                        const active = (customer.secondaryIndustries ?? []).includes(v);
                        return (
                          <button
                            key={v}
                            type="button"
                            onClick={() => toggleSecondary(v)}
                            className={`text-xs px-2 py-1 rounded-full border transition ${
                              active
                                ? "bg-[var(--primary)] text-white border-[var(--primary)]"
                                : "bg-white text-slate-500 border-slate-200 hover:border-slate-400"
                            }`}
                          >
                            {t(industryI18nKey(v))}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Contact Info */}
                  <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                    <div className="text-sm font-medium text-slate-700 mb-2">{t("customers.profile.contactInfo")}</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                      {customer.address && (
                        <div className="flex items-start gap-2 text-slate-600">
                          <MapPin size={14} className="mt-0.5 shrink-0" />
                          <span>{[customer.address, customer.city, customer.province, customer.postalCode].filter(Boolean).join(", ")}</span>
                        </div>
                      )}
                      {customer.notes && (
                        <div className="col-span-full text-xs text-slate-500 italic mt-1">
                          {customer.notes}
                        </div>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 mt-2">
                      {t("customers.profile.customerSince")}: {fmtDate(customer.createdAt)}
                      {customer.lastRentalDate && ` · ${t("customers.profile.lastRental")}: ${fmtDate(customer.lastRentalDate)}`}
                    </div>
                  </div>
                </div>
              )}

              {/* Rentals Tab */}
              {activeTab === "rentals" && (
                <div className="space-y-2">
                  {rentals.length === 0 ? (
                    <div className="text-center py-8 text-slate-400">{t("customers.profile.noRentals")}</div>
                  ) : (
                    rentals.map((r) => (
                      <div key={r.id} className="bg-slate-50 rounded-lg p-3 flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-900">#{r.id}</span>
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${rentalStatusColors[r.status] || ""}`}>
                              {r.status}
                            </span>
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            {r.fleetBrand && r.fleetModel ? `${r.fleetBrand} ${r.fleetModel}` : r.equipmentDescription || "-"}
                            {r.fleetCategory && ` · ${r.fleetCategory}`}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {fmtDate(r.startDate)} — {fmtDate(r.endDate)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-medium text-slate-900">
                            {r.totalAmount ? formatCurrency(Number(r.totalAmount)) : "-"}
                          </div>
                          <div className="text-xs text-slate-400">{fmtDate(r.createdAt)}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* Interactions Tab */}
              {activeTab === "interactions" && (
                <div className="space-y-4">
                  {/* Add new interaction */}
                  <div className="bg-slate-50 rounded-lg p-3 space-y-3">
                    <div className="text-sm font-medium text-slate-700">{t("customers.profile.addInteraction")}</div>
                    <div className="flex gap-2 flex-wrap">
                      {INTERACTION_TYPES.map((type) => (
                        <button
                          key={type}
                          onClick={() => setNewInteractionType(type)}
                          className={`px-2 py-1 rounded-full text-xs font-medium ${
                            newInteractionType === type
                              ? "bg-[var(--primary)] text-white"
                              : "bg-white text-slate-600 border border-slate-200"
                          }`}
                        >
                          {INTERACTION_ICONS[type]} {t(`customers.profile.interactionType.${type}`)}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={newInteractionText}
                        onChange={(e) => setNewInteractionText(e.target.value)}
                        placeholder={t("customers.profile.interactionPlaceholder")}
                        className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newInteractionText.trim()) {
                            addInteraction.mutate({ customerId, type: newInteractionType, summary: newInteractionText.trim() });
                          }
                        }}
                      />
                      <button
                        onClick={() => {
                          if (newInteractionText.trim()) {
                            addInteraction.mutate({ customerId, type: newInteractionType, summary: newInteractionText.trim() });
                          }
                        }}
                        disabled={!newInteractionText.trim() || addInteraction.isPending}
                        className="btn-primary px-3 py-2 flex items-center gap-1"
                      >
                        <Send size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Interaction timeline */}
                  <div className="space-y-2">
                    {(interactions || []).length === 0 ? (
                      <div className="text-center py-8 text-slate-400">{t("customers.profile.noInteractions")}</div>
                    ) : (
                      (interactions || []).map((i) => (
                        <div key={i.id} className="flex items-start gap-3 py-2 border-b border-slate-100 last:border-0">
                          <span className="text-lg mt-0.5">{INTERACTION_ICONS[i.type as InteractionType] || "📝"}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-slate-900">{i.summary}</div>
                            <div className="text-xs text-slate-400 mt-0.5">
                              {i.createdByName || t("customers.profile.system")} · {fmtDate(i.createdAt)}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Follow-up Tab */}
              {activeTab === "followup" && (
                <div className="space-y-6">
                  {/* Current follow-up status */}
                  <div className={`rounded-lg p-4 ${customer.nextFollowUp ? "bg-amber-50 border border-amber-200" : "bg-slate-50"}`}>
                    <div className="text-sm font-medium text-slate-700 mb-2">{t("customers.profile.currentFollowUp")}</div>
                    {customer.nextFollowUp ? (
                      <>
                        <div className="text-lg font-bold text-amber-700">{fmtDate(customer.nextFollowUp)}</div>
                        {customer.followUpNotes && <div className="text-sm text-amber-600 mt-1">{customer.followUpNotes}</div>}
                        <button
                          onClick={() => updateFollowUp.mutate({ id: customerId, nextFollowUp: null })}
                          className="text-xs text-slate-500 hover:text-[var(--primary)] mt-2"
                        >
                          {t("customers.profile.clearFollowUp")}
                        </button>
                      </>
                    ) : (
                      <div className="text-sm text-slate-400">{t("customers.profile.noFollowUp")}</div>
                    )}
                  </div>

                  {/* Set new follow-up */}
                  <div className="space-y-3">
                    <div className="text-sm font-medium text-slate-700">{t("customers.profile.setFollowUp")}</div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("customers.profile.followUpDate")}</label>
                      <input
                        type="date"
                        value={followUpDate}
                        onChange={(e) => setFollowUpDate(e.target.value)}
                        min={formatCalendarDateISO(new Date())}
                        className="bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-sm w-full sm:w-auto"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("customers.profile.followUpNotes")}</label>
                      <textarea
                        value={followUpNotes}
                        onChange={(e) => setFollowUpNotes(e.target.value)}
                        placeholder={t("customers.profile.followUpNotesPlaceholder")}
                        rows={2}
                        className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <button
                      onClick={() => {
                        if (!followUpDate) return toast.error(t("customers.profile.selectDate"));
                        updateFollowUp.mutate({
                          id: customerId,
                          nextFollowUp: followUpDate,
                          followUpNotes: followUpNotes || undefined,
                        });
                        setFollowUpDate("");
                        setFollowUpNotes("");
                      }}
                      disabled={!followUpDate || updateFollowUp.isPending}
                      className="btn-primary"
                    >
                      {t("customers.profile.saveFollowUp")}
                    </button>
                  </div>

                  {/* Last contact info */}
                  {customer.lastContactedAt && (
                    <div className="text-xs text-slate-400">
                      {t("customers.profile.lastContacted")}: {fmtDate(customer.lastContactedAt)}
                    </div>
                  )}
                </div>
              )}

              {/* Credit Tab */}
              {activeTab === "credit" && creditFlagEnabled && (
                <div className="space-y-6">
                  {/* Blacklist banner */}
                  {customer.isBlacklisted && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
                      <ShieldAlert size={18} className="text-red-500 shrink-0 mt-0.5" />
                      <div>
                        <div className="font-medium text-red-700 text-sm">{t("profile.blacklistedNotice")}</div>
                        {customer.blacklistReason && (
                          <div className="text-xs text-red-600 mt-1">{customer.blacklistReason}</div>
                        )}
                        {customer.blacklistedAt && (
                          <div className="text-xs text-red-400 mt-0.5">{t("profile.since", { date: fmtDate(customer.blacklistedAt) })}</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Outstanding balance */}
                  <div className="bg-slate-50 rounded-lg p-4 grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-slate-500">{t("profile.outstandingBalance")}</div>
                      <div className="text-lg font-bold text-slate-900">
                        {formatCurrency(Number(customer.totalRevenue ?? 0))}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">{t("profile.creditLimitLabel")}</div>
                      <div className="text-lg font-bold text-slate-900">
                        {customer.creditLimit !== null && customer.creditLimit !== undefined
                          ? formatCurrency(Number(customer.creditLimit))
                          : t("profile.unlimited")}
                      </div>
                    </div>
                    {customer.creditLimit !== null && customer.creditLimit !== undefined && (
                      <div className="col-span-2">
                        <div className="text-xs text-slate-500">{t("profile.availableCredit")}</div>
                        <div className={`text-base font-semibold ${Number(customer.creditLimit) - Number(customer.totalRevenue ?? 0) < 0 ? "text-red-600" : "text-green-600"}`}>
                          {formatCurrency(Math.max(0, Number(customer.creditLimit) - Number(customer.totalRevenue ?? 0)))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Super admin controls */}
                  {isSuperAdmin ? (
                    <>
                      {/* Blacklist toggle */}
                      <div className="space-y-3">
                        <div className="text-sm font-medium text-slate-700">{t("profile.blacklistStatus")}</div>
                        {customer.isBlacklisted ? (
                          <button
                            onClick={() => setBlacklist.mutate({ id: customerId, isBlacklisted: false })}
                            disabled={setBlacklist.isPending}
                            className="px-4 py-2 rounded-lg bg-green-100 text-green-700 text-sm font-medium hover:bg-green-200"
                          >
                            {t("profile.removeFromBlacklist")}
                          </button>
                        ) : (
                          <div className="space-y-2">
                            <textarea
                              value={blacklistReason}
                              onChange={(e) => setBlacklistReason(e.target.value)}
                              placeholder={t("profile.blacklistReasonPlaceholder")}
                              rows={2}
                              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                            />
                            <button
                              onClick={() => {
                                if (!blacklistReason.trim()) return toast.error(t("profile.blacklistReasonRequired"));
                                setBlacklist.mutate({ id: customerId, isBlacklisted: true, reason: blacklistReason.trim() });
                              }}
                              disabled={setBlacklist.isPending}
                              className="px-4 py-2 rounded-lg bg-red-100 text-red-700 text-sm font-medium hover:bg-red-200"
                            >
                              {t("profile.addToBlacklist")}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Credit limit */}
                      <div className="space-y-3">
                        <div className="text-sm font-medium text-slate-700">{t("profile.setCreditLimit")}</div>
                        <div className="flex gap-2 items-center">
                          <input
                            type="number"
                            min="0"
                            step="100"
                            value={creditLimitInput}
                            onChange={(e) => setCreditLimitInput(e.target.value)}
                            placeholder={t("profile.creditLimitPlaceholder")}
                            className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                          />
                          <button
                            onClick={() => {
                              const limit = creditLimitInput.trim() === "" ? null : Number(creditLimitInput);
                              if (limit !== null && isNaN(limit)) return toast.error(t("profile.invalidAmount"));
                              setCreditLimit.mutate({ id: customerId, limit });
                            }}
                            disabled={setCreditLimit.isPending}
                            className="btn-primary px-4 py-2 text-sm"
                          >
                            {t("save", { ns: "common" })}
                          </button>
                        </div>
                        <div className="text-xs text-slate-400">{t("profile.creditLimitHint")}</div>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-slate-400 italic">{t("profile.superAdminOnly")}</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
