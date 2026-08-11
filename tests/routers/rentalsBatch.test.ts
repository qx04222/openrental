/**
 * Rental Requests Router — batchUpdateStatus tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockGetDb, queryResults, mockLogAudit, mockCheckAvail, mockAssignFleet, mockReleaseFleet } = vi.hoisted(() => {
  const queryResults: { value: unknown[] } = { value: [] };

  // Extract an id equality (eq on the "id" column) from a possibly-nested
  // where clause so the chain can resolve only the matching rental — lets the
  // per-id SELECT inside transitionRentalStatus return [] for unknown ids.
  const extractId = (clause: unknown): number | undefined => {
    if (!clause || typeof clause !== "object") return undefined;
    const c = clause as { __op?: string; col?: unknown; val?: unknown; args?: unknown[] };
    if (c.__op === "eq" && c.col === "id" && typeof c.val === "number") return c.val;
    if (c.__op === "and" && Array.isArray(c.args)) {
      for (const a of c.args) {
        const found = extractId(a);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  const createChain = () => {
    let whereId: number | undefined;
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["select", "from", "leftJoin", "orderBy", "limit", "offset", "insert", "values", "returning", "update", "set", "delete"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.where = vi.fn().mockImplementation((clause: unknown) => {
      whereId = extractId(clause);
      return chain;
    });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => {
      const rows = [...queryResults.value] as Array<{ id?: number }>;
      resolve(whereId !== undefined ? rows.filter((r) => r.id === whereId) : rows);
    };
    return chain;
  };

  const chain = createChain();

  const mockDb = {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(chain),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txChain = createChain();
      const tx = {
        select: vi.fn().mockReturnValue(txChain),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          }),
        }),
        update: vi.fn().mockReturnValue(txChain),
      };
      return fn(tx);
    }),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    queryResults,
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
    mockCheckAvail: vi.fn().mockResolvedValue({ isAvailable: true, conflicting: [] }),
    mockAssignFleet: vi.fn().mockResolvedValue({ success: true }),
    mockReleaseFleet: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Module mocks ───────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  // Return tagged clause objects so the chain mock can recover an id-equality
  // and resolve only the matching rental (see createChain/extractId).
  eq: vi.fn((col: unknown, val: unknown) => ({ __op: "eq", col, val })),
  and: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  or: vi.fn((...args: unknown[]) => ({ __op: "or", args })),
  desc: vi.fn((..._a: unknown[]) => "desc"),
  isNull: vi.fn((col: unknown) => ({ __op: "isNull", col })),
  inArray: vi.fn((..._a: unknown[]) => "inArray"),
  sql: vi.fn((..._a: unknown[]) => "sql"),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    rentalRequests: {
      id: col("id"), status: col("status"), customerName: col("customerName"),
      customerEmail: col("customerEmail"), customerPhone: col("customerPhone"),
      customerCompany: col("customerCompany"), rentalFleetId: col("rentalFleetId"),
      customerId: col("customerId"), startDate: col("startDate"), endDate: col("endDate"),
      deletedAt: col("deletedAt"), createdAt: col("createdAt"), updatedAt: col("updatedAt"),
      lifecycleVersion: col("lifecycleVersion"),
      deliveryMethod: col("deliveryMethod"), deliveryAddress: col("deliveryAddress"),
      deliveryProvince: col("deliveryProvince"), pickupProvince: col("pickupProvince"),
      taxProvince: col("taxProvince"), insuranceType: col("insuranceType"),
      insuranceCost: col("insuranceCost"), freightCost: col("freightCost"),
      taxAmount: col("taxAmount"), taxBreakdown: col("taxBreakdown"),
      rentalFee: col("rentalFee"), depositAmount: col("depositAmount"),
      totalAmount: col("totalAmount"), projectDescription: col("projectDescription"),
      deliveryNotes: col("deliveryNotes"), customerNotes: col("customerNotes"),
      adminNotes: col("adminNotes"), contractUrl: col("contractUrl"),
      contractGenerated: col("contractGenerated"), contractGeneratedAt: col("contractGeneratedAt"),
      contractVersion: col("contractVersion"), equipmentDescription: col("equipmentDescription"),
      deliveryInspectionCompleted: col("deliveryInspectionCompleted"),
      deliveryInspectionId: col("deliveryInspectionId"),
      returnInspectionCompleted: col("returnInspectionCompleted"),
      returnInspectionId: col("returnInspectionId"),
    },
    rentalFleet: { id: col("id"), brand: col("brand"), model: col("model"), category: col("category"), assetNumber: col("assetNumber"), locationId: col("locationId"), deletedAt: col("deletedAt") },
    rentalLineItems: {
      id: col("id"), rentalRequestId: col("rentalRequestId"), rentalFleetId: col("rentalFleetId"),
      equipmentModelId: col("equipmentModelId"), itemType: col("itemType"), quantity: col("quantity"),
      customerEquipmentNote: col("customerEquipmentNote"), startDate: col("startDate"), endDate: col("endDate"),
      lineSubtotal: col("lineSubtotal"), deletedAt: col("deletedAt"),
    },
    equipmentModels: { id: col("id"), brand: col("brand"), model: col("model"), category: col("category"), deletedAt: col("deletedAt") },
    warehouses: { id: col("id"), name: col("name"), address: col("address"), deletedAt: col("deletedAt") },
    customers: {
      id: col("id"), email: col("email"), name: col("name"), phone: col("phone"),
      company: col("company"), updatedAt: col("updatedAt"),
      totalRentals: col("totalRentals"), totalRevenue: col("totalRevenue"), lastRentalDate: col("lastRentalDate"),
    },
    dispatchOrders: {
      orderType: col("orderType"), rentalRequestId: col("rentalRequestId"),
      rentalFleetId: col("rentalFleetId"), customerId: col("customerId"),
      status: col("status"), deletedAt: col("deletedAt"),
      scheduledDate: col("scheduledDate"), deliveryAddress: col("deliveryAddress"),
      pickupAddress: col("pickupAddress"), shippingCost: col("shippingCost"),
      notes: col("notes"),
    },
    inspections: {
      rentalId: col("rentalId"), rentalFleetId: col("rentalFleetId"),
      type: col("type"), deletedAt: col("deletedAt"),
    },
    rentalLifecycleEffects: {
      commandKey: col("commandKey"), rentalRequestId: col("rentalRequestId"),
      effectType: col("effectType"), status: col("status"), payload: col("payload"),
      attempts: col("attempts"), nextAttemptAt: col("nextAttemptAt"),
    },
    rentalAssetProgressEvents: {
      rentalRequestId: col("rentalRequestId"), rentalFleetId: col("rentalFleetId"),
      eventType: col("eventType"),
    },
    auditLogs: {
      id: col("id"), action: col("action"), changes: col("changes"), metadata: col("metadata"),
      createdAt: col("createdAt"), entityType: col("entityType"), entityId: col("entityId"), userId: col("userId"),
    },
    users: { id: col("id"), name: col("name"), username: col("username") },
    rolePermissions: {
      id: col("id"), role: col("role"), module: col("module"),
      canCreate: col("canCreate"), canRead: col("canRead"), canUpdate: col("canUpdate"), canDelete: col("canDelete"),
      createdAt: col("createdAt"), updatedAt: col("updatedAt"),
    },
    userPermissionOverrides: {
      id: col("id"), userId: col("userId"), module: col("module"),
      canCreate: col("canCreate"), canRead: col("canRead"), canUpdate: col("canUpdate"), canDelete: col("canDelete"),
      createdAt: col("createdAt"),
    },
    referralCodes: { id: col("id"), code: col("code"), isActive: col("isActive"), totalUses: col("totalUses"), totalCommission: col("totalCommission"), promotionId: col("promotionId"), driverId: col("driverId") },
    promotions: { id: col("id"), isActive: col("isActive"), deletedAt: col("deletedAt"), startDate: col("startDate"), endDate: col("endDate"), discountPercent: col("discountPercent"), commissionPercent: col("commissionPercent"), maxUsesPerCode: col("maxUsesPerCode") },
    referralLedger: { id: col("id") },
  };
});

vi.mock("../../server/services/auditLog", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("../../server/services/rentalStatusSync", () => ({
  checkDateRangeAvailability: (...args: unknown[]) => mockCheckAvail(...args),
  assignFleetAssetToRental: (...args: unknown[]) => mockAssignFleet(...args),
  releaseFleetAsset: (...args: unknown[]) => mockReleaseFleet(...args),
}));

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../server/services/contractPDF", () => ({
  generateContractPDF: vi.fn().mockResolvedValue({ url: "https://test.com/contract.pdf" }),
}));

vi.mock("../../server/services/notifications", () => ({
  notifyOnEvent: vi.fn().mockResolvedValue(undefined),
  sendOrderConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));

// ── Import router ──────────────────────────────────────────────────────
import { rentalRequestsRouter } from "../../server/routers/rentalRequests.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(rentalRequestsRouter);

function makeCtx(role?: string): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: role ? {
      id: 1, email: "admin@test.com", name: "Admin", username: "admin",
      role: role as "admin", isActive: true, passwordHash: null, phone: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      lastSignedIn: null, loginMethod: null,
    } : null,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────
describe("rentalRequests.batchUpdateStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
  });

  it("rejects unauthenticated callers", async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.batchUpdateStatus({ ids: [1, 2], status: "approved" })
    ).rejects.toThrow("Please login");
  });

  it("rejects input with more than 100 ids", async () => {
    const caller = createCaller(makeCtx("super_admin"));
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    await expect(
      caller.batchUpdateStatus({ ids, status: "approved" })
    ).rejects.toThrow();
  });

  it("rejects empty ids array", async () => {
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.batchUpdateStatus({ ids: [], status: "approved" })
    ).rejects.toThrow();
  });

  it("throws when DB is null", async () => {
    mockGetDb.mockResolvedValueOnce(null);
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.batchUpdateStatus({ ids: [1], status: "approved" })
    ).rejects.toThrow("Database not available");
  });

  it("returns successIds for all-valid transitions", async () => {
    queryResults.value = [
      { id: 1, status: "pending", customerName: "A", rentalFleetId: null, deletedAt: null },
      { id: 2, status: "pending", customerName: "B", rentalFleetId: null, deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchUpdateStatus({ ids: [1, 2], status: "approved" });
    expect(result.successIds).toEqual(expect.arrayContaining([1, 2]));
    expect(result.failedIds).toHaveLength(0);
  });

  it("reports failedIds for ids not found in DB", async () => {
    // DB returns only rental 1, rental 999 not found
    queryResults.value = [
      { id: 1, status: "pending", customerName: "A", rentalFleetId: null, deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchUpdateStatus({ ids: [1, 999], status: "approved" });
    expect(result.successIds).toContain(1);
    expect(result.failedIds.some((f) => f.id === 999 && f.reason.includes("not found"))).toBe(true);
  });

  it("reports failedIds for invalid state transitions", async () => {
    queryResults.value = [
      { id: 1, status: "completed", customerName: "A", rentalFleetId: null, deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchUpdateStatus({ ids: [1], status: "pending" });
    expect(result.successIds).toHaveLength(0);
    expect(result.failedIds[0].id).toBe(1);
    expect(result.failedIds[0].reason).toMatch(/Cannot transition/);
  });

  it("treats already-at-target-status as success (idempotent)", async () => {
    queryResults.value = [
      { id: 5, status: "approved", customerName: "C", rentalFleetId: null, deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchUpdateStatus({ ids: [5], status: "approved" });
    expect(result.successIds).toContain(5);
    expect(result.failedIds).toHaveLength(0);
  });

  it("handles mixed success and failure (some not found, some invalid)", async () => {
    queryResults.value = [
      { id: 1, status: "pending", customerName: "A", rentalFleetId: null, deletedAt: null },
      { id: 2, status: "completed", customerName: "B", rentalFleetId: null, deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchUpdateStatus({ ids: [1, 2, 999], status: "approved" });
    // id 1: pending -> approved = valid
    expect(result.successIds).toContain(1);
    // id 2: completed -> approved = invalid
    expect(result.failedIds.some((f) => f.id === 2)).toBe(true);
    // id 999: not found
    expect(result.failedIds.some((f) => f.id === 999)).toBe(true);
  });

  it("reports transaction DB error as failed id without throwing", async () => {
    // Return rental so the rental is found and transition is valid
    queryResults.value = [
      { id: 1, status: "pending", customerName: "A", rentalFleetId: null, deletedAt: null },
    ];

    // Make transaction throw for this call only
    const db = await mockGetDb();
    vi.mocked(db.transaction).mockRejectedValueOnce(new Error("DB connection lost"));

    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchUpdateStatus({ ids: [1], status: "approved" });
    expect(result.failedIds[0].id).toBe(1);
    expect(result.failedIds[0].reason).toMatch(/DB connection lost/);
    expect(result.successIds).toHaveLength(0);
  });
});
