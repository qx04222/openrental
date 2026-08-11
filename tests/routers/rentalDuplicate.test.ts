/**
 * rentals.duplicate procedure — unit tests via tRPC createCallerFactory
 *
 * Covers:
 *  - source not found → NOT_FOUND
 *  - source soft-deleted → NOT_FOUND
 *  - source status not duplicable (pending/approved/rejected) → BAD_REQUEST
 *  - invalid new dates (start >= end) → BAD_REQUEST
 *  - fleet conflict → assignedFleetId cleared (null in new row)
 *  - valid duplicate → new row with expected field resets
 *  - contract/payment fields nullified in new row
 *  - original record untouched
 *  - unauthenticated → UNAUTHORIZED
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ───────────────────────────────────────────────────────────
const { mockGetDb, queryResults, insertResults, mockLogAudit, mockCheckAvail } = vi.hoisted(() => {
  const queryResults: { value: unknown[] } = { value: [] };
  const insertResults: { value: unknown[] } = { value: [] };

  const createChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["select", "from", "leftJoin", "where", "orderBy", "limit", "offset", "insert", "values", "returning", "update", "set", "delete"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve([...queryResults.value]);
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
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb)),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    queryResults,
    insertResults,
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
    mockCheckAvail: vi.fn().mockResolvedValue({ isAvailable: true, conflicting: [] }),
  };
});

// ── Module mocks ────────────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  and: vi.fn((..._a: unknown[]) => "and"),
  or: vi.fn((..._a: unknown[]) => "or"),
  desc: vi.fn((..._a: unknown[]) => "desc"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
  sql: vi.fn((..._a: unknown[]) => "sql"),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    rentalRequests: {
      id: col("id"), status: col("status"), paymentStatus: col("paymentStatus"),
      customerName: col("customerName"), customerEmail: col("customerEmail"),
      customerPhone: col("customerPhone"), customerCompany: col("customerCompany"),
      rentalFleetId: col("rentalFleetId"), customerId: col("customerId"),
      startDate: col("startDate"), endDate: col("endDate"),
      deletedAt: col("deletedAt"), createdAt: col("createdAt"), updatedAt: col("updatedAt"),
      deliveryMethod: col("deliveryMethod"), deliveryAddress: col("deliveryAddress"),
      deliveryNotes: col("deliveryNotes"), deliveryProvince: col("deliveryProvince"),
      pickupProvince: col("pickupProvince"), taxProvince: col("taxProvince"),
      insuranceType: col("insuranceType"), insuranceCost: col("insuranceCost"),
      freightCost: col("freightCost"), taxAmount: col("taxAmount"),
      taxBreakdown: col("taxBreakdown"), rentalFee: col("rentalFee"),
      depositAmount: col("depositAmount"), totalAmount: col("totalAmount"),
      depositPaid: col("depositPaid"), insuranceDocsReceived: col("insuranceDocsReceived"),
      contractUrl: col("contractUrl"), contractGenerated: col("contractGenerated"),
      contractGeneratedAt: col("contractGeneratedAt"), contractSignedAt: col("contractSignedAt"),
      contractVersion: col("contractVersion"),
      orderConfirmationPdfUrl: col("orderConfirmationPdfUrl"),
      stripePaymentIntentId: col("stripePaymentIntentId"),
      stripeCheckoutSessionId: col("stripeCheckoutSessionId"),
      deliveryInspectionCompleted: col("deliveryInspectionCompleted"),
      returnInspectionCompleted: col("returnInspectionCompleted"),
      deliveryInspectionId: col("deliveryInspectionId"),
      returnInspectionId: col("returnInspectionId"),
      projectDescription: col("projectDescription"), projectId: col("projectId"),
      equipmentDescription: col("equipmentDescription"),
      equipmentModelId: col("equipmentModelId"),
      billingCycleType: col("billingCycleType"), shiftType: col("shiftType"),
      hireType: col("hireType"), fuelPolicy: col("fuelPolicy"),
      scheduledDeliveryTime: col("scheduledDeliveryTime"),
      scheduledPickupTime: col("scheduledPickupTime"),
      adminNotes: col("adminNotes"), customerNotes: col("customerNotes"),
      rentalNumber: col("rentalNumber"),
    },
    rentalFleet: { id: col("id"), brand: col("brand"), model: col("model"), category: col("category"), locationId: col("locationId") },
    warehouses: { id: col("id"), name: col("name"), address: col("address") },
    customers: { id: col("id"), email: col("email"), name: col("name"), phone: col("phone"), company: col("company"), updatedAt: col("updatedAt"), totalRentals: col("totalRentals"), totalRevenue: col("totalRevenue"), lastRentalDate: col("lastRentalDate") },
    dispatchOrders: {
      orderType: col("orderType"), rentalRequestId: col("rentalRequestId"),
      rentalFleetId: col("rentalFleetId"), customerId: col("customerId"),
      scheduledDate: col("scheduledDate"), deliveryAddress: col("deliveryAddress"),
      pickupAddress: col("pickupAddress"), shippingCost: col("shippingCost"),
      notes: col("notes"),
    },
    auditLogs: {
      id: col("id"), action: col("action"), changes: col("changes"),
      metadata: col("metadata"), createdAt: col("createdAt"),
      entityType: col("entityType"), entityId: col("entityId"), userId: col("userId"),
    },
    users: { id: col("id"), name: col("name"), username: col("username") },
    rolePermissions: {
      id: col("id"), role: col("role"), module: col("module"),
      canCreate: col("canCreate"), canRead: col("canRead"),
      canUpdate: col("canUpdate"), canDelete: col("canDelete"),
      createdAt: col("createdAt"), updatedAt: col("updatedAt"),
    },
    userPermissionOverrides: {
      id: col("id"), userId: col("userId"), module: col("module"),
      canCreate: col("canCreate"), canRead: col("canRead"),
      canUpdate: col("canUpdate"), canDelete: col("canDelete"),
      createdAt: col("createdAt"),
    },
    referralCodes: {
      id: col("id"), code: col("code"), isActive: col("isActive"),
      promotionId: col("promotionId"), driverId: col("driverId"),
      totalUses: col("totalUses"), totalCommission: col("totalCommission"),
    },
    promotions: {
      id: col("id"), isActive: col("isActive"), deletedAt: col("deletedAt"),
      startDate: col("startDate"), endDate: col("endDate"),
      discountPercent: col("discountPercent"), commissionPercent: col("commissionPercent"),
      maxUsesPerCode: col("maxUsesPerCode"),
    },
    referralLedger: {
      referralCodeId: col("referralCodeId"), rentalRequestId: col("rentalRequestId"),
      customerId: col("customerId"), driverId: col("driverId"),
      rentalFee: col("rentalFee"), discountAmount: col("discountAmount"),
      commissionAmount: col("commissionAmount"),
    },
  };
});

vi.mock("../../server/services/auditLog", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("../../server/services/rentalStatusSync", () => ({
  checkDateRangeAvailability: (...args: unknown[]) => mockCheckAvail(...args),
  assignFleetAssetToRental: vi.fn().mockResolvedValue({ success: true }),
  releaseFleetAsset: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../../server/services/assetAssignment", () => ({
  autoAssignAsset: vi.fn().mockResolvedValue(null),
  getModelAvailability: vi.fn().mockResolvedValue({ available: true }),
}));

// ── Import router ───────────────────────────────────────────────────────────
import { rentalRequestsRouter } from "../../server/routers/rentalRequests.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(rentalRequestsRouter);

function makeCtx(role?: string): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: role
      ? {
          id: 1, email: "admin@test.com", name: "Admin", username: "admin",
          role: role as "admin", isActive: true, passwordHash: null, phone: null,
          createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
          lastSignedIn: null, loginMethod: null,
        }
      : null,
  };
}

const baseSource = {
  id: 10,
  rentalNumber: "20250101AB",
  status: "completed",
  deletedAt: null,
  customerId: 5,
  customerName: "Jane Smith",
  customerEmail: "jane@test.com",
  customerPhone: "555-0001",
  customerCompany: "Acme Co",
  rentalFleetId: 7,
  equipmentModelId: 3,
  equipmentDescription: "5-tonne bin",
  startDate: new Date("2025-01-01"),
  endDate: new Date("2025-01-08"),
  rentalFee: "420.00",
  freightCost: "80.00",
  insuranceCost: "30.00",
  taxAmount: "55.90",
  taxBreakdown: "GST 5%",
  depositAmount: "200.00",
  totalAmount: "585.90",
  insuranceType: "basic",
  deliveryMethod: "delivery",
  deliveryAddress: "1 Main St",
  deliveryNotes: "Ring doorbell",
  deliveryProvince: "ON",
  pickupProvince: "ON",
  taxProvince: "ON",
  scheduledDeliveryTime: "08:00",
  scheduledPickupTime: "17:00",
  projectId: null,
  projectDescription: "Site cleanup",
  billingCycleType: "calendar",
  shiftType: "single",
  hireType: "dry",
  fuelPolicy: "full_to_full",
  // Fields that MUST be reset on duplicate
  contractUrl: "https://storage.example.com/contract.pdf",
  contractGenerated: true,
  contractGeneratedAt: new Date("2025-01-02"),
  contractSignedAt: new Date("2025-01-03"),
  orderConfirmationPdfUrl: "https://storage.example.com/confirm.pdf",
  stripePaymentIntentId: "pi_abc123",
  stripeCheckoutSessionId: "cs_abc123",
  depositPaid: true,
  insuranceDocsReceived: true,
  deliveryInspectionCompleted: true,
  returnInspectionCompleted: true,
  deliveryInspectionId: 20,
  returnInspectionId: 21,
};

// ── Tests ───────────────────────────────────────────────────────────────────
describe("rentals.duplicate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
    insertResults.value = [];
    mockCheckAvail.mockResolvedValue({ isAvailable: true, conflicting: [] });
  });

  // ── Auth ──────────────────────────────────────────────────────────────────
  it("rejects unauthenticated callers with UNAUTHORIZED", async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" })
    ).rejects.toThrow("Please login");
  });

  // ── Source not found ──────────────────────────────────────────────────────
  it("throws NOT_FOUND when source rental does not exist", async () => {
    queryResults.value = [];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 999, newStartDate: "2025-06-01", newEndDate: "2025-06-08" })
    ).rejects.toThrow("Source rental not found");
  });

  it("throws NOT_FOUND when source rental is soft-deleted", async () => {
    // The query uses isNull(deletedAt) so the DB would return nothing for deleted records.
    // Simulate by returning empty — the guard on deletedAt is enforced in the WHERE clause.
    queryResults.value = [];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" })
    ).rejects.toThrow("Source rental not found");
  });

  // ── Source status validation ──────────────────────────────────────────────
  it("rejects duplication of a pending rental", async () => {
    queryResults.value = [{ ...baseSource, status: "pending" }];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" })
    ).rejects.toThrow(/Cannot duplicate.*pending/);
  });

  it("rejects duplication of an approved rental", async () => {
    queryResults.value = [{ ...baseSource, status: "approved" }];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" })
    ).rejects.toThrow(/Cannot duplicate.*approved/);
  });

  it("rejects duplication of a rejected rental", async () => {
    queryResults.value = [{ ...baseSource, status: "rejected" }];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" })
    ).rejects.toThrow(/Cannot duplicate.*rejected/);
  });

  it("allows duplication of a completed rental", async () => {
    queryResults.value = [{ ...baseSource, status: "completed" }];
    insertResults.value = [{ id: 11, rentalNumber: "20250601XY" }];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });
    expect(result.id).toBe(11);
    expect(result.rentalNumber).toBe("20250601XY");
  });

  it("allows duplication of an active rental", async () => {
    queryResults.value = [{ ...baseSource, status: "active" }];
    insertResults.value = [{ id: 12, rentalNumber: "20250601ZZ" }];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });
    expect(result.id).toBe(12);
  });

  it("allows duplication of a cancelled rental", async () => {
    queryResults.value = [{ ...baseSource, status: "cancelled" }];
    insertResults.value = [{ id: 13, rentalNumber: "20250601QQ" }];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });
    expect(result.id).toBe(13);
  });

  // ── Date validation ───────────────────────────────────────────────────────
  it("rejects new dates where start equals end", async () => {
    queryResults.value = [baseSource];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-01" })
    ).rejects.toThrow("Start date must be before end date");
  });

  it("rejects new dates where start is after end", async () => {
    queryResults.value = [baseSource];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "2025-06-10", newEndDate: "2025-06-01" })
    ).rejects.toThrow("Start date must be before end date");
  });

  it("rejects invalid date format", async () => {
    queryResults.value = [baseSource];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "not-a-date", newEndDate: "2025-06-08" })
    ).rejects.toThrow("Invalid date format");
  });

  // ── Fleet availability ────────────────────────────────────────────────────
  it("clears rentalFleetId when fleet is unavailable in new window", async () => {
    queryResults.value = [{ ...baseSource, status: "completed", rentalFleetId: 7 }];
    mockCheckAvail.mockResolvedValueOnce({ isAvailable: false, conflicting: [99] });
    insertResults.value = [{ id: 14, rentalNumber: "20250601WW" }];

    const caller = createCaller(makeCtx("super_admin"));
    await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });

    // The insert values call should have been made with rentalFleetId: null
    const mockDb = await mockGetDb();
    const insertSpy = mockDb.insert as ReturnType<typeof vi.fn>;
    expect(insertSpy).toHaveBeenCalled();
    const valuesSpy = insertSpy.mock.results[0]?.value?.values as ReturnType<typeof vi.fn> | undefined;
    if (valuesSpy) {
      const insertedRow = valuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedRow.rentalFleetId).toBeNull();
    }
  });

  it("retains rentalFleetId when fleet is available in new window", async () => {
    queryResults.value = [{ ...baseSource, status: "completed", rentalFleetId: 7 }];
    mockCheckAvail.mockResolvedValueOnce({ isAvailable: true, conflicting: [] });
    insertResults.value = [{ id: 15, rentalNumber: "20250601VV" }];

    const caller = createCaller(makeCtx("super_admin"));
    await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });

    const mockDb = await mockGetDb();
    const insertSpy = mockDb.insert as ReturnType<typeof vi.fn>;
    expect(insertSpy).toHaveBeenCalled();
    const valuesSpy = insertSpy.mock.results[0]?.value?.values as ReturnType<typeof vi.fn> | undefined;
    if (valuesSpy) {
      const insertedRow = valuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedRow.rentalFleetId).toBe(7);
    }
  });

  // ── Contract / payment fields nullified ───────────────────────────────────
  it("sets contract and payment fields to null/false in new row", async () => {
    queryResults.value = [baseSource];
    insertResults.value = [{ id: 16, rentalNumber: "20250601UU" }];

    const caller = createCaller(makeCtx("super_admin"));
    await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });

    const mockDb = await mockGetDb();
    const insertSpy = mockDb.insert as ReturnType<typeof vi.fn>;
    expect(insertSpy).toHaveBeenCalled();
    const valuesSpy = insertSpy.mock.results[0]?.value?.values as ReturnType<typeof vi.fn> | undefined;
    if (valuesSpy) {
      const row = valuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(row.contractUrl).toBeNull();
      expect(row.contractGenerated).toBe(false);
      expect(row.contractGeneratedAt).toBeNull();
      expect(row.contractSignedAt).toBeNull();
      expect(row.orderConfirmationPdfUrl).toBeNull();
      expect(row.stripePaymentIntentId).toBeNull();
      expect(row.stripeCheckoutSessionId).toBeNull();
      expect(row.depositPaid).toBe(false);
      expect(row.insuranceDocsReceived).toBe(false);
      expect(row.deliveryInspectionCompleted).toBe(false);
      expect(row.returnInspectionCompleted).toBe(false);
      expect(row.deliveryInspectionId).toBeNull();
      expect(row.returnInspectionId).toBeNull();
      expect(row.status).toBe("pending");
      expect(row.paymentStatus).toBe("pending");
    }
  });

  // ── Customer / pricing fields cloned ─────────────────────────────────────
  it("clones customer and pricing fields into new row", async () => {
    queryResults.value = [baseSource];
    insertResults.value = [{ id: 17, rentalNumber: "20250601TT" }];

    const caller = createCaller(makeCtx("super_admin"));
    await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });

    const mockDb = await mockGetDb();
    const insertSpy = mockDb.insert as ReturnType<typeof vi.fn>;
    const valuesSpy = insertSpy.mock.results[0]?.value?.values as ReturnType<typeof vi.fn> | undefined;
    if (valuesSpy) {
      const row = valuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(row.customerName).toBe("Jane Smith");
      expect(row.customerEmail).toBe("jane@test.com");
      expect(row.customerId).toBe(5);
      expect(row.rentalFee).toBe("420.00");
      expect(row.freightCost).toBe("80.00");
      expect(row.totalAmount).toBe("585.90");
      expect(row.insuranceType).toBe("basic");
      expect(row.deliveryAddress).toBe("1 Main St");
    }
  });

  // ── Audit log ─────────────────────────────────────────────────────────────
  it("writes an audit log entry on successful duplicate", async () => {
    queryResults.value = [baseSource];
    insertResults.value = [{ id: 18, rentalNumber: "20250601SS" }];

    const caller = createCaller(makeCtx("super_admin"));
    await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "create",
      entityType: "rental",
      entityId: 18,
      metadata: expect.objectContaining({
        source: "duplicate",
        sourceRentalId: 10,
      }),
    }));
  });

  // ── DB error ──────────────────────────────────────────────────────────────
  it("throws INTERNAL_SERVER_ERROR when DB is unavailable", async () => {
    mockGetDb.mockResolvedValueOnce(null);
    const caller = createCaller(makeCtx("super_admin"));
    await expect(
      caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" })
    ).rejects.toThrow("Database not available");
  });

  // ── Original record untouched ─────────────────────────────────────────────
  it("does not modify the source rental record", async () => {
    queryResults.value = [baseSource];
    insertResults.value = [{ id: 19, rentalNumber: "20250601RR" }];

    const caller = createCaller(makeCtx("super_admin"));
    await caller.duplicate({ sourceId: 10, newStartDate: "2025-06-01", newEndDate: "2025-06-08" });

    const mockDb = await mockGetDb();
    const updateSpy = mockDb.update as ReturnType<typeof vi.fn>;
    // update() should NOT have been called on rentalRequests for the source record
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
