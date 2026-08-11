import { ReactNode, useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import { useBranding } from "@/config/branding";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import GlobalSearch from "@/components/GlobalSearch";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import { useAuth } from "@/hooks/useAuth";
import { useSessionHeartbeat } from "@/hooks/useSessionHeartbeat";
import { trpc } from "@/lib/trpc";
import { useFeatureFlag } from "@/hooks/useFeatureFlag";
import type { LucideIcon } from "lucide-react";
import { PhoneCall, LayoutDashboard, Truck, ClipboardCheck, Settings, Users, Package, RefreshCw, Menu, X, LogOut, Search, FileText, BarChart3, Receipt, Wrench, AlertTriangle, CalendarClock, Tags, Wallet, ListChecks } from "lucide-react";

type WorkQueueKind = "work_order" | "draft_invoice" | "damage_claim" | "dispatch_order" | "extension_request" | "held_deposit" | "unbilled_credit_charges" | "overdue_invoice";
type SubItem = { icon: LucideIcon; label: string; path: string; permission?: string; queue?: WorkQueueKind };
type MenuItem =
  | (SubItem)
  | { label: string; items: SubItem[] };

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const { user } = useAuth();
  useSessionHeartbeat();
  const isSuperAdmin = user?.role === "super_admin";
  const isAdmin = user?.role === "admin" || isSuperAdmin;
  const dispatchWorkflowEnabled = useFeatureFlag("dispatch_workflow");

  // Fetch CRUD permissions for current user
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // cache for 5 minutes
  });

  // Backlog badges. Work items that were created and then stalled used to be
  // invisible everywhere — two open work orders held a machine for two weeks,
  // and 25 draft invoices went unsent for months. The count lives next to the
  // page that clears it. Users without reports access simply see no badge.
  const { data: workQueue } = trpc.reports.internalWorkQueue.useQuery(undefined, {
    staleTime: 60 * 1000,
    retry: false,
  });
  const queueByKind = useMemo(() => {
    const m = new Map<WorkQueueKind, { count: number; overdueCount: number }>();
    (workQueue?.buckets ?? []).forEach((b) => m.set(b.kind as WorkQueueKind, b));
    return m;
  }, [workQueue]);

  const queueBadge = (kind?: WorkQueueKind) => {
    if (!kind) return null;
    const bucket = queueByKind.get(kind);
    if (!bucket?.count) return null;
    // Amber means "there is work here"; red means it has been waiting past the
    // point where someone should have noticed.
    const tone = bucket.overdueCount > 0
      ? "bg-red-100 text-red-700"
      : "bg-amber-100 text-amber-700";
    return (
      <span className={`ml-auto min-w-[1.25rem] text-center px-1.5 py-0.5 rounded-full text-[10px] font-bold tabular-nums ${tone}`}>
        {bucket.count}
      </span>
    );
  };

  const hasPerm = (permission?: string): boolean => {
    if (!permission) return true; // No permission required
    if (permission === "super_admin") return isSuperAdmin;
    if (isSuperAdmin) return true;
    if (!myPerms) return isAdmin; // loading fallback
    // permission string is a module name or "module:action"
    let mod = permission;
    let action = 'read';
    if (permission.includes(':')) {
      [mod, action] = permission.split(':');
    }
    const perm = (myPerms as Array<{module: string; canCreate: boolean; canRead: boolean; canUpdate: boolean; canDelete: boolean}>).find(p => p.module === mod);
    const key = `can${action.charAt(0).toUpperCase() + action.slice(1)}` as 'canCreate' | 'canRead' | 'canUpdate' | 'canDelete';
    return perm?.[key] ?? false;
  };

  const allMenuItems: MenuItem[] = [
    { icon: LayoutDashboard, label: t("sidebar.dashboard"), path: "/admin" },
    { label: t("sidebar.rentals"), items: [
      { icon: FileText, label: t("sidebar.rentalManagement"), path: "/admin/rental-management", permission: "rentals", queue: "held_deposit" },
      { icon: Truck, label: t("sidebar.dispatch"), path: "/admin/dispatch", permission: "dispatch", queue: "dispatch_order" },
      { icon: ClipboardCheck, label: t("sidebar.inspections"), path: "/admin/inspections", permission: "inspections" },
      // Projects module is unused (0 projects, 0 linked rentals) — hidden from the
      // sidebar for now; the /admin/projects route still exists if needed later.
      { icon: Settings, label: t("sidebar.rentalSettings"), path: "/admin/rental-settings", permission: "settings" },
      { icon: CalendarClock, label: t("sidebar.extensionRequests"), path: "/admin/extension-requests", permission: "extensions", queue: "extension_request" },
    ]},
    { label: t("sidebar.inventory"), items: [
      { icon: Package, label: t("sidebar.rentalFleet"), path: "/admin/rental-fleet", permission: "fleet" },
      { icon: Tags, label: t("sidebar.categoryManagement"), path: "/admin/categories", permission: "fleet" },
      { icon: RefreshCw, label: t("sidebar.catalogSync"), path: "/admin/catalog-sync", permission: "fleet" },
      { icon: Wrench, label: t("sidebar.workOrders"), path: "/admin/work-orders", permission: "work_orders", queue: "work_order" },
      // Category pricing (0 rows) and fleet certificates (0 rows) moved to the
      // Settings Center's "seldom used" group — routes unchanged.
    ]},
    { label: t("sidebar.crm"), items: [
      { icon: Users, label: t("sidebar.customers"), path: "/admin/customers", permission: "customers" },
      { icon: ListChecks, label: t("sidebar.customerClassification"), path: "/admin/customer-classification", permission: "customers" },
      // Inquiries (0 rows), operators (0 rows) and promotions (3 rows) moved to
      // the Settings Center's "seldom used" group — routes unchanged.
    ]},
    { label: t("sidebar.billing"), items: [
      { icon: FileText, label: t("sidebar.quotations"), path: "/admin/quotations", permission: "invoices" },
      { icon: Receipt, label: t("sidebar.invoices"), path: "/admin/invoices", permission: "invoices", queue: "draft_invoice" },
      { icon: PhoneCall, label: t("sidebar.collections"), path: "/admin/collections", permission: "invoices", queue: "overdue_invoice" },
      { icon: Wallet, label: t("sidebar.customerCredit"), path: "/admin/customer-credit", permission: "invoices" },
      { icon: AlertTriangle, label: t("sidebar.damageClaims"), path: "/admin/damage-claims", permission: "damage_claims", queue: "damage_claim" },
    ]},
    { label: t("sidebar.analytics"), items: [
      { icon: BarChart3, label: t("sidebar.reports"), path: "/admin/reports", permission: "reports" },
    ]},
    // System + Settings long tail (11 pages) consolidated into one hub entry to
    // keep the sidebar short — the hub renders a permission-filtered card menu.
    { icon: Settings, label: t("sidebar.systemSettings"), path: "/admin/system-settings", permission: "settings" },
  ];

  // Filter menu items based on permissions
  const menuItems = useMemo(() => {
    return allMenuItems
      .map((item) => {
        if ("path" in item) {
          // Top-level item
          return hasPerm(item.permission) ? item : null;
        }
        // Group item: filter sub-items
        const filtered = item.items.filter((sub) => (
          hasPerm(sub.permission)
          && (sub.path !== "/admin/dispatch" || dispatchWorkflowEnabled)
        ));
        if (filtered.length === 0) return null;
        return { ...item, items: filtered };
      })
      .filter(Boolean) as MenuItem[];
  }, [allMenuItems, myPerms, isSuperAdmin, isAdmin, dispatchWorkflowEnabled]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [location] = useLocation();
  const branding = useBranding();

  const handleLogout = async () => {
    await fetch("/api/admin-auth/logout", { method: "POST", credentials: "include" });
    window.location.href = "/admin/login";
  };

  return (
    <ConfirmProvider>
    <div className="flex min-h-screen bg-[var(--surface)]">
      {/* Sidebar — Light theme */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-slate-50 border-r-0 transform transition-transform lg:translate-x-0 lg:static ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Logo area */}
        <div className="flex items-center justify-between h-16 px-6">
          <Link href="/admin" className="flex items-center gap-3">
            <img src="/logo.png" alt={branding.companyName} className="h-8" />
          </Link>
          <button className="lg:hidden text-slate-400 hover:text-slate-600" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">
            <X size={20} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="px-4 space-y-1 overflow-y-auto h-[calc(100vh-8rem)] pt-2">
          {menuItems.map((item, i) => {
            if ("path" in item) {
              const Icon = item.icon;
              const isActive = item.path === "/admin" ? location === "/admin" : location.startsWith(item.path);
              return (
                <Link
                  key={i}
                  href={item.path}
                  onClick={() => setSidebarOpen(false)}
                  className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active)] border-l-4 border-[var(--sidebar-active)] font-bold -ml-1"
                      : "text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  <Icon size={18} />
                  {item.label}
                </Link>
              );
            }

            return (
              <div key={i} className="pt-5">
                <div className="px-4 mb-2 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">
                  {item.label}
                </div>
                {item.items?.map((sub, j) => {
                  const Icon = sub.icon;
                  const isActive = location.startsWith(sub.path);
                  return (
                    <Link
                      key={j}
                      href={sub.path}
                      onClick={() => setSidebarOpen(false)}
                      className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors ${
                        isActive
                          ? "bg-[var(--sidebar-active-bg)] text-[var(--sidebar-active)] border-l-4 border-[var(--sidebar-active)] font-bold -ml-1"
                          : "text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      <Icon size={18} />
                      {sub.label}
                      {queueBadge(sub.queue)}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* Bottom section */}
        <div className="absolute bottom-0 w-full px-4 pb-6 pt-4 border-t border-slate-200">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-slate-500 hover:text-slate-900 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <LogOut size={18} />
            {t("signOut")}
          </button>
        </div>
      </aside>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main content */}
      <main className="flex-1 min-w-0">
        {/* Top header — frosted glass */}
        <header className="sticky top-0 z-30 h-16 flex items-center justify-between px-4 lg:px-8 bg-[var(--surface)]/80 backdrop-blur-xl shadow-sm">
          <div className="flex items-center gap-2 sm:gap-4">
            <button className="lg:hidden text-slate-500 hover:text-slate-700 min-h-[44px] min-w-[44px] -ml-2 inline-flex items-center justify-center" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <Menu size={24} />
            </button>
            {/* Search bar (desktop) */}
            <button
              onClick={() => {
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
              }}
              className="hidden sm:flex items-center gap-2 w-72 bg-[var(--surface-container-low)] rounded-lg pl-3 pr-4 py-2 text-sm text-slate-400 hover:bg-[var(--surface-container)] transition-colors"
            >
              <Search size={16} />
              <span className="flex-1 text-left">{t("header.search")}</span>
              <kbd className="text-[10px] text-slate-400 bg-white px-1.5 py-0.5 rounded border border-slate-200">⌘K</kbd>
            </button>
            {/* Search icon (mobile) */}
            <button
              onClick={() => {
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
              }}
              className="sm:hidden text-slate-500 hover:text-slate-700 min-h-[44px] min-w-[44px] inline-flex items-center justify-center"
              aria-label={t("header.search")}
            >
              <Search size={20} />
            </button>
          </div>
          <div className="flex items-center gap-4">
            <LanguageSwitcher />
          </div>
        </header>

        {/* Page content */}
        <div className="p-4 lg:p-8">{children}</div>
      </main>

      {/* Global search overlay */}
      <GlobalSearch />
    </div>
    </ConfirmProvider>
  );
}
