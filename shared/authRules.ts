/**
 * Authorization rules for role-based access control.
 * Used by tRPC middleware and tested directly.
 *
 * Unified role enum: super_admin | admin | user | field_staff
 */

export function isAuthenticated(user: unknown): user is { role: string } {
  return (
    user != null &&
    typeof user === "object" &&
    "role" in user &&
    typeof (user as Record<string, unknown>).role === "string"
  );
}

export function isAdmin(user: { role: string }): boolean {
  return user.role === "admin" || user.role === "super_admin";
}

export function isSuperAdmin(user: { role: string }): boolean {
  return user.role === "super_admin";
}

export function isFieldStaff(user: { role: string }): boolean {
  return user.role === "field_staff" || isAdmin(user);
}

// ─── Module-level CRUD Permissions ───────────────────────────
export const MODULES = [
  'rentals', 'dispatch', 'inspections', 'invoices', 'customers', 'fleet',
  'projects', 'work_orders', 'operators', 'drivers', 'damage_claims', 'users',
  'settings', 'reports', 'warehouses', 'audit_log', 'extensions', 'promotions',
] as const;

export type Module = typeof MODULES[number];
export type Action = 'create' | 'read' | 'update' | 'delete';

export interface ModulePermission {
  /** Present on rows loaded straight from the role_permissions table. Used to
   *  disambiguate when a multi-role set is passed in (e.g. moduleGuard's cache). */
  role?: string;
  module: string;
  canCreate: boolean;
  canRead: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface ModulePermissionOverride {
  module: string;
  canCreate: boolean | null;
  canRead: boolean | null;
  canUpdate: boolean | null;
  canDelete: boolean | null;
}

/**
 * Check if user has permission for a specific module + action.
 * Resolution order: super_admin bypass → user override → role default
 */
export function checkModuleAccess(
  userRole: string,
  module: string,
  action: Action,
  rolePerms: ModulePermission[],
  userOverrides?: ModulePermissionOverride[],
): boolean {
  if (userRole === 'super_admin') return true;

  const actionKey = `can${action.charAt(0).toUpperCase() + action.slice(1)}` as keyof ModulePermission;

  // Check user-level override first
  if (userOverrides) {
    const override = userOverrides.find(o => o.module === module);
    if (override) {
      const val = (override as unknown as Record<string, unknown>)[actionKey];
      if (val !== null && val !== undefined) return val as boolean;
    }
  }

  // Fall back to role permissions. rolePerms may contain rows for ALL roles
  // (moduleGuard caches the whole table), so we MUST match on role too —
  // matching module alone would resolve to whatever role's row happens to be
  // first, leaking another role's permissions (e.g. super_admin's).
  const rolePerm = rolePerms.find(p => (p.role === undefined || p.role === userRole) && p.module === module);
  if (rolePerm) return rolePerm[actionKey] as boolean;

  return false;
}

/**
 * Resolve all module permissions for a user by merging role defaults with overrides.
 */
export function resolvePermissions(
  userRole: string,
  rolePerms: ModulePermission[],
  userOverrides?: ModulePermissionOverride[],
): ModulePermission[] {
  return MODULES.map((mod) => {
    const rolePerm = rolePerms.find(p => (p.role === undefined || p.role === userRole) && p.module === mod);
    const override = userOverrides?.find(o => o.module === mod);

    const resolve = (key: 'canCreate' | 'canRead' | 'canUpdate' | 'canDelete'): boolean => {
      if (userRole === 'super_admin') return true;
      if (override) {
        const val = override[key];
        if (val !== null && val !== undefined) return val;
      }
      return rolePerm ? rolePerm[key] : false;
    };

    return {
      module: mod,
      canCreate: resolve('canCreate'),
      canRead: resolve('canRead'),
      canUpdate: resolve('canUpdate'),
      canDelete: resolve('canDelete'),
    };
  });
}

// ─── Granular Permissions (DEPRECATED — use CRUD permissions above) ──
/** @deprecated Use checkModuleAccess / resolvePermissions instead */
export type Permission =
  | "canManageUsers"
  | "canManageRentals"
  | "canManageInvoices"
  | "canEditPricing"
  | "canManageCustomers"
  | "canManageFleet"
  | "canViewReports"
  | "canManageSettings"
  | "canExportData"
  | "canDeleteRecords";

export const ALL_PERMISSIONS: Permission[] = [
  "canManageUsers",
  "canManageRentals",
  "canManageInvoices",
  "canEditPricing",
  "canManageCustomers",
  "canManageFleet",
  "canViewReports",
  "canManageSettings",
  "canExportData",
  "canDeleteRecords",
];

/**
 * Check if a user has a specific permission.
 * super_admin always has all permissions.
 * If no permissions record exists, admin gets all, others get none.
 * @deprecated Use checkModuleAccess instead.
 */
export function hasPermission(
  user: { role: string },
  permission: Permission,
  permissions?: Record<string, boolean> | null,
): boolean {
  if (isSuperAdmin(user)) return true;
  if (!permissions) return isAdmin(user);
  return permissions[permission] === true;
}
