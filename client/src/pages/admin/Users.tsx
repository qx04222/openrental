import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import SettingsShell from "@/components/SettingsShell";
import { trpc } from "@/lib/trpc";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, X, Shield } from "lucide-react";
import { roleColors } from "@/lib/statusColors";
import { serverErrorText } from "@/lib/serverError";
import { translateDynamic } from "@/lib/i18nHelpers";
import { canUseModulePermission } from "@/lib/modulePermissions";

const emptyForm = { username: "", email: "", name: "", phone: "", password: "", role: "user" as const };

const MODULES = [
  "rentals", "dispatch", "inspections", "invoices", "customers", "fleet",
  "projects", "work_orders", "operators", "damage_claims", "users",
  "settings", "reports", "warehouses", "audit_log", "extensions",
] as const;

// Module labels are resolved via i18n in the component

const ACTIONS = ["canCreate", "canRead", "canUpdate", "canDelete"] as const;
type PermissionAction = (typeof ACTIONS)[number];
type PermissionModule = (typeof MODULES)[number];
type UserRole = "super_admin" | "admin" | "accountant" | "user" | "field_staff";

function normalizeUserRole(role: string | null | undefined): UserRole {
  switch (role) {
    case "super_admin":
    case "admin":
    case "accountant":
    case "field_staff":
      return role;
    default:
      return "user";
  }
}
const ACTION_LABELS: Record<string, string> = {
  canCreate: "C",
  canRead: "R",
  canUpdate: "U",
  canDelete: "D",
};

// Override state: true = explicit grant, false = explicit deny, null = inherit from role
type OverrideMap = Record<string, Record<string, boolean | null>>;

