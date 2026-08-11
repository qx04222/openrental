import { describe, it, expect } from "vitest";

// Test soft-delete filtering logic patterns used across the app

interface SoftDeletable {
  id: number;
  deletedAt: Date | null;
  [key: string]: unknown;
}

function filterActive<T extends SoftDeletable>(records: T[]): T[] {
  return records.filter((r) => r.deletedAt === null);
}

describe("Soft Delete Filtering", () => {
  const records: SoftDeletable[] = [
    { id: 1, deletedAt: null, name: "Active" },
    { id: 2, deletedAt: new Date("2024-01-01"), name: "Deleted" },
    { id: 3, deletedAt: null, name: "Also Active" },
    { id: 4, deletedAt: new Date("2024-06-15"), name: "Also Deleted" },
  ];

  it("filters out soft-deleted records", () => {
    const active = filterActive(records);
    expect(active).toHaveLength(2);
    expect(active.map((r) => r.id)).toEqual([1, 3]);
  });

  it("returns empty array when all deleted", () => {
    const allDeleted = records.filter((r) => r.deletedAt !== null);
    expect(filterActive(allDeleted)).toHaveLength(0);
  });

  it("returns all when none deleted", () => {
    const noneDeleted = records.filter((r) => r.deletedAt === null);
    expect(filterActive(noneDeleted)).toHaveLength(2);
  });
});

describe("Last Admin Protection", () => {
  interface UserRecord {
    id: number;
    role: "super_admin" | "admin" | "user" | "field_staff";
    isActive: boolean;
    deletedAt: Date | null;
  }

  function countActiveAdmins(users: UserRecord[]): number {
    return users.filter(
      (u) =>
        (u.role === "admin" || u.role === "super_admin") &&
        u.isActive &&
        u.deletedAt === null
    ).length;
  }

  function canDeleteUser(userId: number, users: UserRecord[]): { allowed: boolean; reason?: string } {
    const target = users.find((u) => u.id === userId);
    if (!target) return { allowed: false, reason: "User not found" };

    if (target.role === "admin" || target.role === "super_admin") {
      const adminCount = countActiveAdmins(users);
      if (adminCount <= 1) {
        return { allowed: false, reason: "Cannot delete the last admin" };
      }
    }

    return { allowed: true };
  }

  const users: UserRecord[] = [
    { id: 1, role: "super_admin", isActive: true, deletedAt: null },
    { id: 2, role: "admin", isActive: true, deletedAt: null },
    { id: 3, role: "user", isActive: true, deletedAt: null },
    { id: 4, role: "admin", isActive: false, deletedAt: null },
    { id: 5, role: "admin", isActive: true, deletedAt: new Date() },
  ];

  it("counts only active, non-deleted admins", () => {
    expect(countActiveAdmins(users)).toBe(2); // ids 1 and 2
  });

  it("allows deleting admin when other admins exist", () => {
    expect(canDeleteUser(2, users).allowed).toBe(true);
  });

  it("blocks deleting the last admin", () => {
    const oneAdmin = users.filter((u) => u.id !== 2); // Remove user 2
    expect(canDeleteUser(1, oneAdmin).allowed).toBe(false);
  });

  it("allows deleting non-admin users freely", () => {
    expect(canDeleteUser(3, users).allowed).toBe(true);
  });

  it("ignores inactive admins in count", () => {
    // User 4 is admin but inactive — should not count
    const withoutSuperAdmin = users.filter((u) => u.id !== 1);
    // Only user 2 is active admin
    expect(countActiveAdmins(withoutSuperAdmin)).toBe(1);
    expect(canDeleteUser(2, withoutSuperAdmin).allowed).toBe(false);
  });

  it("ignores soft-deleted admins in count", () => {
    // User 5 is admin but soft-deleted
    const withoutAdminTwo = users.filter((u) => u.id !== 2);
    // Only user 1 is active non-deleted admin
    expect(countActiveAdmins(withoutAdminTwo)).toBe(1);
  });
});

describe("Login Soft-Delete Filtering", () => {
  interface LoginUser {
    id: number;
    username: string;
    email: string;
    passwordHash: string;
    isActive: boolean;
    deletedAt: Date | null;
    role: string;
  }

  function findLoginUser(users: LoginUser[], identifier: string): LoginUser | undefined {
    return users.find(
      (u) =>
        (u.username === identifier || u.email === identifier) &&
        u.deletedAt === null
    );
  }

  const users: LoginUser[] = [
    { id: 1, username: "admin", email: "admin@test.com", passwordHash: "hash1", isActive: true, deletedAt: null, role: "admin" },
    { id: 2, username: "deleted_admin", email: "deleted@test.com", passwordHash: "hash2", isActive: true, deletedAt: new Date(), role: "admin" },
    { id: 3, username: "inactive", email: "inactive@test.com", passwordHash: "hash3", isActive: false, deletedAt: null, role: "admin" },
  ];

  it("finds active user by username", () => {
    expect(findLoginUser(users, "admin")?.id).toBe(1);
  });

  it("finds active user by email", () => {
    expect(findLoginUser(users, "admin@test.com")?.id).toBe(1);
  });

  it("rejects soft-deleted user", () => {
    expect(findLoginUser(users, "deleted_admin")).toBeUndefined();
    expect(findLoginUser(users, "deleted@test.com")).toBeUndefined();
  });

  it("still finds inactive (but not deleted) user", () => {
    // isActive check happens after finding the user
    expect(findLoginUser(users, "inactive")?.id).toBe(3);
  });
});
