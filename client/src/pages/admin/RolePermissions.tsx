import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Shield, Save, Loader2 } from "lucide-react";
import { serverErrorText } from "@/lib/serverError";

const ROLES = ["super_admin", "admin", "accountant", "field_staff", "user"] as const;
type Role = (typeof ROLES)[number];

const MODULES = [
  "rentals", "dispatch", "inspections", "invoices", "customers", "fleet",
  "projects", "work_orders", "operators", "drivers", "damage_claims", "users",
  "settings", "reports", "warehouses", "audit_log", "extensions", "promotions",
] as const;

const ACTIONS = ["canCreate", "canRead", "canUpdate", "canDelete"] as const;

type PermMap = Record<string, Record<string, boolean>>;

function buildPermMap(perms: Array<{ module: string; canCreate: boolean; canRead: boolean; canUpdate: boolean; canDelete: boolean }>): PermMap {
  const map: PermMap = {};
  for (const mod of MODULES) {
    map[mod] = { canCreate: false, canRead: false, canUpdate: false, canDelete: false };
  }
  for (const p of perms) {
    if (map[p.module]) {
      map[p.module] = {
        canCreate: p.canCreate,
        canRead: p.canRead,
        canUpdate: p.canUpdate,
        canDelete: p.canDelete,
      };
    }
  }
  return map;
}

