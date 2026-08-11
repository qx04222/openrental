/**
 * rentals.renew mutation — unit tests via tRPC createCallerFactory
 *
 * Renewal was reworked (commit e1b871c) from "create a child rental linked by
 * parentRentalId" into an in-place SAME-ORDER extension: the source rental's
 * endDate / pricing / contract version are updated, an `extension_requests`
 * row (status=approved) is recorded, line-item end dates are pushed forward,
 * and a supplement invoice + contract addendum are generated as non-blocking
 * side effects. These tests cover that current behavior.
 *
 * Covers: source not found, renewable-status guard, renewal cap, endDate
 * continuity, extension_requests insert, contract-version bump, status flip
 * completed→active, audit log, and return value shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const {
  mockGetDb,
  mockLogAudit,
  mockRecalc,
  mockExtendLineItems,
  mockSupplementInvoice,
  mockAddendumPdf,
} = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockLogAudit: vi.fn().mockResolvedValue(undefined),
  mockRecalc: vi.fn(),
  mockExtendLineItems: vi.fn().mockResolvedValue({ updated: 0 }),
  mockSupplementInvoice: vi.fn().mockResolvedValue({ invoiceId: 1, invoiceNumber: "INV-SUP-001" }),
  mockAddendumPdf: vi.fn().mockResolvedValue({ url: "https://test.com/addendum.pdf" }),
}));

// ── Module mocks ───────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  and: vi.fn((..._a: unknown[]) => "and"),
  or: vi.fn((..._a: unknown[]) => "or"),
  ne: vi.fn((..._a: unknown[]) => "ne"),
  desc: vi.fn((..._a: unknown[]) => "desc"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
  inArray: vi.fn((..._a: unknown[]) => "inArray"),
  lte: vi.fn((..._a: unknown[]) => "lte"),
  gte: vi.fn((..._a: unknown[]) => "gte"),
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
      insuranceCost: col("insuranceCost"), freightCost: col("freightCost"),
      taxAmount: col("taxAmount"), taxBreakdown: col("taxBreakdown"),
      rentalFee: col("rentalFee"), depositAmount: col("depositAmount"),
      totalAmount: col("totalAmount"), contractUrl: col("contractUrl"),
      contractGenerated: col("contractGenerated"), contractGeneratedAt: col("contractGeneratedAt"),
      contractVersion: col("contractVersion"), contractSignedAt: col("contractSignedAt"),
      equipmentDescription: col("equipmentDescription"),
      deliveryInspectionCompleted: col("deliveryInspectionCompleted"),
      returnInspectionCompleted: col("returnInspectionCompleted"),
      returnInspectionId: col("returnInspectionId"),
      rentalNumber: col("rentalNumber"),
    },
    extensionRequests: {
      id: col("id"), rentalRequestId: col("rentalRequestId"), customerId: col("customerId"),
      requestedEndDate: col("requestedEndDate"), reason: col("reason"), status: col("status"),
      adminNotes: col("adminNotes"), reviewedBy: col("reviewedBy"), reviewedAt: col("reviewedAt"),
    },
    rentalFleet: { id: col("id"), brand: col("brand"), model: col("model"), category: col("category"), locationId: col("locationId"), deletedAt: col("deletedAt") },
    auditLogs: { id: col("id"), action: col("action"), changes: col("changes"), metadata: col("metadata"), createdAt: col("createdAt"), entityType: col("entityType"), entityId: col("entityId"), userId: col("userId") },
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
  };
});

vi.mock("../../server/services/auditLog", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("../../server/services/priceRecalculation", () => ({
  recalculateRentalPricing: (...args: unknown[]) => mockRecalc(...args),
}));

vi.mock("../../server/services/rentalLineItemSync", () => ({
  extendLineItemEndDates: (...args: unknown[]) => mockExtendLineItems(...args),
  syncDispatchScheduleDates: async () => ({ updated: 0 }),
}));

vi.mock("../../server/services/invoiceGenerator", () => ({
  generateRenewalSupplementInvoice: (...args: unknown[]) => mockSupplementInvoice(...args),
}));

vi.mock("../../server/services/contractPDF", () => ({
  generateRenewalAddendumPDF: (...args: unknown[]) => mockAddendumPdf(...args),
}));

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// ── Import router ──────────────────────────────────────────────────────
import { rentalRequestsRouter } from "../../server/routers/rentalRequests.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";
import { parseCalendarDate } from "../../server/_core/dateUtils";

const createCaller = t.createCallerFactory(rentalRequestsRouter);

function makeCtx(role = "super_admin"): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 1, email: "admin@test.com", name: "Admin", username: "admin",
      role: role as "super_admin", isActive: true, passwordHash: null, phone: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      lastSignedIn: null, loginMethod: null,
    },
  };
}

/** Helper to build a realistic rental source object */
function makeSourceRental(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    rentalNumber: "20260401AB",
    status: "completed",
    customerId: 42,
    customerName: "Acme Corp",
    customerEmail: "acme@example.com",
    customerPhone: "555-1234",
    customerCompany: "Acme",
    rentalFleetId: null,
    equipmentDescription: "10yd bin",
    // Toronto-anchored calendar dates (matches how the app stores them).
    startDate: parseCalendarDate("2026-04-01"),
    endDate: parseCalendarDate("2026-04-10"),
    insuranceType: "none",
    rentalFee: "200.00",
    freightCost: "50.00",
    insuranceCost: "0.00",
    taxAmount: "32.50",
    taxBreakdown: "HST 13%",
    depositAmount: "100.00",
    totalAmount: "282.50",
    contractUrl: null,
    contractGenerated: false,
    contractGeneratedAt: null,
    contractVersion: 1,
    contractSignedAt: null,
    returnInspectionCompleted: false,
    returnInspectionId: null,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * Builds a db mock where each db.select() call returns the next pre-canned
 * row set from selectSequence. The transaction callback receives a `tx`
 * object that records its update/insert calls and shares the same select
 * sequence. Returns recorded write calls for assertions.
 */
function buildDb(selectSequence: unknown[][], extensionRow: unknown = { id: 77 }) {
  let callIdx = 0;
  const txUpdateSetCalls: unknown[] = [];
  const txInsertValueCalls: unknown[] = [];
  const dbUpdateSetCalls: unknown[] = [];

  const createSelectChain = (rows: unknown[]) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> & { then?: unknown } = {};
    for (const m of ["from", "leftJoin", "where", "orderBy", "limit", "offset"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (v: unknown) => void) => resolve([...rows]);
    return chain;
  };

  const nextSelect = () => createSelectChain(selectSequence[callIdx++] ?? []);

  const tx = {
    select: vi.fn(nextSelect),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((vals: unknown) => {
        txUpdateSetCalls.push(vals);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: unknown) => {
        txInsertValueCalls.push(vals);
        return { returning: vi.fn().mockResolvedValue([extensionRow]) };
      }),
    }),
  };

  const mockDb = {
    select: vi.fn(nextSelect),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((vals: unknown) => {
        dbUpdateSetCalls.push(vals);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    insert: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
  };

  mockGetDb.mockResolvedValue(mockDb);
  return { mockDb, txUpdateSetCalls, txInsertValueCalls, dbUpdateSetCalls };
}

// ── Tests ──────────────────────────────────────────────────────────────
describe("rentals.renew mutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogAudit.mockResolvedValue(undefined);
    mockExtendLineItems.mockResolvedValue({ updated: 0 });
    mockSupplementInvoice.mockResolvedValue({ invoiceId: 1, invoiceNumber: "INV-SUP-001" });
    mockAddendumPdf.mockResolvedValue({ url: "https://test.com/addendum.pdf" });
    // Recalc bumps the new total above the old one so a supplement is produced.
    mockRecalc.mockResolvedValue({
      old: { rentalFee: 200, taxAmount: 32.5, totalAmount: 282.5, days: 9, insuranceCost: 0, taxBreakdown: "HST 13%" },
      new: { rentalFee: 350, taxAmount: 45.5, totalAmount: 445.5, days: 16, insuranceCost: 0, taxBreakdown: "HST 13%" },
      diff: { rentalFee: 150, taxAmount: 13, totalAmount: 163, days: 7 },
    });
  });

  // ─── source not found ──────────────────────────────────────────
  it("throws NOT_FOUND when source rental does not exist", async () => {
    buildDb([[]]); // empty result for source fetch
    const caller = createCaller(makeCtx());
    await expect(
      caller.renew({ sourceId: 999, extensionDays: 7 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // ─── renewable-status guard ────────────────────────────────────
  it("throws BAD_REQUEST when source is pending", async () => {
    buildDb([[makeSourceRental({ status: "pending" })]]);
    const caller = createCaller(makeCtx());
    await expect(
      caller.renew({ sourceId: 1, extensionDays: 7 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("can be renewed") });
  });

  it("throws BAD_REQUEST when source is cancelled", async () => {
    buildDb([[makeSourceRental({ status: "cancelled" })]]);
    const caller = createCaller(makeCtx());
    await expect(
      caller.renew({ sourceId: 1, extensionDays: 7 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("allows renewal when source is approved", async () => {
    // approved is a renewable status now: [active, completed, approved, overdue]
    buildDb([[makeSourceRental({ status: "approved" })], []]);
    const caller = createCaller(makeCtx());
    const result = await caller.renew({ sourceId: 1, extensionDays: 7 });
    expect(result).toMatchObject({ id: 1 });
  });

  it("allows renewal when source is overdue", async () => {
    buildDb([[makeSourceRental({ status: "overdue" })], []]);
    const caller = createCaller(makeCtx());
    const result = await caller.renew({ sourceId: 1, extensionDays: 7 });
    expect(result).toMatchObject({ id: 1 });
  });

  // ─── renewal cap (>= 20 approved extensions) ───────────────────
  it("throws BAD_REQUEST when the renewal limit is reached", async () => {
    const manyExtensions = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
    buildDb([[makeSourceRental({ status: "active" })], manyExtensions]);
    const caller = createCaller(makeCtx());
    await expect(
      caller.renew({ sourceId: 1, extensionDays: 7 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("renewal limit") });
  });

  // ─── in-place extension writes ─────────────────────────────────
  it("pushes the source rental endDate forward by extensionDays", async () => {
    const { txUpdateSetCalls } = buildDb([[makeSourceRental({ status: "active" })], []]);
    const caller = createCaller(makeCtx());
    await caller.renew({ sourceId: 1, extensionDays: 7 });

    // First tx.update is the rental endDate/version update.
    const upd = txUpdateSetCalls[0] as { endDate: Date };
    expect(upd.endDate).toBeInstanceOf(Date);
    // Toronto-anchored: source endDate 2026-04-10 + 7 calendar days = 2026-04-17.
    expect(upd.endDate.getTime()).toBe(parseCalendarDate("2026-04-17").getTime());
  });

  it("inserts an approved extension_requests row for the source rental", async () => {
    const { txInsertValueCalls } = buildDb([[makeSourceRental({ status: "completed" })], []]);
    const caller = createCaller(makeCtx());
    await caller.renew({ sourceId: 1, extensionDays: 7 });

    expect(txInsertValueCalls.length).toBeGreaterThan(0);
    expect(txInsertValueCalls[0]).toMatchObject({
      rentalRequestId: 1,
      customerId: 42,
      status: "approved",
      reviewedBy: 1,
    });
  });

  it("bumps the contract version and resets return inspection on the source rental", async () => {
    const { txUpdateSetCalls } = buildDb([[makeSourceRental({ status: "active", contractVersion: 3 })], []]);
    const caller = createCaller(makeCtx());
    await caller.renew({ sourceId: 1, extensionDays: 7 });

    const upd = txUpdateSetCalls[0] as { contractVersion: number; returnInspectionCompleted: boolean; contractSignedAt: unknown };
    expect(upd.contractVersion).toBe(4);
    expect(upd.returnInspectionCompleted).toBe(false);
    expect(upd.contractSignedAt).toBeNull();
  });

  it("flips a completed rental back to active on renewal", async () => {
    const { txUpdateSetCalls } = buildDb([[makeSourceRental({ status: "completed" })], []]);
    const caller = createCaller(makeCtx());
    await caller.renew({ sourceId: 1, extensionDays: 7 });

    const upd = txUpdateSetCalls[0] as { status: string };
    expect(upd.status).toBe("active");
  });

  // ─── audit log ─────────────────────────────────────────────────
  it("writes a renewal audit log entry referencing the source rental", async () => {
    buildDb([[makeSourceRental({ status: "completed" })], []]);
    const caller = createCaller(makeCtx());
    await caller.renew({ sourceId: 1, extensionDays: 7 });

    const renewalAudit = mockLogAudit.mock.calls
      .map((c) => c[0] as { metadata?: { source?: string } })
      .find((a) => a.metadata?.source === "renewal");
    expect(renewalAudit).toBeDefined();
    expect(renewalAudit).toMatchObject({
      action: "update",
      entityType: "rental",
      entityId: 1,
      metadata: expect.objectContaining({ source: "renewal", extensionDays: 7 }),
    });
  });

  // ─── return value ──────────────────────────────────────────────
  it("returns the renewal summary for the same order id", async () => {
    buildDb([[makeSourceRental({ status: "completed" })], []]);
    const caller = createCaller(makeCtx());
    const result = await caller.renew({ sourceId: 1, extensionDays: 7 });

    expect(result).toMatchObject({
      id: 1,
      rentalNumber: "20260401AB",
      extensionDays: 7,
      contractVersion: 2,
    });
    expect(result.newEndDate).toBeInstanceOf(Date);
  });

  // ─── input validation ──────────────────────────────────────────
  it("rejects extensionDays of 0 via zod", async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.renew({ sourceId: 1, extensionDays: 0 })
    ).rejects.toThrow();
  });

  it("rejects extensionDays of 366 via zod", async () => {
    const caller = createCaller(makeCtx());
    await expect(
      caller.renew({ sourceId: 1, extensionDays: 366 })
    ).rejects.toThrow();
  });
});