export default function Users() {
  const { t } = useTranslation(["admin", "common"]);
  const { user: currentUser } = useAuth();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.users.list.useQuery();
  const { data: myPerms } = trpc.rolePermissions.getMyPermissions.useQuery();
  const createMut = trpc.users.create.useMutation({
    onSuccess: () => { utils.users.list.invalidate(); setOpen(false); toast.success(t("users.userCreated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const updateMut = trpc.users.update.useMutation({
    onSuccess: () => { utils.users.list.invalidate(); setOpen(false); toast.success(t("users.userUpdated")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const deleteMut = trpc.users.delete.useMutation({
    onSuccess: () => { utils.users.list.invalidate(); toast.success(t("users.userDeleted")); },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const setOverrideMut = trpc.rolePermissions.setUserOverride.useMutation({
    onSuccess: () => {
      utils.rolePermissions.getUserOverrides.invalidate();
      // Refresh own resolved perms in case the edited user is the current admin.
      utils.rolePermissions.getMyPermissions.invalidate();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });
  const removeOverrideMut = trpc.rolePermissions.removeUserOverride.useMutation({
    onSuccess: () => {
      utils.rolePermissions.getUserOverrides.invalidate();
      utils.rolePermissions.getMyPermissions.invalidate();
    },
    onError: (err) => toast.error(serverErrorText(err)),
  });

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permUserId, setPermUserId] = useState<number | null>(null);
  const [overrideMap, setOverrideMap] = useState<OverrideMap>(() => {
    const m: OverrideMap = {};
    for (const mod of MODULES) {
      m[mod] = { canCreate: null, canRead: null, canUpdate: null, canDelete: null };
    }
    return m;
  });

  const closeModal = useCallback(() => setOpen(false), []);
  const closePermissions = useCallback(() => setPermissionsOpen(false), []);
  useEscapeKey(open, closeModal);
  useEscapeKey(permissionsOpen, closePermissions);

  const isSuperAdmin = currentUser?.role === "super_admin";

  const can = (module: Parameters<typeof canUseModulePermission>[1], action: Parameters<typeof canUseModulePermission>[2]) =>
    canUseModulePermission(myPerms, module, action);

  // Fetch user overrides when editing
  const { data: userOverrides, isLoading: permLoading } = trpc.rolePermissions.getUserOverrides.useQuery(
    { userId: permUserId! },
    { enabled: !!permUserId && permissionsOpen },
  );

  // Fetch role defaults for the user being edited
  const permUser = data?.find((u) => u.id === permUserId);
  const { data: roleDefaults } = trpc.rolePermissions.listForRole.useQuery(
    { role: normalizeUserRole(permUser?.role) },
    { enabled: !!permUser && permissionsOpen },
  );

  // Sync overrides into local state
  useEffect(() => {
    if (!permissionsOpen || !permUserId) return;
    const m: OverrideMap = {};
    for (const mod of MODULES) {
      m[mod] = { canCreate: null, canRead: null, canUpdate: null, canDelete: null };
    }
    if (userOverrides) {
      for (const o of userOverrides) {
        if (m[o.module]) {
          m[o.module] = {
            canCreate: o.canCreate ?? null,
            canRead: o.canRead ?? null,
            canUpdate: o.canUpdate ?? null,
            canDelete: o.canDelete ?? null,
          };
        }
      }
    }
    setOverrideMap(m);
  }, [userOverrides, permissionsOpen, permUserId]);

  const openPermissions = (userId: number) => {
    setPermUserId(userId);
    setPermissionsOpen(true);
  };

  const getRoleDefault = (mod: PermissionModule, action: PermissionAction): boolean => {
    if (!roleDefaults) return false;
    const rp = roleDefaults.find((r) => r.module === mod);
    return rp?.[action] === true;
  };

  // Cycle: null (inherit) -> true (grant) -> false (deny) -> null
  const cycleOverride = (mod: string, action: string) => {
    const current = overrideMap[mod]?.[action];
    let next: boolean | null;
    if (current === null) next = true;
    else if (current === true) next = false;
    else next = null;

    setOverrideMap((prev) => ({
      ...prev,
      [mod]: { ...prev[mod], [action]: next },
    }));
  };

  const handlePermissionsSave = async () => {
    if (!permUserId) return;
    // For each module: all actions null => removeOverride (if one existed); otherwise setUserOverride.
    // Await every mutation so the success toast only fires when ALL of them succeed.
    try {
      await Promise.all(
        MODULES.map((mod) => {
          const actions = overrideMap[mod];
          const allNull = ACTIONS.every((a) => actions[a] === null);
          if (allNull) {
            const hadOverride = userOverrides?.some((o) => o.module === mod);
            return hadOverride
              ? removeOverrideMut.mutateAsync({ userId: permUserId, module: mod })
              : Promise.resolve();
          }
          return setOverrideMut.mutateAsync({
            userId: permUserId,
            module: mod,
            canCreate: actions.canCreate,
            canRead: actions.canRead,
            canUpdate: actions.canUpdate,
            canDelete: actions.canDelete,
          });
        }),
      );
      toast.success(t("users.permissionsSaved"));
      setPermissionsOpen(false);
    } catch {
      // Individual mutation onError handlers already surface the failure as a toast.
    }
  };

  const openAdd = () => { setEditId(null); setForm(emptyForm); setOpen(true); };
  type UserRow = NonNullable<typeof data>[number];
  const openEdit = (u: UserRow) => {
    setEditId(u.id);
    setForm({ username: u.username || "", email: u.email || "", name: u.name || "", phone: (u as Record<string, unknown>).phone as string || "", password: "", role: u.role as typeof emptyForm.role });
    setOpen(true);
  };

  const handleSubmit = () => {
    if (!form.username) return toast.error(t("users.usernameIsRequired"));
    if (editId) {
      const payload: Parameters<typeof updateMut.mutate>[0] = { id: editId, username: form.username, email: form.email || undefined, name: form.name || undefined, phone: form.phone || undefined, role: form.role as "super_admin" | "admin" | "user" | "field_staff" };
      if (form.password) payload.password = form.password;
      updateMut.mutate(payload);
    } else {
      if (!form.password || form.password.length < 6) return toast.error(t("users.passwordMinLength"));
      createMut.mutate({ username: form.username, email: form.email || undefined, name: form.name || undefined, phone: form.phone || undefined, password: form.password, role: form.role });
    }
  };

  return (
    <SettingsShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-extrabold tracking-tight text-[var(--on-surface)]">{t("users.title")}</h1>
          {can('users', 'create') && <button onClick={openAdd} className="btn-primary flex items-center gap-2"><Plus size={18} /> {t("users.addUser")}</button>}
        </div>

        <div className="card overflow-x-auto">
          {isLoading ? <div className="flex items-center justify-center py-12"><div className="spinner" /><span className="ml-3 text-sm text-slate-500">{t("loading", { ns: "common" })}</span></div> : (
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="bg-[var(--surface-container-low)]/50">
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)]">{t("users.username")}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)] hidden md:table-cell">{t("users.name")}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)] hidden md:table-cell">{t("users.email")}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)]">{t("users.role")}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)] hidden md:table-cell">{t("active", { ns: "common" })}</th>
                  <th className="py-4 px-6 text-[10px] font-extrabold uppercase tracking-widest text-[var(--muted-foreground)]">{t("actions", { ns: "common" })}</th>
                </tr>
              </thead>
              <tbody>
                {(data || []).map((u) => (
                  <tr key={u.id} className="hover:bg-[var(--surface-container-low)]/30 transition-colors group">
                    <td className="py-5 px-6 font-bold text-[var(--on-surface)]">{u.username}</td>
                    <td className="py-5 px-6 hidden md:table-cell text-[var(--on-surface)]">{u.name || "-"}</td>
                    <td className="py-5 px-6 hidden md:table-cell text-[var(--on-surface)]">{u.email || "-"}</td>
                    <td className="py-5 px-6">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${roleColors[u.role] || ""}`}>{u.role}</span>
                    </td>
                    <td className="py-5 px-6 hidden md:table-cell">
                      <span className={`w-2.5 h-2.5 rounded-full inline-block ${u.isActive ? "bg-emerald-500" : "bg-red-400"}`} />
                    </td>
                    <td className="py-5 px-6">
                      <div className="flex items-center gap-2">
                        <button onClick={() => openEdit(u)} className="tap-target text-slate-500 hover:text-slate-900" aria-label="Edit user"><Pencil size={16} /></button>
                        {isSuperAdmin && u.role !== "super_admin" && (
                          <button
                            onClick={() => openPermissions(u.id)}
                            className="tap-target text-slate-500 hover:text-blue-600"
                            aria-label="Edit permissions"
                            title="Edit permissions"
                          >
                            <Shield size={16} />
                          </button>
                        )}
                        {can('users', 'delete') && (
                          <button
                            onClick={() => { if (confirm(t("users.deleteConfirm"))) deleteMut.mutate({ id: u.id }); }}
                            className="tap-target text-slate-400 hover:text-[var(--primary)]"
                            aria-label="Delete user"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {data?.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-slate-400">{t("users.noUsers")}</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Add/Edit User Modal */}
      {open && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-lg p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">{editId ? t("users.editUser") : t("users.addUser")}</h2>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <input placeholder={t("users.usernameRequired")} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              <input placeholder={t("users.name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              <input placeholder={t("users.email")} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              <input placeholder={t("users.phone")} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              <input placeholder={editId ? t("users.newPassword") : t("users.passwordRequired")} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm" />
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as typeof emptyForm.role })} className="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-sm">
                <option value="user">{t("users.roleUser")}</option>
                <option value="accountant">{t("users.roleAccountant")}</option>
                <option value="admin">{t("users.roleAdmin")}</option>
                <option value="super_admin">{t("users.roleSuperAdmin")}</option>
                <option value="field_staff">{t("users.roleFieldStaff")}</option>
              </select>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button onClick={handleSubmit} disabled={createMut.isPending || updateMut.isPending} className="btn-primary">{editId ? t("update", { ns: "common" }) : t("create", { ns: "common" })}</button>
            </div>
          </div>
        </div>
      )}

      {/* Permissions Override Modal (CRUD Matrix) */}
      {permissionsOpen && permUserId && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setPermissionsOpen(false)}>
          <div className="bg-[var(--surface-container-lowest)] rounded-xl shadow-sm w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{t("users.permissionOverrides")}</h2>
                <p className="text-sm text-slate-500 mt-0.5">
                  {data?.find((u) => u.id === permUserId)?.username || t("users.name")} &mdash; {data?.find((u) => u.id === permUserId)?.role}
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  {t("users.cycleHint")}: <span className="text-green-600 font-medium">{t("users.grant")}</span> / <span className="text-red-600 font-medium">{t("users.deny")}</span> / <span className="text-slate-400 font-medium">{t("users.inheritFromRole")}</span>
                </p>
              </div>
              <button onClick={() => setPermissionsOpen(false)} className="text-slate-500 hover:text-slate-900" aria-label="Close"><X size={20} /></button>
            </div>

            {permLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="spinner" />
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-2 px-3 text-left">{t("permissions.module", { ns: "admin" })}</th>
                    {ACTIONS.map((a) => (
                      <th key={a} className="py-2 px-2 text-center w-16" title={a.replace("can", "")}>
                        {ACTION_LABELS[a]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MODULES.map((mod, idx) => (
                    <tr key={mod} className={idx % 2 === 0 ? "bg-white" : "bg-slate-50/50"}>
                      <td className="py-2 px-3 text-slate-900 font-medium text-xs">{translateDynamic(t, `permissions.modules.${mod.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`)}</td>
                      {ACTIONS.map((action) => {
                        const val = overrideMap[mod]?.[action];
                        const roleDefault = getRoleDefault(mod, action);
                        return (
                          <td key={action} className="py-2 px-2 text-center">
                            <button
                              type="button"
                              onClick={() => cycleOverride(mod, action)}
                              className={`w-7 h-7 rounded border text-xs font-bold transition-colors ${
                                val === true
                                  ? "bg-green-100 border-green-400 text-green-700"
                                  : val === false
                                  ? "bg-red-100 border-red-400 text-red-700"
                                  : "bg-slate-50 border-slate-200 text-slate-400"
                              }`}
                              title={
                                val === true ? t("users.explicitlyGranted")
                                : val === false ? t("users.explicitlyDenied")
                                : `${t("users.inheritFromRole")} (${roleDefault ? t("users.allowed") : t("users.denied")})`
                              }
                            >
                              {val === true ? "\u2713" : val === false ? "\u2717" : roleDefault ? "\u2022" : "\u2013"}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
              <button onClick={() => setPermissionsOpen(false)} className="btn-secondary">{t("cancel", { ns: "common" })}</button>
              <button
                onClick={handlePermissionsSave}
                disabled={setOverrideMut.isPending || removeOverrideMut.isPending}
                className="btn-primary"
              >
                {setOverrideMut.isPending ? t("saving", { ns: "common" }) : t("users.saveOverrides")}
              </button>
            </div>
          </div>
        </div>
      )}
    </SettingsShell>
  );
}
