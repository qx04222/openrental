/**
 * Authorization Rules — tests the actual shared/authRules module
 * used by tRPC middleware and context.ts
 *
 * Tests: isAuthenticated, isAdmin, isSuperAdmin, isFieldStaff
 * (Unified role system: super_admin | admin | user | field_staff)
 */
import { describe, it, expect } from "vitest";
import {
  isAuthenticated,
  isAdmin,
  isSuperAdmin,
  isFieldStaff,
  checkModuleAccess,
  resolvePermissions,
  type ModulePermission,
} from "../shared/authRules";

// Simulates moduleGuard's cache: the WHOLE role_permissions table, all roles.
const ALL_ROLE_PERMS: ModulePermission[] = [
  // super_admin row comes first (seeded first) — the bug made everyone inherit this.
  { role: "super_admin", module: "projects", canCreate: true, canRead: true, canUpdate: true, canDelete: true },
  { role: "admin", module: "projects", canCreate: true, canRead: true, canUpdate: true, canDelete: false },
  { role: "field_staff", module: "projects", canCreate: false, canRead: false, canUpdate: false, canDelete: false },
];

describe("authRules", () => {
  describe("isAuthenticated", () => {
    it("should return true for non-null user object with role", () => {
      expect(isAuthenticated({ role: "user" })).toBe(true);
    });

    it("should return false for null", () => {
      expect(isAuthenticated(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isAuthenticated(undefined)).toBe(false);
    });
  });

  describe("isAdmin", () => {
    it("should allow role=admin", () => {
      expect(isAdmin({ role: "admin" })).toBe(true);
    });

    it("should allow role=super_admin", () => {
      expect(isAdmin({ role: "super_admin" })).toBe(true);
    });

    it("should deny role=user", () => {
      expect(isAdmin({ role: "user" })).toBe(false);
    });

    it("should deny role=field_staff", () => {
      expect(isAdmin({ role: "field_staff" })).toBe(false);
    });
  });

  describe("isSuperAdmin", () => {
    it("should allow role=super_admin", () => {
      expect(isSuperAdmin({ role: "super_admin" })).toBe(true);
    });

    it("should deny role=admin", () => {
      expect(isSuperAdmin({ role: "admin" })).toBe(false);
    });

    it("should deny role=user", () => {
      expect(isSuperAdmin({ role: "user" })).toBe(false);
    });
  });

  describe("isFieldStaff", () => {
    it("should allow role=field_staff", () => {
      expect(isFieldStaff({ role: "field_staff" })).toBe(true);
    });

    it("should allow role=admin (admins can do field work)", () => {
      expect(isFieldStaff({ role: "admin" })).toBe(true);
    });

    it("should allow role=super_admin", () => {
      expect(isFieldStaff({ role: "super_admin" })).toBe(true);
    });

    it("should deny role=user", () => {
      expect(isFieldStaff({ role: "user" })).toBe(false);
    });
  });

  describe("checkModuleAccess — role-default lookup must respect role", () => {
    it("does NOT let field_staff inherit super_admin's row when given the full table", () => {
      // Regression: previously found the first 'projects' row (super_admin) and granted access.
      expect(checkModuleAccess("field_staff", "projects", "read", ALL_ROLE_PERMS)).toBe(false);
      expect(checkModuleAccess("field_staff", "projects", "create", ALL_ROLE_PERMS)).toBe(false);
    });

    it("resolves each role to its own row", () => {
      expect(checkModuleAccess("admin", "projects", "read", ALL_ROLE_PERMS)).toBe(true);
      expect(checkModuleAccess("admin", "projects", "delete", ALL_ROLE_PERMS)).toBe(false);
      expect(checkModuleAccess("field_staff", "projects", "read", ALL_ROLE_PERMS)).toBe(false);
    });

    it("super_admin is always allowed (bypass)", () => {
      expect(checkModuleAccess("super_admin", "projects", "delete", ALL_ROLE_PERMS)).toBe(true);
    });

    it("user override beats role default", () => {
      const overrides = [{ module: "projects", canCreate: null, canRead: true, canUpdate: null, canDelete: null }];
      expect(checkModuleAccess("field_staff", "projects", "read", ALL_ROLE_PERMS, overrides)).toBe(true);
    });

    it("still works when rows carry no role (already filtered to one role)", () => {
      const single: ModulePermission[] = [
        { module: "projects", canCreate: false, canRead: true, canUpdate: false, canDelete: false },
      ];
      expect(checkModuleAccess("field_staff", "projects", "read", single)).toBe(true);
    });
  });

  describe("resolvePermissions — role-default lookup must respect role", () => {
    it("does not leak another role's row from a full-table array", () => {
      const resolved = resolvePermissions("field_staff", ALL_ROLE_PERMS);
      const projects = resolved.find((p) => p.module === "projects")!;
      expect(projects.canRead).toBe(false);
      expect(projects.canCreate).toBe(false);
    });
  });
});