export default function RolePermissions() {
  const { t } = useTranslation("admin");
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";

  const utils = trpc.useUtils();
  const [activeRole, setActiveRole] = useState<Role>("admin");
  const [permMap, setPermMap] = useState<PermMap>(() => {
    const m: PermMap = {};
    for (const mod of MODULES) {
      m[mod] = { canCreate: false, canRead: false, canUpdate: false, canDelete: false };
    }
    return m;
  });
  const [dirty, setDirty] = useState(false);

  const editableRole = activeRole !== "super_admin" ? activeRole : null;

  const { data: rolePerms, isLoading } = trpc.rolePermissions.listForRole.useQuery(
    { role: editableRole || "admin" },
    { enabled: !!editableRole },
  );

  const ROLE_LABEL_KEYS: Record<Role, string> = {
    super_admin: t("permissions.roles.superAdmin"),
    admin: t("permissions.roles.admin"),
    accountant: t("permissions.roles.accountant"),
    field_staff: t("permissions.roles.fieldStaff"),
    user: t("permissions.roles.user"),
  };

  const MODULE_LABEL_KEYS: Record<string, string> = {
    rentals: t("permissions.modules.rentals"),
    dispatch: t("permissions.modules.dispatch"),
    inspections: t("permissions.modules.inspections"),
    invoices: t("permissions.modules.invoices"),
    customers: t("permissions.modules.customers"),
    fleet: t("permissions.modules.fleet"),
    projects: t("permissions.modules.projects"),
    work_orders: t("permissions.modules.workOrders"),
    operators: t("permissions.modules.operators"),
    drivers: t("permissions.modules.drivers"),
    damage_claims: t("permissions.modules.damageClaims"),
    users: t("permissions.modules.users"),
    settings: t("permissions.modules.settings"),
    reports: t("permissions.modules.reports"),
    warehouses: t("permissions.modules.warehouses"),
    audit_log: t("permissions.modules.auditLog"),
    extensions: t("permissions.modules.extensions"),
    promotions: t("permissions.modules.promotions"),
  };

  const ACTION_LABEL_KEYS: Record<string, string> = {
    canCreate: t("permissions.actions.create"),
    canRead: t("permissions.actions.read"),
    canUpdate: t("permissions.actions.update"),
    canDelete: t("permissions.actions.delete"),
  };

  const bulkUpdateMut = trpc.rolePermissions.bulkUpdate.useMutation({
    onSuccess: () => {
      toast.success(t("permissions.saved", { role: ROLE_LABEL_KEYS[activeRole] }));
      setDirty(false);
      // Refresh the editor's source rows AND the current user's resolved
      // permissions (drives the sidebar via SettingsShell) so the change is
      // visible immediately instead of after the 5-minute staleTime / reload.
      void utils.rolePermissions.listForRole.invalidate();
      void utils.rolePermissions.getMyPermissions.invalidate();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  useEffect(() => {
    if (rolePerms) {
      setPermMap(buildPermMap(rolePerms));
      setDirty(false);
    }
  }, [rolePerms]);

  const toggle = (mod: string, action: string) => {
    if (activeRole === "super_admin") return;
    setPermMap((prev) => ({
      ...prev,
      [mod]: { ...prev[mod], [action]: !prev[mod][action] },
    }));
    setDirty(true);
  };

  const handleSave = () => {
    if (!editableRole) return;
    const permissions = MODULES.map((mod) => ({
      module: mod,
      canCreate: permMap[mod].canCreate,
      canRead: permMap[mod].canRead,
      canUpdate: permMap[mod].canUpdate,
      canDelete: permMap[mod].canDelete,
    }));
    bulkUpdateMut.mutate({ role: editableRole, permissions });
  };

  const selectAll = () => {
    const m: PermMap = {};
    for (const mod of MODULES) {
      m[mod] = { canCreate: true, canRead: true, canUpdate: true, canDelete: true };
    }
    setPermMap(m);
    setDirty(true);
  };

  const clearAll = () => {
    const m: PermMap = {};
    for (const mod of MODULES) {
      m[mod] = { canCreate: false, canRead: false, canUpdate: false, canDelete: false };
    }
    setPermMap(m);
    setDirty(true);
  };

  if (!isSuperAdmin) {
    return (
      <SettingsShell>
        <div className="flex items-center justify-center py-20">
          <p className="text-slate-500">{t("permissions.accessDenied")}</p>
        </div>
      </SettingsShell>
    );
  }

  return (
    <SettingsShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <Shield className="text-[var(--primary)]" size={24} />
            <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("permissions.title")}</h1>
          </div>
          {activeRole !== "super_admin" && (
            <button
              onClick={handleSave}
              disabled={!dirty || bulkUpdateMut.isPending}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {bulkUpdateMut.isPending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {t("permissions.saveChanges")}
            </button>
          )}
        </div>

        {/* Role tabs */}
        <div className="flex gap-1 border-b border-slate-200">
          {ROLES.map((role) => (
            <button
              key={role}
              onClick={() => role !== "super_admin" && setActiveRole(role)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeRole === role
                  ? "border-[var(--primary)] text-[var(--primary)]"
                  : role === "super_admin"
                  ? "border-transparent text-slate-300 cursor-not-allowed"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {ROLE_LABEL_KEYS[role]}
              {role === "super_admin" && (
                <span className="ml-1.5 text-[10px] text-slate-400">({t("permissions.fullAccess")})</span>
              )}
            </button>
          ))}
        </div>

        {/* Quick actions */}
        {activeRole !== "super_admin" && (
          <div className="flex items-center gap-3">
            <button onClick={selectAll} className="text-xs text-slate-500 hover:text-slate-700 underline">
              {t("permissions.selectAll")}
            </button>
            <button onClick={clearAll} className="text-xs text-slate-500 hover:text-slate-700 underline">
              {t("permissions.clearAll")}
            </button>
          </div>
        )}

        {/* Permission matrix */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="spinner" />
            <span className="ml-3 text-sm text-slate-500">{t("permissions.loading")}</span>
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4 w-[250px]">{t("permissions.module")}</th>
                  {ACTIONS.map((a) => (
                    <th key={a} className="py-3 px-4 text-center w-[100px]">
                      {ACTION_LABEL_KEYS[a]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MODULES.map((mod, idx) => (
                  <tr
                    key={mod}
                    className={`border-b border-slate-200/50 ${
                      idx % 2 === 0 ? "bg-white" : "bg-slate-50/50"
                    } ${activeRole === "super_admin" ? "opacity-50" : "hover:bg-slate-100/50"}`}
                  >
                    <td className="py-3 px-4 font-medium text-slate-900">
                      {MODULE_LABEL_KEYS[mod]}
                    </td>
                    {ACTIONS.map((action) => (
                      <td key={action} className="py-3 px-4 text-center">
                        <input
                          type="checkbox"
                          checked={activeRole === "super_admin" ? true : permMap[mod]?.[action] ?? false}
                          onChange={() => toggle(mod, action)}
                          disabled={activeRole === "super_admin"}
                          className="w-4 h-4 rounded border-slate-300 text-[var(--primary)] focus:ring-[var(--primary)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}
