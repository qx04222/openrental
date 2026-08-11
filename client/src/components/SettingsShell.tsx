import { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import type { LucideIcon } from "lucide-react";
import { Shield, Activity, Trash2, FileText, Building2, Users, Car, Bell, Settings, ToggleLeft } from "lucide-react";

/**
 * Settings Center shell: DashboardLayout + a persistent left second-level menu
 * for the system/settings pages. Every such page wraps its content in this shell
 * so switching/returning is always one click (no dead-end sub-pages). The nav is
 * permission-filtered and highlights the current route.
 */
type NavItem = { icon: LucideIcon; labelKey: string; path: string; permission?: string };

export const SETTINGS_NAV: { titleKey: string; items: NavItem[] }[] = [
  {
    titleKey: "sidebar.system",
    items: [
      { icon: Shield, labelKey: "sidebar.auditLog", path: "/admin/audit-log", permission: "audit_log" },
      { icon: Activity, labelKey: "sidebar.userActivity", path: "/admin/user-activity", permission: "audit_log" },
      { icon: Trash2, labelKey: "sidebar.recycleBin", path: "/admin/recycle-bin", permission: "settings:delete" },
    ],
  },
  {
    titleKey: "sidebar.settings",
    items: [
      { icon: FileText, labelKey: "sidebar.pdfTemplates", path: "/admin/pdf-templates", permission: "settings" },
      { icon: Building2, labelKey: "sidebar.warehouses", path: "/admin/warehouses", permission: "warehouses" },
      { icon: Users, labelKey: "sidebar.users", path: "/admin/users", permission: "users" },
      { icon: Car, labelKey: "sidebar.drivers", path: "/admin/drivers", permission: "drivers" },
      { icon: Shield, labelKey: "sidebar.rolePermissions", path: "/admin/role-permissions", permission: "users" },
      { icon: Bell, labelKey: "sidebar.notifications", path: "/admin/notifications", permission: "settings" },
      { icon: Settings, labelKey: "sidebar.siteSettings", path: "/admin/site-settings", permission: "settings" },
      { icon: ToggleLeft, labelKey: "sidebar.featureFlags", path: "/admin/settings/feature-flags", permission: "super_admin" },
    ],
  },
];

export default function SettingsShell({ children }: { children: ReactNode }) {
  const { t: tBase } = useTranslation("common");
  const t = tBase as (key: string) => string;
  const [location] = useLocation();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";
  const isAdmin = user?.role === "admin" || isSuperAdmin;
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery(undefined, { staleTime: 5 * 60 * 1000 });

  const hasPerm = (permission?: string): boolean => {
    if (!permission) return true;
    if (permission === "super_admin") return isSuperAdmin;
    if (isSuperAdmin) return true;
    if (!myPerms) return isAdmin;
    let mod = permission;
    let action = "read";
    if (permission.includes(":")) [mod, action] = permission.split(":");
    const perm = (myPerms as Array<{ module: string; canCreate: boolean; canRead: boolean; canUpdate: boolean; canDelete: boolean }>).find((p) => p.module === mod);
    const key = `can${action.charAt(0).toUpperCase() + action.slice(1)}` as "canCreate" | "canRead" | "canUpdate" | "canDelete";
    return perm?.[key] ?? false;
  };

  return (
    <DashboardLayout>
      <div className="flex flex-col md:flex-row gap-6">
        {/* Persistent second-level menu */}
        <nav className="w-full md:w-56 shrink-0 space-y-4 md:sticky md:top-4 md:self-start">
          <Link href="/admin/system-settings" className="text-sm font-bold text-[var(--on-surface)] hover:text-[var(--primary)]">{t("sidebar.systemSettings")}</Link>
          {SETTINGS_NAV.map((group) => {
            const items = group.items.filter((i) => hasPerm(i.permission));
            if (items.length === 0) return null;
            return (
              <div key={group.titleKey}>
                <h3 className="text-[10px] font-bold text-[var(--muted-foreground)] uppercase tracking-widest mb-1 px-2">{t(group.titleKey)}</h3>
                <div className="space-y-0.5">
                  {items.map((item) => {
                    const Icon = item.icon;
                    const active = location === item.path;
                    return (
                      <Link
                        key={item.path}
                        href={item.path}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition ${active ? "bg-[var(--primary)]/10 text-[var(--primary)] font-semibold" : "text-slate-600 hover:bg-slate-100"}`}
                      >
                        <Icon size={15} className="shrink-0" /> {t(item.labelKey)}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </DashboardLayout>
  );
}
