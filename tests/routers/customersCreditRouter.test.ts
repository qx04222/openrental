/**
 * Auth and behaviour tests for customers.setBlacklist and customers.setCreditLimit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockGetDb, insertResults, queryResults, mockLogAudit } = vi.hoisted(() => {
  const insertResults: { value: unknown[] } = { value: [] };
  const queryResults: { value: unknown[] } = { value: [] };

  const createChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["from", "where", "limit", "returning", "set", "leftJoin", "orderBy"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve([...queryResults.value]);
    return chain;
  };

  const mockDb = {
    select: vi.fn().mockImplementation(() => createChain()),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => Promise.resolve([...insertResults.value])),
      }),
    }),
    update: vi.fn().mockImplementation(() => {
      const chain: Record<string, ReturnType<typeof vi.fn>> = {};
      chain.set = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => Promise.resolve([...insertResults.value])),
        }),
      });
      return chain;
    }),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    insertResults,
    queryResults,
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Module mocks ───────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  and: vi.fn((..._a: unknown[]) => "and"),
  or: vi.fn((..._a: unknown[]) => "or"),
  desc: vi.fn((..._a: unknown[]) => "desc"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
  isNotNull: vi.fn((..._a: unknown[]) => "isNotNull"),
  ilike: vi.fn((..._a: unknown[]) => "ilike"),
  sql: vi.fn((..._a: unknown[]) => "sql"),
  inArray: vi.fn((..._a: unknown[]) => "inArray"),
  gte: vi.fn((..._a: unknown[]) => "gte"),
  lte: vi.fn((..._a: unknown[]) => "lte"),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    customers: {
      id: col("id"),
      name: col("name"),
      email: col("email"),
      phone: col("phone"),
      company: col("company"),
      address: col("address"),
      city: col("city"),
      province: col("province"),
      postalCode: col("postalCode"),
      notes: col("notes"),
      tags: col("tags"),
      source: col("source"),
      riskScore: col("riskScore"),
      totalRentals: col("totalRentals"),
      totalRevenue: col("totalRevenue"),
      lastRentalDate: col("lastRentalDate"),
      nextFollowUp: col("nextFollowUp"),
      followUpNotes: col("followUpNotes"),
      lastContactedAt: col("lastContactedAt"),
      creditLimit: col("creditLimit"),
      isBlacklisted: col("isBlacklisted"),
      blacklistReason: col("blacklistReason"),
      blacklistedAt: col("blacklistedAt"),
      referralCodeId: col("referralCodeId"),
      referralBoundAt: col("referralBoundAt"),
      updatedAt: col("updatedAt"),
      deletedAt: col("deletedAt"),
      createdAt: col("createdAt"),
    },
    customerInteractions: {
      id: col("id"),
      customerId: col("customerId"),
      type: col("type"),
      summary: col("summary"),
      createdBy: col("createdBy"),
      createdAt: col("createdAt"),
    },
    users: { id: col("id"), name: col("name"), deletedAt: col("deletedAt") },
    rentalRequests: {
      id: col("id"),
      customerId: col("customerId"),
      status: col("status"),
      deletedAt: col("deletedAt"),
      totalAmount: col("totalAmount"),
      startDate: col("startDate"),
      endDate: col("endDate"),
      deliveryMethod: col("deliveryMethod"),
      equipmentDescription: col("equipmentDescription"),
      createdAt: col("createdAt"),
    },
    rentalFleet: {
      id: col("id"),
      brand: col("brand"),
      model: col("model"),
      category: col("category"),
    },
    auditLogs: {
      id: col("id"),
      userId: col("userId"),
      action: col("action"),
      entityType: col("entityType"),
      entityId: col("entityId"),
      changes: col("changes"),
      metadata: col("metadata"),
      ipAddress: col("ipAddress"),
      createdAt: col("createdAt"),
    },
    rolePermissions: {
      id: col("id"),
      role: col("role"),
      module: col("module"),
      canCreate: col("canCreate"),
      canRead: col("canRead"),
      canUpdate: col("canUpdate"),
      canDelete: col("canDelete"),
      createdAt: col("createdAt"),
      updatedAt: col("updatedAt"),
    },
    userPermissionOverrides: {
      id: col("id"),
      userId: col("userId"),
      module: col("module"),
      canCreate: col("canCreate"),
      canRead: col("canRead"),
      canUpdate: col("canUpdate"),
      canDelete: col("canDelete"),
      createdAt: col("createdAt"),
    },
  };
});

vi.mock("../../server/services/auditLog", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../server/services/featureFlags", () => ({
  isFeatureEnabled: vi.fn().mockReturnValue(true),
}));

// ── Import router ──────────────────────────────────────────────────────
import { customersRouter } from "../../server/routers/customers.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(customersRouter);

function makeCtx(role?: string): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: role
      ? {
          id: 99,
          email: "admin@test.com",
          name: "Test Admin",
          username: "admin",
          role: role as "super_admin",
          isActive: true,
          passwordHash: null,
          phone: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          lastSignedIn: null,
          loginMethod: null,
        }
      : null,
  };
}

const existingCustomer = {
  id: 1,
  name: "Test Customer",
  email: "test@example.com",
  isBlacklisted: false,
  blacklistReason: null,
  blacklistedAt: null,
  creditLimit: null,
  updatedAt: new Date(),
};

const updatedCustomer = {
  ...existingCustomer,
  isBlacklisted: true,
  blacklistReason: "Fraud",
  blacklistedAt: new Date(),
};

describe("customers.setBlacklist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [existingCustomer];
    insertResults.value = [updatedCustomer];
  });

  it("throws UNAUTHORIZED when no user", async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.setBlacklist({ id: 1, isBlacklisted: true, reason: "Fraud" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("throws FORBIDDEN when user is admin (not super_admin)", async () => {
    const caller = createCaller(makeCtx("admin"));
    await expect(
      caller.setBlacklist({ id: 1, isBlacklisted: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("throws FORBIDDEN when user is regular user", async () => {
    const caller = createCaller(makeCtx("user"));
    await expect(
      caller.setBlacklist({ id: 1, isBlacklisted: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("succeeds and writes audit log when user is super_admin", async () => {
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.setBlacklist({ id: 1, isBlacklisted: true, reason: "Fraud" });
    expect(result).toMatchObject({ isBlacklisted: true });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "blacklist",
        entityType: "customer",
        entityId: 1,
      }),
    );
  });

  it("sets isBlacklisted to false (unblacklist) and logs unblacklist action", async () => {
    const unblockedCustomer = { ...existingCustomer, isBlacklisted: false, blacklistReason: null };
    insertResults.value = [unblockedCustomer];

    const caller = createCaller(makeCtx("super_admin"));
    await caller.setBlacklist({ id: 1, isBlacklisted: false });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "unblacklist" }),
    );
  });
});

describe("customers.setCreditLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [existingCustomer];
    insertResults.value = [{ ...existingCustomer, creditLimit: "5000" }];
  });

  it("throws UNAUTHORIZED when no user", async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.setCreditLimit({ id: 1, limit: 5000 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("throws FORBIDDEN when user is admin (not super_admin)", async () => {
    const caller = createCaller(makeCtx("admin"));
    await expect(
      caller.setCreditLimit({ id: 1, limit: 5000 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("succeeds and writes audit log when user is super_admin", async () => {
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.setCreditLimit({ id: 1, limit: 5000 });
    expect(result).toMatchObject({ creditLimit: "5000" });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "set_credit_limit",
        entityType: "customer",
        entityId: 1,
      }),
    );
  });

  it("succeeds with null limit (unlimited) and logs change", async () => {
    insertResults.value = [{ ...existingCustomer, creditLimit: null }];
    const caller = createCaller(makeCtx("super_admin"));
    await caller.setCreditLimit({ id: 1, limit: null });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "set_credit_limit",
        changes: expect.objectContaining({
          creditLimit: expect.objectContaining({ new: null }),
        }),
      }),
    );
  });
});
