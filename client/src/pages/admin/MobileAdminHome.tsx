import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Check,
  X,
  Truck,
  ClipboardCheck,
  Package,
  ArrowRight,
  FileText,
  DollarSign,
  Users,
  UserCheck,
  UserPlus,
  CalendarClock,
  AlertCircle,
  PackageCheck,
  CalendarPlus,
  CalendarMinus,
  Activity,
} from "lucide-react";
import { useFormatCalendarDate } from "@/lib/dateUtils";
import { useBranding } from "@/config/branding";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { formatCurrency } from "@/lib/pricing";
import { serverErrorText } from "@/lib/serverError";

/**
 * Mobile admin home — fully aligned with the desktop Dashboard so phone users
 * get the same KPIs, today panel, follow-up reminders, and recent activity feed.
 * Two pieces stay mobile-only: the pending-approvals action queue (approve/reject
 * in one tap) and the bottom quick links to data-entry pages that remain
 * desktop-optimized.
 */
export default function MobileAdminHome() {
  const { t } = useTranslation(["dashboard", "rental", "dispatch", "common"]);
  const branding = useBranding();
  const fmtDate = useFormatCalendarDate();
  const utils = trpc.useUtils();

  const { data: pendingRentals } = trpc.rentals.list.useQuery({ status: "pending" });
  const { data: todayData } = trpc.dashboard.todaySchedule.useQuery();
  const { data: stats } = trpc.dashboard.stats.useQuery();
  const showTodayPanel = useFeatureFlag("today_dashboard");
  const dispatchWorkflowEnabled = useFeatureFlag("dispatch_workflow");
  const rollingOperationsEnabled = useFeatureFlag("rolling_renewal_operations");

  const updateStatus = trpc.rentals.updateStatus.useMutation({
    onSuccess: (result) => {
      utils.rentals.list.invalidate();
      utils.dashboard.stats.invalidate();
      if (result.failures.length > 0) {
        toast.warning(t("rental:management.statusUpdatedWithGaps", {
          kinds: Array.from(new Set(result.failures.map((failure) => failure.kind))).join(", "),
        }));
      } else {
        toast.success(t("mobileAdmin.actionSuccess"));
      }
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const handleApprove = (id: number) => {
    if (!confirm(t("mobileAdmin.confirmApprove"))) return;
    updateStatus.mutate({ id, status: "approved" });
  };
  const handleReject = (id: number) => {
    if (!confirm(t("mobileAdmin.confirmReject"))) return;
    updateStatus.mutate({ id, status: "rejected" });
  };

  const pendingList = (pendingRentals || []).slice(0, 5);

  const financials = stats?.financials;
  const financialCards = [
    { label: "finance.orderRent" as const, value: financials?.orderRent ?? 0 },
    { label: "finance.cumulativeReceivable" as const, value: financials?.cumulativeReceivable ?? 0 },
    { label: "finance.outstandingBalance" as const, value: financials?.outstandingBalance ?? 0 },
    { label: "finance.cashReceived" as const, value: financials?.cashReceived ?? 0 },
  ];
  const fleetCount = stats?.fleet.total || 0;
  const availableCount = stats?.fleet.available || 0;
  const ongoingCount = stats?.rentals.ongoing || 0;
  const rollingConfirmedCount = stats?.rentals.rolling ?? 0;
  const rollingReviewCount = stats?.rentals.renewalReview ?? 0;
  const crm = stats?.crm;
  const operationalBreakdown = [
    { key: "normal", label: t("rentalOperations.normal"), value: stats?.rentals.normal ?? 0, color: "text-slate-700", dot: "bg-slate-400" },
    { key: "rolling", label: t("rentalOperations.rolling"), detail: t("rentalOperations.rollingBreakdown", { confirmed: rollingConfirmedCount, review: rollingReviewCount }), value: rollingConfirmedCount + rollingReviewCount, color: "text-blue-700", dot: "bg-blue-500" },
    { key: "awaitingPickup", label: t("rentalOperations.awaitingPickup"), value: stats?.rentals.awaitingPickup ?? 0, color: "text-amber-700", dot: "bg-amber-500" },
    { key: "awaitingInspection", label: t("rentalOperations.awaitingInspection"), value: stats?.rentals.awaitingInspection ?? 0, color: "text-teal-700", dot: "bg-teal-500" },
    { key: "customerOverdue", label: t("rentalOperations.customerOverdue"), value: stats?.rentals.customerOverdue ?? 0, color: "text-red-700", dot: "bg-red-500" },
  ];

  const recentRentals = (stats?.recentRentals || []).map((r) => ({
    type: "rental" as const,
    id: r.id,
    text: `${t("rentalNumber")}${r.rentalNumber || r.id} — ${r.customerName}`,
    status: r.status,
    date: r.createdAt,
  }));
  const recentDispatches = (dispatchWorkflowEnabled ? stats?.recentDispatches || [] : []).map((d) => ({
    type: "dispatch" as const,
    id: d.id,
    text: `${t(d.orderType, { ns: "dispatch" })} #${d.id}`,
    status: d.status,
    date: d.createdAt,
  }));
  const recentActivity = [...recentRentals, ...recentDispatches]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 6);

  type TodayItem = {
    id: number;
    rentalNumber: string | null;
    customerName: string;
    scheduledDeliveryTime?: string | null;
  };
  type TodayBucket = {
    key: "deliveries" | "returns" | "starting" | "ending";
    icon: typeof Truck;
    color: string;
    iconColor: string;
    label: string;
    items: TodayItem[];
    href: string;
  };
  const todayBuckets: TodayBucket[] = [
    {
      key: "deliveries",
      icon: Truck,
      color: "text-blue-600",
      iconColor: "text-blue-500",
      label: t("today.deliveriesDue", { defaultValue: "Deliveries Due" }),
      items: todayData?.deliveriesDue ?? [],
      href: "/admin/rental-management",
    },
    {
      key: "returns",
      icon: PackageCheck,
      color: "text-emerald-600",
      iconColor: "text-emerald-500",
      label: t("today.returnsDue", { defaultValue: "Returns Due" }),
      items: todayData?.returnsDue ?? [],
      href: "/admin/rental-management",
    },
    {
      key: "starting",
      icon: CalendarPlus,
      color: "text-violet-600",
      iconColor: "text-violet-500",
      label: t("today.startingToday", { defaultValue: "Starting Today" }),
      items: todayData?.startingToday ?? [],
      href: "/admin/rental-management",
    },
    {
      key: "ending",
      icon: CalendarMinus,
      color: "text-amber-600",
      iconColor: "text-amber-500",
      label: t("today.endingToday", { defaultValue: "Ending Today" }),
      items: todayData?.endingToday ?? [],
      href: "/admin/rental-management",
    },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-5 pb-6">
        {/* Page title */}
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[var(--on-surface)] font-headline">
            {branding.companyName} {t("title")}
          </h1>
        </div>

        {/* Explicit financial meanings */}
        <Link href="/admin/reports" className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 relative overflow-hidden block hover:shadow-md transition-shadow cursor-pointer min-h-[44px]">
          <div className="relative z-10 grid grid-cols-2 gap-3">
            {financialCards.map(({ label, value }) => (
              <div key={label} className="min-w-0">
                <p className="text-[9px] font-bold text-slate-500 uppercase tracking-wide truncate">{t(label)}</p>
                <p className="mt-0.5 text-lg font-extrabold text-[var(--on-surface)] tabular-nums truncate">{formatCurrency(Number(value))}</p>
              </div>
            ))}
            {(financials?.heldCash ?? 0) !== 0 && (
              <p className="col-span-2 text-[10px] text-amber-700">{t("finance.heldCash", { amount: formatCurrency(financials?.heldCash ?? 0) })}</p>
            )}
          </div>
          <div className="absolute -right-4 -bottom-4 opacity-[0.05] text-[var(--primary)]">
            <DollarSign size={120} strokeWidth={1} />
          </div>
        </Link>

        {/* Primary KPI strip */}
        <div className="grid grid-cols-2 gap-3">
          <Link href="/admin/rental-management?tab=pending" className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3 min-h-[44px] hover:border-[var(--primary)]/40 transition-colors cursor-pointer">
            <div className="text-xs text-slate-500 mb-1">{t("mobileAdmin.kpiPending")}</div>
            <div className="text-2xl font-bold text-[var(--primary)]">{stats?.rentals.pending ?? "-"}</div>
          </Link>
          <Link href="/admin/rental-management?tab=active" className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3 min-h-[44px] hover:border-[var(--primary)]/40 transition-colors cursor-pointer">
            <div className="text-xs text-slate-500 mb-1">{t("mobileAdmin.kpiActive")}</div>
            <div className="text-2xl font-bold text-green-600">{stats ? ongoingCount : "-"}</div>
          </Link>
          <Link href="/admin/rental-fleet?status=available" className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3 min-h-[44px] hover:border-[var(--primary)]/40 transition-colors cursor-pointer">
            <div className="text-xs text-slate-500 mb-1">{t("mobileAdmin.kpiAvailable")}</div>
            <div className="text-2xl font-bold text-slate-900">{availableCount}/{fleetCount}</div>
          </Link>
          <Link href="/admin/inspections" className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3 min-h-[44px] hover:border-[var(--primary)]/40 transition-colors cursor-pointer">
            <div className="text-xs text-slate-500 mb-1">{t("mobileAdmin.kpiInspect")}</div>
            <div className="text-2xl font-bold text-slate-900">{stats?.inspections ?? "-"}</div>
          </Link>
        </div>

        {rollingOperationsEnabled && (
          <Link href="/admin/rental-management?rolling=all" className="block rounded-xl border border-slate-200 bg-[var(--surface-container-lowest)] overflow-hidden shadow-sm">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-100">
              <div>
                <h2 className="text-xs font-bold text-slate-800">{t("rentalOperations.title")}</h2>
                <p className="text-[10px] text-slate-500">{t("rentalOperations.hint")}</p>
              </div>
              <span className="text-xl font-extrabold tabular-nums text-slate-900">{ongoingCount}</span>
            </div>
            <div className="grid grid-cols-2">
              {operationalBreakdown.map((item, index) => (
                <div key={item.key} className={`flex items-center gap-2 px-3 py-2 ${index % 2 === 0 ? "border-r" : ""} border-b border-slate-100`}>
                  <span className={`h-2 w-2 rounded-full ${item.dot}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] text-slate-600">{item.label}</span>
                    {item.detail && <span className="block truncate text-[8px] font-semibold text-blue-600">{item.detail}</span>}
                  </span>
                  <span className={`text-sm font-extrabold tabular-nums ${item.color}`}>{item.value}</span>
                </div>
              ))}
            </div>
          </Link>
        )}

        {(stats?.fleet.statusMismatch ?? 0) > 0 && (
          <Link href="/admin/rental-fleet" className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800">
            <AlertCircle size={13} />
            <span>{t("rentalOperations.fleetMismatch", { count: stats?.fleet.statusMismatch ?? 0 })}</span>
          </Link>
        )}

        {/* Secondary KPI strip — dispatch + CRM */}
        <div className="grid grid-cols-3 gap-2">
          {[
            ...(dispatchWorkflowEnabled ? [{ icon: Truck, label: t("dispatchOrders"), value: stats?.dispatches ?? 0, color: "text-orange-500", bg: "bg-orange-50", href: "/admin/dispatch" }] : []),
            { icon: Users, label: t("crm.totalCustomers"), value: crm?.totalCustomers ?? 0, color: "text-purple-500", bg: "bg-purple-50", href: "/admin/customers" },
            // Returning/new-this-month need filter support on Customers — leave dormant.
            { icon: UserCheck, label: t("crm.returningRate"), value: `${crm?.returningRate ?? 0}%`, color: "text-emerald-500", bg: "bg-emerald-50", href: null },
            { icon: UserPlus, label: t("crm.newThisMonth"), value: crm?.newThisMonth ?? 0, color: "text-sky-500", bg: "bg-sky-50", href: null },
            { icon: Package, label: t("fleetAssets"), value: fleetCount, color: "text-indigo-500", bg: "bg-indigo-50", href: "/admin/rental-fleet" },
            {
              icon: CalendarClock,
              label: t("crm.overdueFollowUps"),
              value: crm?.overdueFollowUps?.length ?? 0,
              color: (crm?.overdueFollowUps?.length ?? 0) > 0 ? "text-amber-600" : "text-slate-500",
              bg: "bg-amber-50",
              href: (crm?.overdueFollowUps?.length ?? 0) > 0 ? "/admin/customers" : null,
            },
          ].map((stat) => {
            const Icon = stat.icon;
            const inner = (
              <>
                <div className={`inline-flex p-1.5 rounded-lg ${stat.bg} ${stat.color} mb-1`}>
                  <Icon size={12} />
                </div>
                <div className="text-base font-bold text-[var(--on-surface)] leading-tight">{stat.value}</div>
                <div className="text-[9px] text-[var(--muted-foreground)] uppercase tracking-wider font-medium leading-tight mt-0.5">
                  {stat.label}
                </div>
              </>
            );
            const baseCls = "bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-2 text-center min-h-[44px]";
            return stat.href ? (
              <Link key={stat.label} href={stat.href} className={`${baseCls} block hover:shadow-md transition-shadow cursor-pointer`}>{inner}</Link>
            ) : (
              <div key={stat.label} className={baseCls}>{inner}</div>
            );
          })}
        </div>

        {/* Pending approvals queue — mobile-only quick action */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">{t("mobileAdmin.pendingApprovals")}</h2>
            {pendingList.length > 0 && (
              <Link href="/admin/rental-management" className="text-xs text-[var(--primary)] inline-flex items-center gap-1">
                {t("mobileAdmin.seeAll")} <ArrowRight size={12} />
              </Link>
            )}
          </div>
          {pendingList.length === 0 ? (
            <div className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-5 text-center text-sm text-slate-500">
              {t("mobileAdmin.noPending")}
            </div>
          ) : (
            <div className="space-y-2">
              {pendingList.map((r) => {
                const rr = r.rental_requests;
                return (
                  <div key={rr.id} className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3">
                    <Link href="/admin/rental-management?tab=pending" className="flex items-start justify-between gap-2 mb-2 -m-1 p-1 rounded hover:bg-slate-50 transition-colors cursor-pointer">
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 truncate">{rr.customerName}</div>
                        <div className="text-xs text-slate-500 truncate">
                          {rr.rentalNumber || `#${rr.id}`} · {rr.equipmentDescription || "-"}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-bold text-slate-900">${rr.totalAmount || "0"}</div>
                        <div className="text-[10px] text-slate-400">
                          {fmtDate(rr.startDate)}
                        </div>
                      </div>
                    </Link>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleApprove(rr.id)}
                        disabled={updateStatus.isPending}
                        className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 disabled:bg-slate-300 rounded-lg min-h-[44px]"
                      >
                        <Check size={16} /> {t("mobileAdmin.approve")}
                      </button>
                      <button
                        onClick={() => handleReject(rr.id)}
                        disabled={updateStatus.isPending}
                        className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg min-h-[44px]"
                      >
                        <X size={16} /> {t("mobileAdmin.reject")}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Today panel — gated by feature flag to match desktop */}
        {showTodayPanel && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-700">{t("today.title", { defaultValue: "Today's Schedule" })}</h2>
            <div className="space-y-2">
              {todayBuckets.map((bucket) => {
                const Icon = bucket.icon;
                const count = bucket.items.length;
                return (
                  <div key={bucket.key} className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden">
                    <Link href={`${bucket.href}?today=${bucket.key}`} className="px-3 py-2.5 flex items-center gap-2 border-b border-[var(--outline-variant)]/10">
                      <Icon size={14} className={`${bucket.iconColor} shrink-0`} />
                      <span className="text-xs font-bold text-[var(--on-surface)]">{bucket.label}</span>
                      <span className={`ml-auto text-lg font-extrabold ${bucket.color}`}>{count}</span>
                    </Link>
                    {count === 0 ? (
                      <div className="px-3 py-3 text-[11px] text-[var(--muted-foreground)] text-center">
                        {t("today.none", { defaultValue: "None scheduled" })}
                      </div>
                    ) : (
                      <>
                        <ul className="divide-y divide-[var(--outline-variant)]/5">
                          {bucket.items.slice(0, 3).map((r) => (
                            <li key={r.id} className="px-3 py-2 text-[11px] text-[var(--on-surface)]">
                              <Link href={`${bucket.href}?today=${bucket.key}`} className="block">
                                <span className="font-medium">{r.rentalNumber ?? `#${r.id}`}</span>
                                <span className="text-[var(--muted-foreground)] ml-1">— {r.customerName}</span>
                                {bucket.key === "deliveries" && r.scheduledDeliveryTime && (
                                  <span className="text-[var(--muted-foreground)] ml-1">@ {r.scheduledDeliveryTime}</span>
                                )}
                              </Link>
                            </li>
                          ))}
                        </ul>
                        {count > 3 && (
                          <Link
                            href={`${bucket.href}?today=${bucket.key}`}
                            className="block text-center text-[11px] font-medium text-[var(--primary)] py-2 border-t border-[var(--outline-variant)]/10"
                          >
                            {t("today.viewAll", { defaultValue: "View all" })} ({count})
                          </Link>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Follow-up reminders (CRM) */}
        {crm?.overdueFollowUps && crm.overdueFollowUps.length > 0 && (
          <section className="bg-amber-50 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-amber-200/50 flex items-center gap-2">
              <CalendarClock size={14} className="text-amber-600 shrink-0" />
              <h2 className="text-xs font-bold text-amber-800">{t("crm.followUpReminders")}</h2>
              <span className="ml-auto text-xs font-bold text-amber-700">{crm.overdueFollowUps.length}</span>
            </div>
            <div className="divide-y divide-amber-100">
              {crm.overdueFollowUps.slice(0, 5).map((c) => (
                <Link key={c.id} href={`/admin/customers/${c.id}`} className="px-4 py-2.5 block hover:bg-amber-100/40 transition-colors cursor-pointer min-h-[44px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-[var(--on-surface)] truncate">{c.name}</span>
                    <span className="text-[10px] text-amber-600 font-medium shrink-0">{fmtDate(c.nextFollowUp)}</span>
                  </div>
                  {c.followUpNotes && (
                    <div className="text-[11px] text-[var(--muted-foreground)] truncate mt-0.5">{c.followUpNotes}</div>
                  )}
                </Link>
              ))}
              {crm.overdueFollowUps.length > 5 && (
                <Link
                  href="/admin/customers"
                  className="block text-center text-[11px] font-medium text-amber-700 py-2"
                >
                  {t("today.viewAll", { defaultValue: "View all" })} ({crm.overdueFollowUps.length})
                </Link>
              )}
            </div>
          </section>
        )}

        {/* Recent activity */}
        <section className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--outline-variant)]/10 flex items-center justify-between">
            <h2 className="text-sm font-bold text-[var(--on-surface)]">{t("recentActivity")}</h2>
            <div className="flex items-center gap-1 text-[var(--muted-foreground)] text-[11px]">
              <Activity size={12} />
              <span>{recentActivity.length}</span>
            </div>
          </div>
          <div className="divide-y divide-[var(--outline-variant)]/5">
            {recentActivity.length > 0 ? (
              recentActivity.map((item, i) => (
                <Link
                  key={`${item.type}-${item.id}-${i}`}
                  href={item.type === "rental" ? "/admin/rental-management" : "/admin/dispatch"}
                  className="px-4 py-2.5 block hover:bg-[var(--surface-container-low)]/30 transition-colors cursor-pointer min-h-[44px]"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${item.type === "rental" ? "bg-[var(--primary)]" : "bg-blue-500"}`} />
                    <span className="text-xs text-[var(--on-surface)] truncate flex-1">{item.text}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 ml-3.5">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-bold uppercase">
                      {t(`status.${item.status}`, { ns: "common" })}
                    </span>
                    <span className="text-[10px] text-slate-400">{fmtDate(item.date)}</span>
                  </div>
                </Link>
              ))
            ) : (
              <div className="px-4 py-6 text-center text-[11px] text-slate-400">{t("noRecentActivity")}</div>
            )}
          </div>
        </section>

        {/* Quick links */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-700">{t("mobileAdmin.quickLinks")}</h2>
          <div className="grid grid-cols-2 gap-2">
            <Link href="/admin/rental-management" className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3 text-sm text-slate-700 hover:border-[var(--primary)]/40 inline-flex items-center gap-2 min-h-[44px]">
              <Package size={16} /> {t("mobileAdmin.linkRentals")}
            </Link>
            {dispatchWorkflowEnabled && (
              <Link href="/admin/dispatch" className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3 text-sm text-slate-700 hover:border-[var(--primary)]/40 inline-flex items-center gap-2 min-h-[44px]">
                <Truck size={16} /> {t("mobileAdmin.linkDispatch")}
              </Link>
            )}
            <Link href="/admin/inspections" className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3 text-sm text-slate-700 hover:border-[var(--primary)]/40 inline-flex items-center gap-2 min-h-[44px]">
              <ClipboardCheck size={16} /> {t("mobileAdmin.linkInspections")}
            </Link>
            <Link href="/admin/customers" className="bg-[var(--surface-container-lowest)] rounded-xl border border-slate-200 p-3 text-sm text-slate-700 hover:border-[var(--primary)]/40 inline-flex items-center gap-2 min-h-[44px]">
              <FileText size={16} /> {t("mobileAdmin.linkCustomers")}
            </Link>
          </div>
        </section>

        <p className="text-center text-xs text-slate-400 pt-2">
          {t("mobileAdmin.desktopHint")}
        </p>
      </div>
    </DashboardLayout>
  );
}
