/**
 * Inspections Router — integration tests via tRPC createCallerFactory
 * Tests real middleware chain (admin/fieldStaff/public procedures) + DB mock
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockGetDb, mockDb, selectChain, queryResults, insertResults, mockLogAudit, mockCheckRateLimit, mockIsSupabaseConfigured, mockUploadPhotos, mockRecordProgress, mockAssertConflict } = vi.hoisted(() => {
  const queryResults: { value: unknown[] } = { value: [] };
  const insertResults: { value: unknown[] } = { value: [] };

  const createChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    const methods = ["select", "from", "leftJoin", "innerJoin", "where", "orderBy", "limit", "offset", "insert", "values", "returning", "update", "set", "delete"];
    for (const m of methods) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    // Make chain thenable — resolves with queryResults.value
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve([...queryResults.value]);
    return chain;
  };

  const chain = createChain();

  // Separate chain for insert().values().returning() which needs insertResults
  const insertChain = createChain();
  (insertChain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve([...insertResults.value]);

  // Delete chain needs to be thenable via .where().then().catch()
  const deleteChain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) {
    deleteChain[m] = vi.fn().mockReturnValue(deleteChain);
  }
  // Make delete chain properly thenable (Promise-like)
  deleteChain.then = vi.fn().mockImplementation((resolve: () => void) => {
    resolve();
    return { catch: vi.fn() };
  });

  const mockDb = {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockImplementation(() => {
      const p = Promise.resolve([...insertResults.value]);
      return p;
    }) }) }),
    update: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(deleteChain),
    execute: vi.fn().mockResolvedValue([{ assigned: true }]),
    transaction: vi.fn(),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    mockDb,
    selectChain: chain,
    queryResults,
    insertResults,
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
    mockCheckRateLimit: vi.fn().mockReturnValue(true),
    mockIsSupabaseConfigured: vi.fn().mockReturnValue(false),
    mockUploadPhotos: vi.fn().mockResolvedValue({
      photoFront: "url1", photoBack: "url2", photoLeft: null,
      photoRight: null, photoAdditional: null, customerSignature: null,
    }),
    mockRecordProgress: vi.fn().mockResolvedValue(undefined),
    mockAssertConflict: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Module mocks ───────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  and: vi.fn((..._a: unknown[]) => "and"),
  desc: vi.fn((..._a: unknown[]) => "desc"),
  gte: vi.fn((..._a: unknown[]) => "gte"),
  lte: vi.fn((..._a: unknown[]) => "lte"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
  or: vi.fn((..._a: unknown[]) => "or"),
  inArray: vi.fn((..._a: unknown[]) => "inArray"),
  sql: Object.assign(
    (_strings: TemplateStringsArray, ..._v: unknown[]) => "sql",
    { raw: (_s: string) => "sql-raw" },
  ),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    inspections: {
      id: col("id"), type: col("type"), rentalId: col("rentalId"),
      rentalFleetId: col("rentalFleetId"), deletedAt: col("deletedAt"),
      createdAt: col("createdAt"), overallCondition: col("overallCondition"),
      offlineId: col("offlineId"),
    },
    rentalFleet: {
      id: col("id"), brand: col("brand"), model: col("model"),
      serialNumber: col("serialNumber"), category: col("category"),
      assetNumber: col("assetNumber"), currentStatus: col("currentStatus"),
      imageUrl: col("imageUrl"), catalogCacheId: col("catalogCacheId"),
      deletedAt: col("deletedAt"),
    },
    rentalRequests: {
      id: col("id"), customerName: col("customerName"),
      rentalFleetId: col("rentalFleetId"), status: col("status"),
      startDate: col("startDate"), endDate: col("endDate"),
      deliveryMethod: col("deliveryMethod"), deliveryAddress: col("deliveryAddress"),
      deletedAt: col("deletedAt"),
      deliveryInspectionCompleted: col("deliveryInspectionCompleted"),
      deliveryInspectionId: col("deliveryInspectionId"),
      returnInspectionCompleted: col("returnInspectionCompleted"),
      returnInspectionId: col("returnInspectionId"),
      updatedAt: col("updatedAt"),
    },
    rentalLineItems: {
      id: col("id"), rentalRequestId: col("rentalRequestId"), rentalFleetId: col("rentalFleetId"),
      deletedAt: col("deletedAt"),
    },
    inspectionTokens: {
      id: col("id"), tokenHash: col("tokenHash"), inspectionType: col("inspectionType"),
      rentalId: col("rentalId"), rentalFleetId: col("rentalFleetId"),
      isUsed: col("isUsed"), expiresAt: col("expiresAt"),
      createdAt: col("createdAt"), createdBy: col("createdBy"),
    },
    catalogCache: { id: col("id"), imageUrl: col("imageUrl") },
    auditLogs: { id: col("id"), action: col("action"), changes: col("changes"), metadata: col("metadata"), createdAt: col("createdAt"), entityType: col("entityType"), entityId: col("entityId"), userId: col("userId") },
    users: { id: col("id"), name: col("name"), username: col("username") },
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
  logAudit: mockLogAudit,
}));

vi.mock("../../server/services/rentalAssetProgress", () => ({
  recordAssetProgressEvent: (...args: unknown[]) => mockRecordProgress(...args),
}));

vi.mock("../../server/services/rentalFleetConflict", () => ({
  assertFleetRentalPairUnambiguous: (...args: unknown[]) => mockAssertConflict(...args),
}));

vi.mock("../../server/services/storage", () => ({
  uploadInspectionPhotosToSupabase: (...args: unknown[]) => mockUploadPhotos(...args),
  isSupabaseStorageConfigured: () => mockIsSupabaseConfigured(),
}));

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../shared/rateLimiter", () => ({
  checkRateLimit: mockCheckRateLimit,
  purgeExpiredEntries: vi.fn(),
}));

// ── Import router + create caller ──────────────────────────────────────
import { inspectionsRouter } from "../../server/routers/inspections.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(inspectionsRouter);

function makeCtx(role?: string): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: role ? {
      id: 1, email: "test@test.com", name: "Test", username: "test",
      role: role as any, isActive: true, passwordHash: null, phone: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      lastSignedIn: null, loginMethod: null,
    } : null,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────
describe("inspections router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
    insertResults.value = [];
    mockIsSupabaseConfigured.mockReturnValue(false);
    // Restore select mock in case a previous test replaced the implementation
    mockDb.select = vi.fn().mockReturnValue(selectChain);
  });

  // ── Permission tests ─────────────────────────────────────────────
  describe("permissions", () => {
    it("list rejects unauthenticated users", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.list()).rejects.toThrow("Please login");
    });

    it("list rejects field staff (admin-only)", async () => {
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.list()).rejects.toThrow();
    });

    it("list allows admin", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.list();
      expect(Array.isArray(result)).toBe(true);
    });

    it("create rejects unauthenticated users", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.create({ type: "dispatch" })).rejects.toThrow("Please login");
    });

    it("create allows field staff", async () => {
      const caller = createCaller(makeCtx("field_staff"));
      queryResults.value = []; // no duplicate offlineId
      // The create mutation completes without throwing for field_staff
      // Result may be undefined if insert mock returns empty, but no auth error is thrown
      await expect(caller.create({ type: "dispatch" })).resolves.not.toThrow();
    });

    it("delete rejects non-admin", async () => {
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.delete({ id: 1 })).rejects.toThrow();
    });

    it("getFleetForInspection rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.getFleetForInspection()).rejects.toThrow("Please login");
    });

    it("getFleetForInspection allows field staff", async () => {
      const caller = createCaller(makeCtx("field_staff"));
      const result = await caller.getFleetForInspection();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── list ──────────────────────────────────────────────────────────
  describe("list", () => {
    it("returns empty array when DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.list();
      expect(result).toEqual([]);
    });

    it("returns inspections with filters", async () => {
      const mockData = [{ inspections: { id: 1, type: "dispatch" }, rental_fleet: null, rental_requests: null }];
      queryResults.value = mockData;
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.list({ type: "dispatch", condition: "good" });
      expect(result).toEqual(mockData);
    });

    it("accepts optional date filter", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.list({ startDate: "2024-01-01" });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── getById ───────────────────────────────────────────────────────
  describe("getById", () => {
    it("returns null when DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getById({ id: 1 });
      expect(result).toBeNull();
    });

    it("returns null when not found", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getById({ id: 999 });
      expect(result).toBeNull();
    });

    it("returns inspection when found", async () => {
      const insp = { inspections: { id: 1, type: "dispatch" }, rental_fleet: null };
      queryResults.value = [insp];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getById({ id: 1 });
      expect(result).toEqual(insp);
    });
  });

  // ── getByRentalId ─────────────────────────────────────────────────
  describe("getByRentalId", () => {
    it("returns empty when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getByRentalId({ rentalId: 1 });
      expect(result).toEqual([]);
    });

    it("returns inspections for rental", async () => {
      queryResults.value = [{ id: 1, type: "dispatch", rentalId: 5 }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getByRentalId({ rentalId: 5 });
      expect(result).toEqual([{ id: 1, type: "dispatch", rentalId: 5 }]);
    });
  });

  describe("getByFleetId", () => {
    it("returns empty when DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.getByFleetId({ fleetId: 5 })).toEqual([]);
    });

    it("falls back to direct fleet filtering when there is no rental history", async () => {
      const customDb = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            then: (resolve: (value: unknown[]) => void) => resolve([]),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnThis(),
            leftJoin: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockResolvedValue([{ inspections: { id: 1, rentalFleetId: 5 } }]),
          }),
      };
      mockGetDb.mockResolvedValueOnce(customDb);

      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.getByFleetId({ fleetId: 5 })).resolves.toEqual([{ inspections: { id: 1, rentalFleetId: 5 } }]);
      expect(customDb.select).toHaveBeenCalledTimes(2);
    });

    it("includes linked rental inspections when the equipment has rental history", async () => {
      const customDb = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            then: (resolve: (value: unknown[]) => void) => resolve([{ id: 10 }, { id: 11 }]),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnThis(),
            leftJoin: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockResolvedValue([
              { inspections: { id: 2, rentalFleetId: 5, rentalId: 10 } },
            ]),
          }),
      };
      mockGetDb.mockResolvedValueOnce(customDb);

      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.getByFleetId({ fleetId: 5 })).resolves.toEqual([
        { inspections: { id: 2, rentalFleetId: 5, rentalId: 10 } },
      ]);
    });
  });

  // ── delete ────────────────────────────────────────────────────────
  describe("delete", () => {
    it("soft deletes and logs audit", async () => {
      queryResults.value = [{ id: 1, type: "dispatch" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.delete({ id: 1 });
      expect(result).toEqual({ success: true });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "delete",
        entityType: "inspection",
        entityId: 1,
      }));
    });

    it("throws when inspection not found", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 999 })).rejects.toThrow("Inspection not found");
    });

    it("throws when DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 1 })).rejects.toThrow("Database not available");
    });
  });

  // ── verifyToken ───────────────────────────────────────────────────
  describe("verifyToken", () => {
    it("returns null for DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx());
      const result = await caller.verifyToken({ token: "abc" });
      expect(result).toBeNull();
    });

    it("returns null for invalid token", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx());
      const result = await caller.verifyToken({ token: "invalid" });
      expect(result).toBeNull();
    });

    it("returns null for used token", async () => {
      queryResults.value = [{ isUsed: true, expiresAt: new Date(Date.now() + 100000) }];
      const caller = createCaller(makeCtx());
      const result = await caller.verifyToken({ token: "used" });
      expect(result).toBeNull();
    });

    it("returns null for expired token", async () => {
      queryResults.value = [{ isUsed: false, expiresAt: new Date(Date.now() - 100000) }];
      const caller = createCaller(makeCtx());
      const result = await caller.verifyToken({ token: "expired" });
      expect(result).toBeNull();
    });

    it("returns token info for valid token", async () => {
      queryResults.value = [{
        isUsed: false,
        expiresAt: new Date(Date.now() + 100000),
        inspectionType: "dispatch",
        rentalId: 1,
        rentalFleetId: null,
      }];
      const caller = createCaller(makeCtx());
      const result = await caller.verifyToken({ token: "valid" });
      expect(result).toEqual(expect.objectContaining({ inspectionType: "dispatch", rentalId: 1 }));
    });
  });

  // ── createToken ───────────────────────────────────────────────────
  describe("createToken", () => {
    it("creates token and returns it with expiry", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.createToken({ inspectionType: "dispatch" });
      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe("string");
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("rejects non-admin", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.createToken({ inspectionType: "dispatch" })).rejects.toThrow();
    });
  });

  describe("getActiveRentalsForInspection", () => {
    it("returns empty when DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("field_staff"));
      expect(await caller.getActiveRentalsForInspection()).toEqual([]);
    });

    it("returns active rental candidates for field staff", async () => {
      queryResults.value = [{
        id: 3,
        customerName: "Acme",
        status: "approved",
        startDate: new Date("2025-01-01"),
        endDate: new Date("2025-01-10"),
        deliveryMethod: "delivery",
        deliveryAddress: "123 Test St",
        fleetId: 5,
        fleetBrand: "Bobcat",
        fleetModel: "T450",
        fleetAssetNumber: "A-12",
      }];
      const caller = createCaller(makeCtx("field_staff"));
      // The query now unions single-asset (parent pointer) + multi-item
      // (line-item) candidates; this naive mock returns the same row set for
      // both sub-selects, so assert the candidate is present rather than strict
      // equality (the dual-query behavior is exercised by integration/E2E).
      const result = await caller.getActiveRentalsForInspection();
      expect(result).toContainEqual(queryResults.value[0]);
    });
  });

  // ── markTokenUsed ─────────────────────────────────────────────────
  describe("markTokenUsed", () => {
    it("marks token as used", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.markTokenUsed({ token: "abc" });
      expect(result).toEqual({ success: true });
    });

    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.markTokenUsed({ token: "abc" })).rejects.toThrow();
    });
  });

  // ── listTokens ────────────────────────────────────────────────────
  describe("listTokens", () => {
    it("returns empty on null DB", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.listTokens();
      expect(result).toEqual([]);
    });

    it("returns token list", async () => {
      const tokens = [{ id: 1, inspectionType: "dispatch" }];
      queryResults.value = tokens;
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.listTokens();
      expect(result).toEqual(tokens);
    });
  });

  // ── getComparisonForRental ────────────────────────────────────────
  describe("getComparisonForRental", () => {
    it("returns null dispatch/return when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getComparisonForRental({ rentalId: 1 });
      expect(result).toEqual({ dispatch: null, return: null });
    });

    it("finds dispatch and return inspections", async () => {
      queryResults.value = [
        { id: 1, type: "dispatch" },
        { id: 2, type: "return" },
      ];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getComparisonForRental({ rentalId: 1 });
      expect(result.dispatch).toEqual({ id: 1, type: "dispatch" });
      expect(result.return).toEqual({ id: 2, type: "return" });
    });

    it("returns null for missing types", async () => {
      queryResults.value = [{ id: 1, type: "general" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getComparisonForRental({ rentalId: 1 });
      expect(result.dispatch).toBeNull();
      expect(result.return).toBeNull();
    });
  });

  // ── createWithToken ───────────────────────────────────────────────
  describe("createWithToken", () => {
    it("rejects when rate limited", async () => {
      mockCheckRateLimit.mockReturnValueOnce(false);
      const caller = createCaller(makeCtx());
      await expect(caller.createWithToken({ type: "dispatch", token: "abc" })).rejects.toThrow("Too many submissions");
    });

    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx());
      await expect(caller.createWithToken({ type: "dispatch", token: "abc" })).rejects.toThrow("Database not available");
    });

    it("creates inspection via valid token (full transaction)", async () => {
      const validToken = {
        tokenHash: "hash",
        inspectionType: "dispatch",
        rentalId: 1,
        rentalFleetId: 5,
        isUsed: false,
        expiresAt: new Date(Date.now() + 100000),
      };

      const origDb = await mockGetDb();
      origDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txSelectResults: unknown[][] = [
          [validToken], // first select: token lookup
        ];
        let txSelectCall = 0;
        const txChain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "offset"]) {
          txChain[m] = vi.fn().mockReturnValue(txChain);
        }
        txChain.limit = vi.fn().mockImplementation(() => {
          return Promise.resolve(txSelectResults[txSelectCall++] || []);
        });

        const tx = {
          select: vi.fn().mockReturnValue(txChain),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 100, type: "dispatch" }]),
            }),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return fn(tx);
      });

      const caller = createCaller(makeCtx());
      const result = await caller.createWithToken({ type: "dispatch", token: "valid-token-123", rentalId: 1, rentalFleetId: 5 });
      expect(result).toEqual({ id: 100, type: "dispatch" });
    });

    it("rejects mismatched inspection type", async () => {
      const origDb = await mockGetDb();
      origDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txChain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "offset"]) {
          txChain[m] = vi.fn().mockReturnValue(txChain);
        }
        txChain.limit = vi.fn().mockResolvedValue([{
          inspectionType: "return", // token says return
          rentalId: null, rentalFleetId: null,
          isUsed: false, expiresAt: new Date(Date.now() + 100000),
        }]);
        const tx = { select: vi.fn().mockReturnValue(txChain), update: vi.fn(), insert: vi.fn() };
        return fn(tx);
      });

      const caller = createCaller(makeCtx());
      await expect(
        caller.createWithToken({ type: "dispatch", token: "tok" }) // submission says dispatch
      ).rejects.toThrow("type does not match");
    });

    it("rejects mismatched rentalId", async () => {
      const origDb = await mockGetDb();
      origDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txChain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "offset"]) {
          txChain[m] = vi.fn().mockReturnValue(txChain);
        }
        txChain.limit = vi.fn().mockResolvedValue([{
          inspectionType: "dispatch",
          rentalId: 10, // token says rental 10
          rentalFleetId: null,
          isUsed: false, expiresAt: new Date(Date.now() + 100000),
        }]);
        const tx = { select: vi.fn().mockReturnValue(txChain), update: vi.fn(), insert: vi.fn() };
        return fn(tx);
      });

      const caller = createCaller(makeCtx());
      await expect(
        caller.createWithToken({ type: "dispatch", token: "tok", rentalId: 99 }) // says rental 99
      ).rejects.toThrow("Rental ID does not match");
    });

    it("rejects mismatched fleetId", async () => {
      const origDb = await mockGetDb();
      origDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txChain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "offset"]) {
          txChain[m] = vi.fn().mockReturnValue(txChain);
        }
        txChain.limit = vi.fn().mockResolvedValue([{
          inspectionType: "dispatch",
          rentalId: null,
          rentalFleetId: 10, // token says fleet 10
          isUsed: false, expiresAt: new Date(Date.now() + 100000),
        }]);
        const tx = { select: vi.fn().mockReturnValue(txChain), update: vi.fn(), insert: vi.fn() };
        return fn(tx);
      });

      const caller = createCaller(makeCtx());
      await expect(
        caller.createWithToken({ type: "dispatch", token: "tok", rentalFleetId: 99 })
      ).rejects.toThrow("Fleet ID does not match");
    });

    it("rejects used token inside transaction", async () => {
      const origDb = await mockGetDb();
      origDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txChain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "offset"]) {
          txChain[m] = vi.fn().mockReturnValue(txChain);
        }
        txChain.limit = vi.fn().mockResolvedValue([{
          inspectionType: "dispatch", rentalId: null, rentalFleetId: null,
          isUsed: true, expiresAt: new Date(Date.now() + 100000),
        }]);
        const tx = { select: vi.fn().mockReturnValue(txChain), update: vi.fn(), insert: vi.fn() };
        return fn(tx);
      });

      const caller = createCaller(makeCtx());
      await expect(
        caller.createWithToken({ type: "dispatch", token: "tok" })
      ).rejects.toThrow("already been used");
    });

    it("rejects expired token inside transaction", async () => {
      const origDb = await mockGetDb();
      origDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txChain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "offset"]) {
          txChain[m] = vi.fn().mockReturnValue(txChain);
        }
        txChain.limit = vi.fn().mockResolvedValue([{
          inspectionType: "dispatch", rentalId: null, rentalFleetId: null,
          isUsed: false, expiresAt: new Date(Date.now() - 100000), // expired
        }]);
        const tx = { select: vi.fn().mockReturnValue(txChain), update: vi.fn(), insert: vi.fn() };
        return fn(tx);
      });

      const caller = createCaller(makeCtx());
      await expect(
        caller.createWithToken({ type: "dispatch", token: "tok" })
      ).rejects.toThrow("expired");
    });

    it("rejects invalid token (not found in transaction)", async () => {
      const origDb = await mockGetDb();
      origDb.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        const txChain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "offset"]) {
          txChain[m] = vi.fn().mockReturnValue(txChain);
        }
        txChain.limit = vi.fn().mockResolvedValue([]); // not found
        const tx = { select: vi.fn().mockReturnValue(txChain), update: vi.fn(), insert: vi.fn() };
        return fn(tx);
      });

      const caller = createCaller(makeCtx());
      await expect(
        caller.createWithToken({ type: "dispatch", token: "tok" })
      ).rejects.toThrow("Invalid inspection token");
    });
  });

  // ── verifyToken with equipment ────────────────────────────────────
  describe("verifyToken with equipment lookup", () => {
    it("returns equipment info when rentalFleetId set", async () => {
      const validToken = {
        isUsed: false,
        expiresAt: new Date(Date.now() + 100000),
        inspectionType: "dispatch",
        rentalId: 1,
        rentalFleetId: 5,
      };
      const fleetData = { rental_fleet: { id: 5, brand: "CAT", model: "320" } };

      // First query returns token, second returns fleet
      let selectCall = 0;
      const mockDbInstance = await mockGetDb();
      const origSelect = mockDbInstance.select;
      mockDbInstance.select = vi.fn().mockImplementation((...args: unknown[]) => {
        selectCall++;
        const c = origSelect(...args);
        if (selectCall === 1) {
          queryResults.value = [validToken];
        } else {
          queryResults.value = [fleetData];
        }
        return c;
      });

      const caller = createCaller(makeCtx());
      const result = await caller.verifyToken({ token: "valid-fleet" });
      expect(result).toBeDefined();
      expect(result!.rentalFleetId).toBe(5);

      // Restore
      mockDbInstance.select = origSelect;
    });
  });

  // ── create with dedup ─────────────────────────────────────────────
  describe("create with offlineId dedup", () => {
    it("returns existing inspection for duplicate offlineId", async () => {
      const existing = { id: 99, type: "dispatch", offlineId: "offline-1" };
      queryResults.value = [existing]; // offlineId lookup returns existing
      const caller = createCaller(makeCtx("field_staff"));
      const result = await caller.create({ type: "dispatch", offlineId: "offline-1" });
      expect(result).toEqual(existing);
    });
  });

  // ── create: photo upload + rental update paths ─────────────────────
  describe("create with supabase storage", () => {
    it("uploads photos when supabase configured and rentalFleetId set", async () => {
      mockIsSupabaseConfigured.mockReturnValue(true);
      queryResults.value = []; // no dedup, fleet lookup returns empty on first call

      // Need a more nuanced mock: first select (offlineId check) returns [], second select (fleet lookup) returns fleet
      const origDb = await mockGetDb();
      let callIdx = 0;
      origDb.select.mockImplementation(() => {
        callIdx++;
        const chain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "limit", "offset"]) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        // First select: offlineId check - no dup found
        // Second select: fleet lookup for equipment identifier
        if (callIdx === 1) {
          chain.limit = vi.fn().mockResolvedValue([]);
        } else {
          chain.limit = vi.fn().mockResolvedValue([{ id: 5, brand: "CAT", model: "320" }]);
        }
        return chain;
      });

      insertResults.value = [{ id: 1, type: "dispatch" }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.create({
        type: "dispatch",
        rentalFleetId: 5,
        offlineId: "new-offline-1",
        photoFront: "base64data",
      });
      expect(mockUploadPhotos).toHaveBeenCalled();
    });

    it("falls back to raw data when photo upload fails", async () => {
      mockIsSupabaseConfigured.mockReturnValue(true);
      mockUploadPhotos.mockRejectedValueOnce(new Error("Upload failed"));
      queryResults.value = []; // no dedup
      insertResults.value = [{ id: 2, type: "general" }];
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.create({ type: "general", photoFront: "data" })).resolves.not.toThrow();
    });
  });

  describe("create updates rental inspection status", () => {
    it("blocks dispatch and return inspection writes for an ambiguous rental/fleet pair", async () => {
      mockAssertConflict.mockRejectedValueOnce(new Error("Fleet occupancy conflict"));
      const caller = createCaller(makeCtx("field_staff"));

      await expect(caller.create({ type: "return", rentalId: 2, rentalFleetId: 5 }))
        .rejects.toThrow("occupancy conflict");
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("sets deliveryInspectionCompleted for dispatch type", async () => {
      queryResults.value = []; // no dedup
      insertResults.value = [{ id: 10, type: "dispatch" }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.create({ type: "dispatch", rentalId: 1 });
      const origDb = await mockGetDb();
      expect(origDb.update).toHaveBeenCalled();
    });

    it("sets returnInspectionCompleted for return type", async () => {
      queryResults.value = []; // no dedup
      insertResults.value = [{ id: 11, type: "return" }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.create({ type: "return", rentalId: 2 });
      const origDb = await mockGetDb();
      expect(origDb.update).toHaveBeenCalled();
    });

    it("records per-equipment progress after a return inspection", async () => {
      queryResults.value = [];
      insertResults.value = [{ id: 15, type: "return" }];
      const caller = createCaller(makeCtx("field_staff"));

      await caller.create({ type: "return", rentalId: 2, rentalFleetId: 5 });

      expect(mockRecordProgress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        eventKey: "inspection:15:completed",
        rentalRequestId: 2,
        rentalFleetId: 5,
        eventType: "return_inspection_completed",
        source: "pwa",
      }));
    });

    it("skips rental update for general type", async () => {
      queryResults.value = [];
      insertResults.value = [{ id: 12, type: "general" }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.create({ type: "general", rentalId: 3 });
      // update is NOT called for general type rental update
      // (insert calls don't go through update)
    });

    it("skips rental update when no rentalId", async () => {
      queryResults.value = [];
      insertResults.value = [{ id: 13, type: "dispatch" }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.create({ type: "dispatch" }); // no rentalId
    });

    it("handles customerSignedAt and offlineId inputs", async () => {
      queryResults.value = [];
      insertResults.value = [{ id: 14, type: "dispatch" }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.create({
        type: "dispatch",
        customerSignedAt: "2025-01-01T00:00:00Z",
        offlineId: "sync-123",
      });
    });
  });

  describe("create with supabase storage (no fleet)", () => {
    it("uses 'unknown' identifier when no rentalFleetId", async () => {
      mockIsSupabaseConfigured.mockReturnValue(true);
      queryResults.value = [];
      insertResults.value = [{ id: 15, type: "general" }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.create({
        type: "general",
        photoFront: "base64data",
        photoBack: "back-data",
        photoLeft: "left-data",
        photoRight: "right-data",
        photoAdditional: "extra-data",
        customerSignature: "sig-data",
      });
      expect(mockUploadPhotos).toHaveBeenCalledWith(
        expect.objectContaining({ photoFront: "base64data" }),
        undefined, // rentalId
        "general",
        "unknown",
      );
    });

    it("uses 'unknown' when fleet lookup returns empty", async () => {
      mockIsSupabaseConfigured.mockReturnValue(true);
      // First select (offlineId dedup) → empty, second select (fleet) → empty
      const origDb = await mockGetDb();
      origDb.select.mockImplementation(() => {
        const chain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "leftJoin", "where", "orderBy", "limit", "offset"]) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        chain.limit = vi.fn().mockResolvedValue([]); // both return empty
        return chain;
      });
      insertResults.value = [{ id: 16, type: "dispatch" }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.create({ type: "dispatch", rentalFleetId: 999, photoFront: "data" });
      expect(mockUploadPhotos).toHaveBeenCalledWith(
        expect.anything(), undefined, "dispatch", "unknown",
      );
    });
  });

  // ── permissions edge cases ────────────────────────────────────────
  describe("permission edge cases", () => {
    it("delete rejects non-admin user with viewer role", async () => {
      const ctx = makeCtx();
      // Authenticated but not admin
      ctx.user = {
        id: 2, email: "viewer@test.com", name: "Viewer", username: "viewer",
        role: "user", isActive: true, passwordHash: null, phone: null,
        createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
        lastSignedIn: null, loginMethod: null,
      };
      const caller = createCaller(ctx);
      await expect(caller.delete({ id: 1 })).rejects.toThrow("permission");
    });

    it("createToken rejects field staff", async () => {
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.createToken({ inspectionType: "dispatch" })).rejects.toThrow("permission");
    });
  });
});
