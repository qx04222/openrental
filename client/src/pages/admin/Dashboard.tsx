import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { useTranslation } from "react-i18next";
import { useBranding } from "@/config/branding";
import { Package, FileText, DollarSign, AlertCircle, Users, UserCheck, UserPlus, CalendarClock, TrendingUp, Activity, Truck, ClipboardCheck, PackageCheck, CalendarPlus, CalendarMinus, ArrowRight } from "lucide-react";
import { formatCurrency } from "@/lib/pricing";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Link } from "wouter";
import MobileAdminHome from "./MobileAdminHome";
import { useFormatCalendarDate } from "@/lib/dateUtils";

export default function Dashboard() {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileAdminHome />;
  return <DashboardDesktop />;
}

function DashboardDesktop() {
  const { t } = useTranslation(["dashboard", "dispatch", "common"]);
  const branding = useBranding();
  const { data } = trpc.dashboard.stats.useQuery();
  const { data: todayData } = trpc.dashboard.todaySchedule.useQuery();
  const showTodayPanel = useFeatureFlag("today_dashboard");
  const dispatchWorkflowEnabled = useFeatureFlag("dispatch_workflow");
  const rollingOperationsEnabled = useFeatureFlag("rolling_renewal_operations");

  const fleetCount = data?.fleet.total || 0;
  const availableCount = data?.fleet.available || 0;
  const missingCostCount = data?.fleet.missingCost || 0;
  const fleetStatusMismatch = data?.fleet.statusMismatch || 0;
  const rentalCount = data?.rentals.total || 0;
  const pendingCount = data?.rentals.pending || 0;
  const ongoingCount = data?.rentals.ongoing || 0;
  const rollingConfirmedCount = data?.rentals.rolling ?? 0;
  const rollingReviewCount = data?.rentals.renewalReview ?? 0;
  const inspectionCount = data?.inspections || 0;
  const dispatchCount = data?.dispatches || 0;
  const financials = data?.financials;
  const financialCards = [
    { label: "finance.orderRent" as const, value: financials?.orderRent ?? 0 },
    { label: "finance.cumulativeReceivable" as const, value: financials?.cumulativeReceivable ?? 0 },
    { label: "finance.outstandingBalance" as const, value: financials?.outstandingBalance ?? 0 },
    { label: "finance.cashReceived" as const, value: financials?.cashReceived ?? 0 },
  ];
  const crm = data?.crm;

  // Recent activity (merge and sort)
  const recentRentals = (data?.recentRentals || []).map((r) => ({
    type: "rental" as const,
    id: r.id,
    text: `${t("rentalNumber")}${r.rentalNumber || r.id} - ${r.customerName}`,
    status: r.status,
    date: r.createdAt,
  }));

  const recentDispatches = (dispatchWorkflowEnabled ? data?.recentDispatches || [] : []).map((d) => ({
    type: "dispatch" as const,
    id: d.id,
    text: `${t(d.orderType, { ns: "dispatch" })} #${d.id}`,
    status: d.status,
    date: d.createdAt,
  }));

  const recentActivity = [...recentRentals, ...recentDispatches]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 10);

  const fmtDate = useFormatCalendarDate();

  const { t: tFleet } = useTranslation(["fleet"]);
  const operationalBreakdown = [
    { key: "normal", label: t("rentalOperations.normal"), icon: Activity, value: data?.rentals.normal ?? 0, tone: "text-slate-700", rail: "bg-slate-400", href: "/admin/rental-management?tab=active" },
    { key: "rolling", label: t("rentalOperations.rolling"), detail: t("rentalOperations.rollingBreakdown", { confirmed: rollingConfirmedCount, review: rollingReviewCount }), icon: CalendarClock, value: rollingConfirmedCount + rollingReviewCount, tone: "text-blue-700", rail: "bg-blue-500", href: "/admin/rental-management?rolling=all" },
    { key: "awaitingPickup", label: t("rentalOperations.awaitingPickup"), icon: Truck, value: data?.rentals.awaitingPickup ?? 0, tone: "text-amber-700", rail: "bg-amber-500", href: "/admin/rental-management?tab=active" },
    { key: "awaitingInspection", label: t("rentalOperations.awaitingInspection"), icon: ClipboardCheck, value: data?.rentals.awaitingInspection ?? 0, tone: "text-teal-700", rail: "bg-teal-500", href: "/admin/rental-management?tab=active" },
    { key: "customerOverdue", label: t("rentalOperations.customerOverdue"), icon: AlertCircle, value: data?.rentals.customerOverdue ?? 0, tone: "text-red-700", rail: "bg-red-500", href: "/admin/rental-management?tab=active" },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-8">
        {/* Page Header */}
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-[var(--on-surface)] font-headline">{branding.companyName} {t("title")}</h1>
          <p className="text-[var(--muted-foreground)] mt-1 max-w-lg">{t("dashboard.tagline", { ns: "common", defaultValue: branding.tagline })}</p>
        </div>

        {/* Missing purchase-cost banner — unlocks ROI tracking once filled */}
        {missingCostCount > 0 && (
          <Link
            href="/admin/rental-fleet?filter=no-cost"
            className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 hover:bg-amber-100/70 transition-colors cursor-pointer"
          >
            <AlertCircle size={18} className="text-amber-600 flex-shrink-0" />
            <span className="text-sm text-amber-900 flex-1">
              {tFleet("missingCostBannerFmt", { count: missingCostCount })}
            </span>
            <span className="inline-flex items-center gap-1 text-sm font-bold text-amber-700">
              {tFleet("missingCostBannerCta")} <ArrowRight size={14} />
            </span>
          </Link>
        )}

        {/* Today Panel */}
        {showTodayPanel && (
          <div className="space-y-3">
            <h2 className="text-lg font-bold text-[var(--on-surface)]">{t("today.title", { defaultValue: "Today's Schedule" })}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Deliveries Due Today */}
              <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden flex flex-col">
                <Link href="/admin/rental-management?today=deliveries" className="px-4 py-3 flex items-center gap-2 border-b border-[var(--outline-variant)]/10 hover:bg-[var(--surface-container-low)]/40 transition-colors">
                  <Truck size={16} className="text-blue-500 shrink-0" />
                  <span className="text-sm font-bold text-[var(--on-surface)]">{t("today.deliveriesDue", { defaultValue: "Deliveries Due" })}</span>
                  <span className="ml-auto text-xl font-extrabold text-blue-600">{todayData?.deliveriesDue.length ?? 0}</span>
                </Link>
                <ul className="divide-y divide-[var(--outline-variant)]/5 flex-1">
                  {(todayData?.deliveriesDue ?? []).slice(0, 5).map((r) => (
                    <li key={r.id} className="px-4 py-2 text-xs text-[var(--on-surface)] hover:bg-[var(--surface-container-low)]/30 transition-colors">
                      <Link href={`/admin/rental-management?today=deliveries`} className="block">
                        <span className="font-medium">{r.rentalNumber ?? `#${r.id}`}</span>
                        <span className="text-[var(--muted-foreground)] ml-1">— {r.customerName}</span>
                        {r.scheduledDeliveryTime && (
                          <span className="text-[var(--muted-foreground)] ml-1">@ {r.scheduledDeliveryTime}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                  {(todayData?.deliveriesDue.length ?? 0) === 0 && (
                    <li className="px-4 py-4 text-xs text-[var(--muted-foreground)] text-center">{t("today.none", { defaultValue: "None scheduled" })}</li>
                  )}
                </ul>
                {(todayData?.deliveriesDue.length ?? 0) > 5 && (
                  <Link href="/admin/rental-management?today=deliveries" className="block text-center text-xs font-medium text-[var(--primary)] py-2 border-t border-[var(--outline-variant)]/10 hover:underline">
                    {t("today.viewAll", { defaultValue: "View all" })} ({todayData?.deliveriesDue.length})
                  </Link>
                )}
              </div>

              {/* Returns Due Today */}
              <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden flex flex-col">
                <Link href="/admin/rental-management?today=returns" className="px-4 py-3 flex items-center gap-2 border-b border-[var(--outline-variant)]/10 hover:bg-[var(--surface-container-low)]/40 transition-colors">
                  <PackageCheck size={16} className="text-emerald-500 shrink-0" />
                  <span className="text-sm font-bold text-[var(--on-surface)]">{t("today.returnsDue", { defaultValue: "Returns Due" })}</span>
                  <span className="ml-auto text-xl font-extrabold text-emerald-600">{todayData?.returnsDue.length ?? 0}</span>
                </Link>
                <ul className="divide-y divide-[var(--outline-variant)]/5 flex-1">
                  {(todayData?.returnsDue ?? []).slice(0, 5).map((r) => (
                    <li key={r.id} className="px-4 py-2 text-xs text-[var(--on-surface)] hover:bg-[var(--surface-container-low)]/30 transition-colors">
                      <Link href="/admin/rental-management?today=returns" className="block">
                        <span className="font-medium">{r.rentalNumber ?? `#${r.id}`}</span>
                        <span className="text-[var(--muted-foreground)] ml-1">— {r.customerName}</span>
                        {r.fleetBrand && r.fleetModel && (
                          <span className="text-[var(--muted-foreground)] ml-1">({r.fleetBrand} {r.fleetModel})</span>
                        )}
                      </Link>
                    </li>
                  ))}
                  {(todayData?.returnsDue.length ?? 0) === 0 && (
                    <li className="px-4 py-4 text-xs text-[var(--muted-foreground)] text-center">{t("today.none", { defaultValue: "None scheduled" })}</li>
                  )}
                </ul>
                {(todayData?.returnsDue.length ?? 0) > 5 && (
                  <Link href="/admin/rental-management?today=returns" className="block text-center text-xs font-medium text-[var(--primary)] py-2 border-t border-[var(--outline-variant)]/10 hover:underline">
                    {t("today.viewAll", { defaultValue: "View all" })} ({todayData?.returnsDue.length})
                  </Link>
                )}
              </div>

              {/* Starting Today */}
              <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden flex flex-col">
                <Link href="/admin/rental-management?today=starting" className="px-4 py-3 flex items-center gap-2 border-b border-[var(--outline-variant)]/10 hover:bg-[var(--surface-container-low)]/40 transition-colors">
                  <CalendarPlus size={16} className="text-violet-500 shrink-0" />
                  <span className="text-sm font-bold text-[var(--on-surface)]">{t("today.startingToday", { defaultValue: "Starting Today" })}</span>
                  <span className="ml-auto text-xl font-extrabold text-violet-600">{todayData?.startingToday.length ?? 0}</span>
                </Link>
                <ul className="divide-y divide-[var(--outline-variant)]/5 flex-1">
                  {(todayData?.startingToday ?? []).slice(0, 5).map((r) => (
                    <li key={r.id} className="px-4 py-2 text-xs text-[var(--on-surface)] hover:bg-[var(--surface-container-low)]/30 transition-colors">
                      <Link href="/admin/rental-management?today=starting" className="block">
                        <span className="font-medium">{r.rentalNumber ?? `#${r.id}`}</span>
                        <span className="text-[var(--muted-foreground)] ml-1">— {r.customerName}</span>
                      </Link>
                    </li>
                  ))}
                  {(todayData?.startingToday.length ?? 0) === 0 && (
                    <li className="px-4 py-4 text-xs text-[var(--muted-foreground)] text-center">{t("today.none", { defaultValue: "None scheduled" })}</li>
                  )}
                </ul>
                {(todayData?.startingToday.length ?? 0) > 5 && (
                  <Link href="/admin/rental-management?today=starting" className="block text-center text-xs font-medium text-[var(--primary)] py-2 border-t border-[var(--outline-variant)]/10 hover:underline">
                    {t("today.viewAll", { defaultValue: "View all" })} ({todayData?.startingToday.length})
                  </Link>
                )}
              </div>

              {/* Ending Today */}
              <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden flex flex-col">
                <Link href="/admin/rental-management?today=ending" className="px-4 py-3 flex items-center gap-2 border-b border-[var(--outline-variant)]/10 hover:bg-[var(--surface-container-low)]/40 transition-colors">
                  <CalendarMinus size={16} className="text-amber-500 shrink-0" />
                  <span className="text-sm font-bold text-[var(--on-surface)]">{t("today.endingToday", { defaultValue: "Ending Today" })}</span>
                  <span className="ml-auto text-xl font-extrabold text-amber-600">{todayData?.endingToday.length ?? 0}</span>
                </Link>
                <ul className="divide-y divide-[var(--outline-variant)]/5 flex-1">
                  {(todayData?.endingToday ?? []).slice(0, 5).map((r) => (
                    <li key={r.id} className="px-4 py-2 text-xs text-[var(--on-surface)] hover:bg-[var(--surface-container-low)]/30 transition-colors">
                      <Link href="/admin/rental-management?today=ending" className="block">
                        <span className="font-medium">{r.rentalNumber ?? `#${r.id}`}</span>
                        <span className="text-[var(--muted-foreground)] ml-1">— {r.customerName}</span>
                      </Link>
                    </li>
                  ))}
                  {(todayData?.endingToday.length ?? 0) === 0 && (
                    <li className="px-4 py-4 text-xs text-[var(--muted-foreground)] text-center">{t("today.none", { defaultValue: "None scheduled" })}</li>
                  )}
                </ul>
                {(todayData?.endingToday.length ?? 0) > 5 && (
                  <Link href="/admin/rental-management?today=ending" className="block text-center text-xs font-medium text-[var(--primary)] py-2 border-t border-[var(--outline-variant)]/10 hover:underline">
                    {t("today.viewAll", { defaultValue: "View all" })} ({todayData?.endingToday.length})
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Bento Stat Grid */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {/* Explicit financial meanings — never collapse rent, invoices and cash into one number. */}
          <Link href="/admin/reports" className="col-span-1 md:col-span-2 bg-[var(--surface-container-lowest)] p-6 rounded-xl shadow-sm flex flex-col justify-between min-h-48 relative overflow-hidden hover:shadow-md transition-shadow cursor-pointer">
            <div className="relative z-10 grid grid-cols-2 gap-x-6 gap-y-4">
              {financialCards.map(({ label, value }) => (
                <div key={label}>
                  <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{t(label)}</p>
                  <p className="mt-1 text-2xl font-extrabold text-[var(--on-surface)] tabular-nums">{formatCurrency(Number(value))}</p>
                  {label === "finance.cashReceived" && (financials?.heldCash ?? 0) !== 0 && (
                    <p className="mt-0.5 text-[11px] text-amber-700">{t("finance.heldCash", { amount: formatCurrency(financials?.heldCash ?? 0) })}</p>
                  )}
                </div>
              ))}
            </div>
            <div className="relative z-10 flex items-center gap-2 text-emerald-600 text-sm font-bold">
              <TrendingUp size={16} />
              <span>{t("finance.scopeHint")}</span>
            </div>
            <div className="absolute -right-8 -bottom-8 opacity-[0.04] text-[var(--primary)]">
              <DollarSign size={192} strokeWidth={1} />
            </div>
          </Link>

          {/* Pending Orders */}
          <Link href="/admin/rental-management?tab=pending" className="bg-[var(--surface-container-low)] p-6 rounded-xl flex flex-col justify-between hover:bg-[var(--surface-container)]/70 transition-colors cursor-pointer">
            <div>
              <p className="text-xs font-bold text-[var(--muted-foreground)] uppercase tracking-widest mb-1">{t("pendingOrders")}</p>
              <h3 className="text-3xl font-extrabold text-[var(--on-surface)] font-headline">{pendingCount}</h3>
            </div>
            <div className="flex items-center gap-2 text-amber-600 text-sm">
              <AlertCircle size={14} />
              <span className="font-medium">{t("common:status.pending", { defaultValue: "Awaiting action" })}</span>
            </div>
          </Link>

          {/* Active Rentals */}
          <Link href="/admin/rental-management?tab=active" className="bg-[var(--surface-container-low)] p-6 rounded-xl flex flex-col justify-between hover:bg-[var(--surface-container)]/70 transition-colors cursor-pointer">
            <div>
              <p className="text-xs font-bold text-[var(--muted-foreground)] uppercase tracking-widest mb-1">{t("activeRentals")}</p>
              <h3 className="text-3xl font-extrabold text-[var(--on-surface)] font-headline">{ongoingCount}</h3>
            </div>
            <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
              <div className="bg-emerald-500 h-full rounded-full transition-all" style={{ width: `${rentalCount > 0 ? (ongoingCount / rentalCount) * 100 : 0}%` }} />
            </div>
          </Link>
        </div>

        {rollingOperationsEnabled && (
          <section className="rounded-xl bg-[var(--surface-container-lowest)] shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-[var(--outline-variant)]/10">
              <div>
                <h2 className="text-sm font-bold text-[var(--on-surface)]">{t("rentalOperations.title")}</h2>
                <p className="text-xs text-[var(--muted-foreground)]">{t("rentalOperations.hint")}</p>
              </div>
              <span className="text-2xl font-extrabold tabular-nums text-[var(--on-surface)]">{ongoingCount}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-[var(--outline-variant)]/10">
              {operationalBreakdown.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.key} href={item.href} className="group relative flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-container-low)]/60 transition-colors">
                    <span className={`absolute inset-x-0 bottom-0 h-0.5 ${item.rail} opacity-70`} />
                    <Icon size={16} className={item.tone} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-[var(--muted-foreground)]">{item.label}</span>
                      {item.detail && <span className="mt-0.5 block text-[9px] font-semibold text-blue-600">{item.detail}</span>}
                    </span>
                    <span className={`text-lg font-extrabold tabular-nums ${item.tone}`}>{item.value}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {fleetStatusMismatch > 0 && (
          <Link href="/admin/rental-fleet" className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800 hover:bg-amber-100/70 transition-colors">
            <AlertCircle size={14} />
            <span>{t("rentalOperations.fleetMismatch", { count: fleetStatusMismatch })}</span>
          </Link>
        )}

        {/* Secondary Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-4">
          {[
            { icon: Package, label: t("fleetAssets"), value: fleetCount, color: "text-indigo-500", bg: "bg-indigo-50", href: "/admin/rental-fleet" },
            { icon: FileText, label: t("availableEquipment"), value: `${availableCount}/${fleetCount}`, color: "text-blue-500", bg: "bg-blue-50", href: "/admin/rental-fleet?status=available" },
            ...(dispatchWorkflowEnabled ? [{ icon: Truck, label: t("dispatchOrders"), value: dispatchCount, color: "text-orange-500", bg: "bg-orange-50", href: "/admin/dispatch" }] : []),
            { icon: ClipboardCheck, label: t("inspections"), value: inspectionCount, color: "text-teal-500", bg: "bg-teal-50", href: "/admin/inspections" },
            { icon: Users, label: t("crm.totalCustomers"), value: crm?.totalCustomers ?? 0, color: "text-purple-500", bg: "bg-purple-50", href: "/admin/customers" },
            // Returning rate / new-this-month / overdue follow-ups need Customers
            // filter support that doesn't exist yet — left non-clickable until
            // that's built so the link can't dead-end at an unfiltered list.
            { icon: UserCheck, label: t("crm.returningRate"), value: `${crm?.returningRate ?? 0}%`, color: "text-emerald-500", bg: "bg-emerald-50", href: null },
            { icon: UserPlus, label: t("crm.newThisMonth"), value: crm?.newThisMonth ?? 0, color: "text-sky-500", bg: "bg-sky-50", href: null },
            { icon: CalendarClock, label: t("crm.overdueFollowUps"), value: crm?.overdueFollowUps?.length ?? 0, color: (crm?.overdueFollowUps?.length ?? 0) > 0 ? "text-amber-600" : "text-slate-500", bg: "bg-amber-50", href: (crm?.overdueFollowUps?.length ?? 0) > 0 ? "/admin/customers" : null },
          ].map((stat) => {
            const Icon = stat.icon;
            const inner = (
              <>
                <div className={`inline-flex p-2 rounded-lg ${stat.bg} ${stat.color} mb-2`}>
                  <Icon size={16} />
                </div>
                <div className="text-lg font-bold text-[var(--on-surface)]">{stat.value}</div>
                <div className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider font-medium">{stat.label}</div>
              </>
            );
            const baseCls = "bg-[var(--surface-container-lowest)] rounded-xl shadow-sm p-4 text-center";
            return stat.href ? (
              <Link key={stat.label} href={stat.href} className={`${baseCls} block hover:shadow-md transition-shadow cursor-pointer`}>{inner}</Link>
            ) : (
              <div key={stat.label} className={baseCls}>{inner}</div>
            );
          })}
        </div>

        {/* Follow-up Reminders */}
        {crm?.overdueFollowUps && crm.overdueFollowUps.length > 0 && (
          <div className="bg-amber-50 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-amber-200/50 flex items-center gap-2">
              <CalendarClock size={16} className="text-amber-600" />
              <h2 className="text-sm font-bold text-amber-800">{t("crm.followUpReminders")}</h2>
            </div>
            <div className="divide-y divide-amber-100">
              {crm.overdueFollowUps.map((c) => (
                <Link key={c.id} href={`/admin/customers/${c.id}`} className="px-6 py-3 flex items-center justify-between hover:bg-amber-100/40 transition-colors cursor-pointer">
                  <div>
                    <span className="text-sm font-medium text-[var(--on-surface)]">{c.name}</span>
                    {c.followUpNotes && (
                      <span className="text-xs text-[var(--muted-foreground)] ml-2">— {c.followUpNotes}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-amber-600 font-medium">{fmtDate(c.nextFollowUp)}</span>
                    <span className="text-xs text-slate-400">{c.totalRentals} {t("crm.rentalsCount")}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Recent Activity */}
        <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm overflow-hidden">
          <div className="px-8 py-5 border-b border-[var(--outline-variant)]/10 flex items-center justify-between">
            <h2 className="text-xl font-bold font-headline text-[var(--on-surface)]">{t("recentActivity")}</h2>
            <div className="flex items-center gap-1 text-[var(--muted-foreground)] text-sm">
              <Activity size={14} />
              <span>{recentActivity.length} {t("common:items", { defaultValue: "items" })}</span>
            </div>
          </div>
          <div className="divide-y divide-[var(--outline-variant)]/5">
            {recentActivity.length > 0 ? recentActivity.map((item, i) => (
              <Link
                key={`${item.type}-${item.id}-${i}`}
                href={item.type === "rental" ? "/admin/rental-management" : "/admin/dispatch"}
                className="px-8 py-4 flex items-center justify-between hover:bg-[var(--surface-container-low)]/30 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full ${item.type === "rental" ? "bg-[var(--primary)]" : "bg-blue-500"}`} />
                  <span className="text-sm text-[var(--on-surface)]">{item.text}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-bold uppercase">
                    {t(`status.${item.status}`, { ns: "common" })}
                  </span>
                  <span className="text-xs text-slate-400">{fmtDate(item.date)}</span>
                </div>
              </Link>
            )) : (
              <div className="px-8 py-12 text-center text-slate-400">{t("noRecentActivity")}</div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
