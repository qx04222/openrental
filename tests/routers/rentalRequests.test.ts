/**
 * Rental Requests Router — integration tests via tRPC createCallerFactory
 * Tests state machine, permissions, date validation, availability checks, delete guards
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockGetDb, queryResults, insertResults, fleetClaimResults, txInsertedValues, queryChain, mockLogAudit, mockCheckAvail, mockAssignFleet, mockReleaseFleet } = vi.hoisted(() => {
  const queryResults: { value: unknown[] } = { value: [] };
  const insertResults: { value: unknown[] } = { value: [] };
  const fleetClaimResults: { value: unknown[] | null } = { value: null };
  const txInsertedValues: unknown[] = [];

  const createChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["select", "from", "leftJoin", "where", "orderBy", "limit", "offset", "insert", "values", "returning", "update", "set", "delete"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    let selectedTable: unknown;
    chain.from.mockImplementation((table: unknown) => {
      selectedTable = table;
      return chain;
    });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(
      (selectedTable as { __table?: string } | undefined)?.__table === "rentalRollingTerms"
        || (selectedTable as { __table?: string } | undefined)?.__table === "rentalAssetReturnOperations"
        ? []
        : [...queryResults.value],
    );
    return chain;
  };

  const chain = createChain();

  const mockDb = {
    select: vi.fn().mockReturnValue(chain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => Promise.resolve([...insertResults.value])),
      }),
    }),
    update: vi.fn().mockReturnValue(chain),
    delete: vi.fn().mockReturnValue(chain),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      // Transaction mock — create a tx that behaves like db
      const txChain = createChain();
      const tx = {
        select: vi.fn().mockReturnValue(txChain),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((value: unknown) => {
            txInsertedValues.push(value);
            return {
            returning: vi.fn().mockImplementation(() => Promise.resolve([...insertResults.value])),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            };
          }),
        }),
        update: vi.fn().mockImplementation((table: { __table?: string }) => ({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockImplementation(() => Promise.resolve([
                ...(table?.__table === "rentalFleet" && fleetClaimResults.value !== null
                  ? fleetClaimResults.value
                  : insertResults.value),
              ])),
              then: (resolve: (v: unknown) => void) => resolve([...insertResults.value]),
            }),
          }),
        })),
      };
      return fn(tx);
    }),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    queryChain: chain,
    queryResults,
    insertResults,
    fleetClaimResults,
    txInsertedValues,
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
    mockCheckAvail: vi.fn().mockResolvedValue({ isAvailable: true, conflicting: [] }),
    mockAssignFleet: vi.fn().mockResolvedValue({ success: true }),
    mockReleaseFleet: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Module mocks ───────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  ne: vi.fn((..._a: unknown[]) => "ne"),
  and: vi.fn((..._a: unknown[]) => "and"),
  or: vi.fn((..._a: unknown[]) => "or"),
  desc: vi.fn((..._a: unknown[]) => "desc"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
  inArray: vi.fn((..._a: unknown[]) => "inArray"),
  sql: vi.fn((..._a: unknown[]) => "sql"),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    rentalRequests: {
      __table: "rentalRequests",
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
    rentalLineItems: {
      id: col("id"), rentalRequestId: col("rentalRequestId"), rentalFleetId: col("rentalFleetId"),
      equipmentModelId: col("equipmentModelId"), itemType: col("itemType"), quantity: col("quantity"),
      dailyRate: col("dailyRate"), weeklyRate: col("weeklyRate"), monthlyRate: col("monthlyRate"),
      customerEquipmentNote: col("customerEquipmentNote"), compatibilityAcknowledgedAt: col("compatibilityAcknowledgedAt"),
      startDate: col("startDate"), endDate: col("endDate"), lineDeposit: col("lineDeposit"),
      lineSubtotal: col("lineSubtotal"), createdAt: col("createdAt"), updatedAt: col("updatedAt"),
      deletedAt: col("deletedAt"),
    },
    rentalFleet: { __table: "rentalFleet", id: col("id"), brand: col("brand"), model: col("model"), category: col("category"), assetNumber: col("assetNumber"), locationId: col("locationId"), currentStatus: col("currentStatus"), updatedAt: col("updatedAt"), deletedAt: col("deletedAt") },
    equipmentModels: { id: col("id"), brand: col("brand"), model: col("model"), category: col("category"), deletedAt: col("deletedAt") },
    warehouses: { id: col("id"), name: col("name"), address: col("address") },
    customers: { id: col("id"), email: col("email"), name: col("name"), phone: col("phone"), company: col("company"), updatedAt: col("updatedAt") },
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
    rentalRollingTerms: {
      __table: "rentalRollingTerms",
      id: col("id"), rentalRequestId: col("rentalRequestId"), status: col("status"),
    },
    rentalAssetReturnOperations: {
      __table: "rentalAssetReturnOperations",
      rentalRequestId: col("rentalRequestId"), rentalFleetId: col("rentalFleetId"),
      pickedUpAt: col("pickedUpAt"),
    },
    auditLogs: { id: col("id"), action: col("action"), changes: col("changes"), metadata: col("metadata"), createdAt: col("createdAt"), entityType: col("entityType"), entityId: col("entityId"), userId: col("userId") },
    invoices: { id: col("id"), invoiceNumber: col("invoiceNumber"), rentalId: col("rentalId"), type: col("type"), status: col("status"), deletedAt: col("deletedAt") },
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
}));

// ── Import router + create caller ──────────────────────────────────────
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
describe("rentalRequests router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
    insertResults.value = [];
    fleetClaimResults.value = null;
    txInsertedValues.length = 0;
    mockCheckAvail.mockResolvedValue({ isAvailable: true, conflicting: [] });
  });

  // ── Permissions ───────────────────────────────────────────────────
  describe("permissions", () => {
    it("list rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.list()).rejects.toThrow("Please login");
    });

    it("list allows admin", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.list();
      expect(Array.isArray(result)).toBe(true);
    });

    it("create is public (allows unauthenticated)", async () => {
      insertResults.value = [{ id: 1, customerName: "Test" }];
      const caller = createCaller(makeCtx());
      const result = await caller.create({
        customerName: "Test",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      });
      expect(result).toBeDefined();
    });

    it("adminCreate rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.adminCreate({
        customerName: "Test",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      })).rejects.toThrow("Please login");
    });

    it("updateStatus rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.updateStatus({ id: 1, status: "approved" })).rejects.toThrow("Please login");
    });

    it("delete rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.delete({ id: 1 })).rejects.toThrow("Please login");
    });

    it("checkAvailability is public", async () => {
      const caller = createCaller(makeCtx());
      const result = await caller.checkAvailability({
        rentalFleetId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      });
      expect(result).toBeDefined();
    });
  });

  // ── list ──────────────────────────────────────────────────────────
  describe("list", () => {
    it("returns empty when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.list()).toEqual([]);
    });

    it("filters by status", async () => {
      queryResults.value = [{ rental_requests: { id: 1, status: "pending" } }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.list({ status: "pending" });
      expect(result.length).toBe(1);
    });

    it("includes the rolling term in each rental list row", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      await caller.list();
      expect(queryChain.leftJoin).toHaveBeenCalledWith(
        expect.objectContaining({ __table: "rentalRollingTerms" }),
        expect.anything(),
      );
    });
  });

  // ── create (public) ──────────────────────────────────────────────
  describe("create", () => {
    it("validates dates — start must be before end", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.create({
        customerName: "Test",
        startDate: "2025-01-10",
        endDate: "2025-01-01",
      })).rejects.toThrow("Start date must be before end date");
    });

    it("validates dates — invalid format", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.create({
        customerName: "Test",
        startDate: "not-a-date",
        endDate: "2025-01-10",
      })).rejects.toThrow("Invalid date format");
    });

    it("checks availability when fleet specified", async () => {
      mockCheckAvail.mockResolvedValueOnce({ isAvailable: false, conflicting: [1] });
      const caller = createCaller(makeCtx());
      await expect(caller.create({
        customerName: "Test",
        rentalFleetId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      })).rejects.toThrow("Equipment not available");
    });

    it("creates customer on new email", async () => {
      insertResults.value = [{ id: 1, customerName: "Test" }];
      queryResults.value = []; // no existing customer
      const caller = createCaller(makeCtx());
      await caller.create({
        customerName: "Test",
        customerEmail: "new@test.com",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      });
      expect(mockGetDb).toHaveBeenCalled();
    });

    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx());
      await expect(caller.create({
        customerName: "Test",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      })).rejects.toThrow("Database not available");
    });
  });

  // ── adminCreate customer dedup (customerId precedence) ────────────
  describe("adminCreate dedup", () => {
    it("throws NOT_FOUND when supplied customerId does not exist", async () => {
      queryResults.value = []; // picked customer not found / deleted
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreate({
        customerId: 999,
        customerName: "X",
        customerPhone: "1",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      })).rejects.toThrow("Selected customer not found");
    });
  });

  // ── adminCreateWithItems (one-order-multiple-units) ───────────────
  describe("adminCreateWithItems", () => {
    const baseItems = [{ equipmentModelId: 1, availableFleetIds: [10], itemType: "machine" as const, quantity: 1 }];

    it("rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.adminCreateWithItems({
        customerName: "X", startDate: "2025-01-01", endDate: "2025-01-10", items: baseItems,
      })).rejects.toThrow("Please login");
    });

    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreateWithItems({
        customerName: "X", startDate: "2025-01-01", endDate: "2025-01-10", items: baseItems,
      })).rejects.toThrow("Database not available");
    });

    it("validates dates (start before end)", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreateWithItems({
        customerName: "X", startDate: "2025-01-10", endDate: "2025-01-01", items: baseItems,
      })).rejects.toThrow("Start date must be before end date");
    });

    it("throws CONFLICT when a machine item has no available unit", async () => {
      mockCheckAvail.mockResolvedValue({ isAvailable: false, conflicting: [10] });
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreateWithItems({
        customerName: "X", startDate: "2025-01-01", endDate: "2025-01-10", items: baseItems,
      })).rejects.toThrow("Not enough units available");
    });

    it("dedup: throws NOT_FOUND when supplied customerId does not exist", async () => {
      queryResults.value = []; // picked customer not found
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreateWithItems({
        customerId: 999, customerName: "X", startDate: "2025-01-01", endDate: "2025-01-10", items: baseItems,
      })).rejects.toThrow("Selected customer not found");
    });

    it("validates a per-line rental period (line start before end)", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreateWithItems({
        customerName: "X", startDate: "2025-01-01", endDate: "2025-01-10",
        items: [{ equipmentModelId: 1, availableFleetIds: [10], itemType: "machine", quantity: 1, startDate: "2025-02-10", endDate: "2025-02-01" }],
      })).rejects.toThrow("Start date must be before end date");
    });
  });

  // ── updateStatus (state machine) ─────────────────────────────────
  describe("updateStatus", () => {
    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "approved" })).rejects.toThrow("Database not available");
    });

    it("throws NOT_FOUND for missing rental", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 999, status: "approved" })).rejects.toThrow("Rental not found");
    });

    it("rejects invalid state transition (completed → pending)", async () => {
      queryResults.value = [{
        id: 1, status: "completed", customerName: "Test",
        rentalFleetId: null, deliveryMethod: "pickup",
        startDate: new Date(), endDate: new Date(),
      }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "pending" })).rejects.toThrow("Cannot transition");
    });

    it("rejects invalid state transition (cancelled → active)", async () => {
      queryResults.value = [{
        id: 1, status: "cancelled", customerName: "Test",
        rentalFleetId: null, deliveryMethod: "pickup",
        startDate: new Date(), endDate: new Date(),
      }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "active" })).rejects.toThrow("Cannot transition");
    });

    it("allows valid transition (pending → approved)", async () => {
      const rental = {
        id: 1, status: "pending", customerName: "Test",
        rentalFleetId: 5, deliveryMethod: "delivery",
        deliveryAddress: "123 St", customerId: 1,
        startDate: new Date("2025-01-01"), endDate: new Date("2025-01-10"),
        customerEmail: "test@test.com", customerPhone: "555-1234",
        customerCompany: "Co", freightCost: "100",
        projectDescription: "Test project",
      };
      queryResults.value = [rental];
      insertResults.value = [{ ...rental, status: "approved" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.updateStatus({ id: 1, status: "approved" });
      expect(result).toBeDefined();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "status_change",
        entityType: "rental",
      }));
    });

    it("reports a conflict when another request wins the status update", async () => {
      queryResults.value = [{
        id: 1, status: "pending", customerName: "Test",
        rentalFleetId: null, deliveryMethod: "pickup",
        startDate: new Date("2025-01-01"), endDate: new Date("2025-01-10"),
        updatedAt: new Date("2025-01-02"),
      }];
      insertResults.value = [];

      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "approved" })).rejects.toThrow(/changed by another request/i);
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("treats same-status updates as idempotent", async () => {
      const rental = {
        id: 1, status: "approved", customerName: "Test",
        rentalFleetId: null, deliveryMethod: "pickup",
        startDate: new Date("2025-01-01"), endDate: new Date("2025-01-10"),
        customerEmail: "test@test.com", customerPhone: "555-1234",
      };
      queryResults.value = [rental];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.updateStatus({ id: 1, status: "approved" });
      expect(result).toEqual(expect.objectContaining({
        rental,
        idempotent: true,
        failures: expect.any(Array),
      }));
      // Idempotent transition is a true no-op now: no audit entry, no side
      // effects (previously it re-logged and could re-fire invoice/quotation
      // generation, e.g. completed→completed regenerating an invoice).
      expect(mockLogAudit).not.toHaveBeenCalled();
      expect(mockAssignFleet).not.toHaveBeenCalled();
      expect(mockReleaseFleet).not.toHaveBeenCalled();
    });

    it("rejects invalid transition (rejected → active)", async () => {
      queryResults.value = [{
        id: 1, status: "rejected", customerName: "Test",
        rentalFleetId: null, deliveryMethod: "pickup",
        startDate: new Date(), endDate: new Date(),
      }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "active" })).rejects.toThrow("Cannot transition");
    });
  });

  // ── updateStatus side effects ─────────────────────────────────────
  describe("updateStatus (side effects)", () => {
    const baseRental = {
      id: 1, customerName: "Test", customerEmail: "test@test.com",
      customerPhone: "555", customerCompany: "Co",
      rentalFleetId: 5, deliveryMethod: "delivery",
      deliveryAddress: "123 St", customerId: 1,
      startDate: new Date("2025-01-01"), endDate: new Date("2025-01-10"),
      freightCost: "100", rentalFee: "500", insuranceCost: "50",
      taxAmount: "80", totalAmount: "730",
      projectDescription: "Test", contractVersion: 1,
      returnInspectionCompleted: true,
    };

    it("auto-creates delivery + return dispatch for delivery_and_return", async () => {
      queryResults.value = [{ ...baseRental, status: "pending", deliveryMethod: "delivery_and_return" }];
      insertResults.value = [{ ...baseRental, status: "approved" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "approved" });
      // The transaction should insert 2 dispatch orders
      expect(mockLogAudit).toHaveBeenCalled();
    });

    it("records entry-pending progress evidence for every fleet unit on approval", async () => {
      queryResults.value = [{ ...baseRental, status: "pending", deliveryMethod: "pickup" }];
      insertResults.value = [{ ...baseRental, status: "approved" }];

      await createCaller(makeCtx("super_admin")).updateStatus({ id: 1, status: "approved" });

      expect(txInsertedValues).toContainEqual(expect.objectContaining({
        rentalRequestId: 1,
        rentalFleetId: 5,
        eventType: "entry_pending",
      }));
    });

    it("auto-creates only delivery dispatch for delivery method", async () => {
      queryResults.value = [{ ...baseRental, status: "pending", deliveryMethod: "delivery" }];
      insertResults.value = [{ ...baseRental, status: "approved" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "approved" });
      expect(mockLogAudit).toHaveBeenCalled();
    });

    it("skips dispatch orders for pickup delivery method", async () => {
      queryResults.value = [{ ...baseRental, status: "pending", deliveryMethod: "pickup" }];
      insertResults.value = [{ ...baseRental, status: "approved" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "approved" });
      expect(mockLogAudit).toHaveBeenCalled();
    });

    it("assigns fleet when transitioning to active", async () => {
      queryResults.value = [{ ...baseRental, status: "approved" }];
      insertResults.value = [{ ...baseRental, status: "active" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.updateStatus({ id: 1, status: "active" });
      expect(result.sideEffects.fleetAssigned).toEqual([5]);
      expect(mockAssignFleet).not.toHaveBeenCalled();
    });

    it("rejects activation when fleet cannot be claimed in the core transaction", async () => {
      queryResults.value = [{ ...baseRental, status: "approved" }];
      insertResults.value = [{ ...baseRental, status: "active" }];
      fleetClaimResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "active" })).rejects.toThrow(
        "Fleet asset 5 is no longer operationally available",
      );
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("releases fleet when transitioning to completed", async () => {
      queryResults.value = [{ ...baseRental, status: "active" }];
      insertResults.value = [{ ...baseRental, status: "completed" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "completed" });
      // now order-aware: passes the closing rentalId so release skips units a
      // different active order still holds.
      expect(mockReleaseFleet).toHaveBeenCalledWith(5, 1);
    });

    it("records completed progress evidence per fleet unit", async () => {
      queryResults.value = [{ ...baseRental, status: "active" }];
      insertResults.value = [{ ...baseRental, status: "completed" }];

      await createCaller(makeCtx("super_admin")).updateStatus({ id: 1, status: "completed" });

      expect(txInsertedValues).toContainEqual(expect.objectContaining({
        rentalRequestId: 1,
        rentalFleetId: 5,
        eventType: "completed",
      }));
    });

    it("releases fleet when transitioning to cancelled", async () => {
      queryResults.value = [{ ...baseRental, status: "active" }];
      insertResults.value = [{ ...baseRental, status: "cancelled" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "cancelled" });
      expect(mockReleaseFleet).toHaveBeenCalledWith(5, 1);
    });

    it("skips fleet release when no rentalFleetId", async () => {
      queryResults.value = [{ ...baseRental, status: "active", rentalFleetId: null }];
      insertResults.value = [{ ...baseRental, status: "completed", rentalFleetId: null }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "completed" });
      expect(mockReleaseFleet).not.toHaveBeenCalled();
    });

    it("handles notification failure gracefully", async () => {
      queryResults.value = [{ ...baseRental, status: "pending", rentalFleetId: null, deliveryMethod: "pickup" }];
      insertResults.value = [{ ...baseRental, status: "rejected" }];
      // Override notification mock to fail
      const notifyMock = await import("../../server/services/notifications");
      vi.mocked(notifyMock.notifyOnEvent).mockRejectedValueOnce(new Error("Notification failed"));
      const caller = createCaller(makeCtx("super_admin"));
      // Should not throw despite notification failure
      await expect(caller.updateStatus({ id: 1, status: "rejected" })).resolves.toBeDefined();
    });

    it("handles contract generation failure gracefully", async () => {
      queryResults.value = [{ ...baseRental, status: "pending" }];
      insertResults.value = [{ ...baseRental, status: "approved" }];
      const contractMock = await import("../../server/services/contractPDF");
      vi.mocked(contractMock.generateContractPDF).mockRejectedValueOnce(new Error("PDF failed"));
      const caller = createCaller(makeCtx("super_admin"));
      // Should not throw despite contract failure
      await expect(caller.updateStatus({ id: 1, status: "approved" })).resolves.toBeDefined();
    });

    it("skips contract generation when no rentalFleetId", async () => {
      queryResults.value = [{ ...baseRental, status: "pending", rentalFleetId: null, deliveryMethod: "pickup" }];
      insertResults.value = [{ ...baseRental, status: "approved", rentalFleetId: null }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "approved" });
      // No contract generated (no fleet), but audit + notification still happen
      expect(mockLogAudit).toHaveBeenCalled();
    });

    it("handles null customer fields in notification/contract", async () => {
      // All customer fields null to exercise || fallbacks
      const nullFieldsRental = {
        ...baseRental, status: "pending",
        customerEmail: null, customerPhone: null,
        customerCompany: null, freightCost: null,
        rentalFee: null, insuranceCost: null, taxAmount: null,
        totalAmount: null, deliveryAddress: null, projectDescription: null,
      };
      queryResults.value = [nullFieldsRental];
      insertResults.value = [{ ...nullFieldsRental, status: "approved" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "approved" });
      expect(mockLogAudit).toHaveBeenCalled();
    });

    it("skips fleet assignment when transitioning to active without fleet", async () => {
      queryResults.value = [{ ...baseRental, status: "approved", rentalFleetId: null }];
      insertResults.value = [{ ...baseRental, status: "active", rentalFleetId: null }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "active" });
      expect(mockAssignFleet).not.toHaveBeenCalled();
    });
  });

  // ── delete ────────────────────────────────────────────────────────
  describe("delete", () => {
    it("soft deletes completed rental", async () => {
      queryResults.value = [{ id: 1, status: "completed", customerName: "Test" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.delete({ id: 1 });
      expect(result).toEqual({ success: true });
      expect(mockLogAudit).toHaveBeenCalled();
    });

    it("soft deletes cancelled rental", async () => {
      queryResults.value = [{ id: 1, status: "cancelled", customerName: "Test" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.delete({ id: 1 });
      expect(result).toEqual({ success: true });
    });

    it("rejects deleting active rental", async () => {
      queryResults.value = [{ id: 1, status: "active", customerName: "Test" }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 1 })).rejects.toThrow("Cannot delete active rental");
    });

    it("rejects deleting pending rental", async () => {
      queryResults.value = [{ id: 1, status: "pending", customerName: "Test" }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 1 })).rejects.toThrow("Cannot delete active rental");
    });

    it("throws NOT_FOUND for missing rental", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 999 })).rejects.toThrow("Rental not found");
    });

    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 1 })).rejects.toThrow("Database not available");
    });
  });

  // ── getById ───────────────────────────────────────────────────────
  describe("getById", () => {
    it("returns null when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.getById({ id: 1 })).toBeNull();
    });

    it("returns null when not found", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.getById({ id: 999 })).toBeNull();
    });
  });

  // ── getStatusHistory ──────────────────────────────────────────────
  describe("getStatusHistory", () => {
    it("returns empty when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.getStatusHistory({ rentalId: 1 })).toEqual([]);
    });
  });

  // ── listForDropdown ───────────────────────────────────────────────
  describe("listForDropdown", () => {
    it("returns list for admin", async () => {
      queryResults.value = [{ id: 1, customerName: "Test" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.listForDropdown();
      expect(result.length).toBe(1);
    });

    it("filters active only", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.listForDropdown({ activeOnly: true });
      expect(Array.isArray(result)).toBe(true);
    });

    it("returns empty when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.listForDropdown()).toEqual([]);
    });
  });

  // ── update ────────────────────────────────────────────────────────
  describe("update", () => {
    it("manual price edit requires a reason (override)", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", rentalFee: "100", totalAmount: "500" }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.update({ id: 1, rentalFee: "200", totalAmount: "600" })).rejects.toThrow(/Override|原因/);
    });

    it("updates pricing fields with an override reason (logs price_override)", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", rentalFee: "100", totalAmount: "500" }];
      insertResults.value = [{ id: 1, rentalFee: "200", totalAmount: "600" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.update({ id: 1, rentalFee: "200", totalAmount: "600", editReason: "agreed discount" });
      expect(result).toBeDefined();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "price_override",
        entityType: "rental",
        metadata: expect.objectContaining({ reason: "agreed discount" }),
      }));
    });

    it("override records WHICH money component changed (freight from→to)", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", freightCost: "335.00", totalAmount: "735.91" }];
      insertResults.value = [{ id: 1, freightCost: "285.00", totalAmount: "685.91" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.update({ id: 1, freightCost: "285.00", totalAmount: "685.91", editReason: "freight corrected" });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "price_override",
        changes: expect.objectContaining({
          freightCost: { old: "335.00", new: "285.00" },
          totalAmount: { old: "735.91", new: "685.91" },
        }),
      }));
    });

    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.update({ id: 1, rentalFee: "200" })).rejects.toThrow("Database not available");
    });

    it("skips audit log when no changes", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", rentalFee: "100" }];
      insertResults.value = [{ id: 1, rentalFee: "100" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.update({ id: 1, rentalFee: "100" }); // same value
      // Audit log should not be called because no changes
      expect(mockLogAudit).not.toHaveBeenCalled();
    });

    it("updates dates", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", startDate: "2025-01-01", endDate: "2025-01-10" }];
      insertResults.value = [{ id: 1, startDate: new Date("2025-02-01"), endDate: new Date("2025-02-10") }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.update({ id: 1, startDate: "2025-02-01", endDate: "2025-02-10" });
      expect(result).toBeDefined();
    });

    it("invoiced order: blocks money edit without a reason", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", rentalFee: "100", totalAmount: "500", invoiceNumber: "INV-1", type: "rental", status: "sent" }];
      insertResults.value = [{ id: 1, rentalFee: "200" }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.update({ id: 1, rentalFee: "200", totalAmount: "600" })).rejects.toThrow(/已开票/);
    });

    it("invoiced order: allows money edit with a reason, logs post_invoice_edit", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", rentalFee: "100", totalAmount: "500", invoiceNumber: "INV-1", type: "rental", status: "sent" }];
      insertResults.value = [{ id: 1, rentalFee: "200" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.update({ id: 1, rentalFee: "200", totalAmount: "600", editReason: "agreed adjustment" });
      expect(result).toBeDefined();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "post_invoice_edit",
        metadata: expect.objectContaining({ invoiceNumber: "INV-1", reason: "agreed adjustment" }),
      }));
    });

    it("marking the deposit collected flips depositPaid and logs deposit_collected", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", depositPaid: false, depositAmount: "500" }];
      insertResults.value = [{ id: 1, depositPaid: true }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.update({ id: 1, depositPaid: true });
      expect(result).toBeDefined();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "deposit_collected",
        entityType: "rental",
        changes: expect.objectContaining({ depositPaid: { old: false, new: true } }),
      }));
    });

    it("un-marking the deposit logs deposit_uncollected", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", depositPaid: true, depositAmount: "500" }];
      insertResults.value = [{ id: 1, depositPaid: false }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.update({ id: 1, depositPaid: false });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "deposit_uncollected",
        changes: expect.objectContaining({ depositPaid: { old: true, new: false } }),
      }));
    });

    it("rejects partial date updates that invert the date range", async () => {
      queryResults.value = [{ id: 1, customerName: "Test", startDate: new Date("2025-02-10"), endDate: new Date("2025-02-15") }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.update({ id: 1, endDate: "2025-02-01" })).rejects.toThrow("Start date must be before end date");
    });

    it("rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.update({ id: 1, rentalFee: "100" })).rejects.toThrow("Please login");
    });
  });

  // ── generateContract ──────────────────────────────────────────────
  describe("generateContract", () => {
    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.generateContract({ id: 1 })).rejects.toThrow("Database not available");
    });

    it("throws when rental not found", async () => {
      queryResults.value = [];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.generateContract({ id: 999 })).rejects.toThrow("Rental not found");
    });

    it("generates contract for valid rental", async () => {
      queryResults.value = [{
        rental_requests: {
          id: 1, customerName: "Test", customerEmail: "test@test.com",
          customerPhone: "555-1234", customerCompany: "Co",
          startDate: new Date("2025-01-01"), endDate: new Date("2025-01-10"),
          rentalFee: "500", freightCost: "100", insuranceCost: "50",
          taxAmount: "80", totalAmount: "730",
          deliveryAddress: "123 Street", projectDescription: "Project",
          contractVersion: 1,
        },
        rental_fleet: { id: 5, brand: "CAT", model: "320", category: "Excavator" },
      }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.generateContract({ id: 1 });
      expect(result).toEqual({ url: "https://test.com/contract.pdf" });
    });

    it("rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.generateContract({ id: 1 })).rejects.toThrow("Please login");
    });
  });

  // ── getStatusHistory ──────────────────────────────────────────────
  describe("getStatusHistory", () => {
    it("returns empty when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.getStatusHistory({ rentalId: 1 })).toEqual([]);
    });

    it("returns audit entries", async () => {
      queryResults.value = [
        { id: 1, action: "status_change", changes: { status: { old: "pending", new: "approved" } } },
        { id: 2, action: "create", changes: null },
      ];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.getStatusHistory({ rentalId: 1 });
      expect(result.length).toBe(2);
    });
  });

  // ── adminCreate ───────────────────────────────────────────────────
  describe("adminCreate", () => {
    it("creates rental with new customer (no email)", async () => {
      insertResults.value = [{ id: 10, customerName: "Test" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.adminCreate({
        customerName: "Test Customer",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      });
      expect(result).toBeDefined();
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "create",
        entityType: "rental",
      }));
    });

    it("creates rental with existing customer (email match)", async () => {
      queryResults.value = [{ id: 5, email: "existing@test.com" }]; // existing customer
      insertResults.value = [{ id: 11, customerName: "Test" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.adminCreate({
        customerName: "Test",
        customerEmail: "existing@test.com",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      });
      expect(result).toBeDefined();
    });

    it("creates rental with new customer (email not found)", async () => {
      queryResults.value = []; // no existing customer
      insertResults.value = [{ id: 20, name: "New" }]; // first call: customer created, second: rental
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.adminCreate({
        customerName: "New",
        customerEmail: "new@test.com",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      });
      expect(result).toBeDefined();
    });

    it("rejects unavailable equipment", async () => {
      mockCheckAvail.mockResolvedValueOnce({ isAvailable: false, conflicting: [1] });
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreate({
        customerName: "Test",
        rentalFleetId: 1,
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      })).rejects.toThrow("Equipment not available");
    });

    it("validates dates", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreate({
        customerName: "Test",
        startDate: "2025-01-10",
        endDate: "2025-01-01",
      })).rejects.toThrow("Start date must be before end date");
    });

    it("throws when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.adminCreate({
        customerName: "Test",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      })).rejects.toThrow("Database not available");
    });
  });

  // ── create with customer upsert ────────────────────────────────────
  describe("create (public) with existing customer", () => {
    it("updates existing customer data", async () => {
      queryResults.value = [{ id: 3, email: "existing@test.com" }]; // existing customer
      insertResults.value = [{ id: 20, customerName: "Updated" }];
      const caller = createCaller(makeCtx());
      const result = await caller.create({
        customerName: "Updated",
        customerEmail: "existing@test.com",
        startDate: "2025-01-01",
        endDate: "2025-01-10",
      });
      expect(result).toBeDefined();
    });
  });
});
