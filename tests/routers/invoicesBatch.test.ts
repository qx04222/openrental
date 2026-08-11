/**
 * Invoices Router — batchSend tests
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockGetDb, queryResults, insertResults, mockLogAudit } = vi.hoisted(() => {
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
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([...insertResults.value]),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue(chain),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const txChain = createChain();
      const tx = {
        select: vi.fn().mockReturnValue(txChain),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      };
      return fn(tx);
    }),
    execute: vi.fn().mockResolvedValue([]),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    queryResults,
    insertResults,
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
  inArray: vi.fn((..._a: unknown[]) => "inArray"),
  sql: vi.fn((..._a: unknown[]) => ({ toSQL: () => "" })),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    invoices: {
      id: col("id"), invoiceNumber: col("invoiceNumber"), status: col("status"),
      customerId: col("customerId"), rentalId: col("rentalId"), projectId: col("projectId"),
      type: col("type"), subtotal: col("subtotal"), taxAmount: col("taxAmount"),
      taxBreakdown: col("taxBreakdown"), totalAmount: col("totalAmount"),
      amountPaid: col("amountPaid"), balanceDue: col("balanceDue"),
      gstHstNumber: col("gstHstNumber"), taxProvince: col("taxProvince"),
      issueDate: col("issueDate"), dueDate: col("dueDate"), notes: col("notes"),
      internalNotes: col("internalNotes"), deletedAt: col("deletedAt"),
      createdAt: col("createdAt"), updatedAt: col("updatedAt"), createdBy: col("createdBy"),
    },
    invoiceLineItems: {
      id: col("id"), invoiceId: col("invoiceId"), description: col("description"),
      quantity: col("quantity"), unitPrice: col("unitPrice"), amount: col("amount"),
      lineType: col("lineType"), sortOrder: col("sortOrder"),
    },
    payments: {
      id: col("id"), invoiceId: col("invoiceId"), amount: col("amount"),
      paymentMethod: col("paymentMethod"), paymentDate: col("paymentDate"),
      reference: col("reference"), notes: col("notes"), recordedBy: col("recordedBy"),
    },
    customers: {
      id: col("id"), name: col("name"), email: col("email"), deletedAt: col("deletedAt"),
    },
    siteSettings: { id: col("id"), key: col("key"), value: col("value") },
    rentalRequests: {
      id: col("id"), rentalNumber: col("rentalNumber"),
    },
    users: { id: col("id"), deletedAt: col("deletedAt") },
    rolePermissions: {
      id: col("id"), role: col("role"), module: col("module"),
      canCreate: col("canCreate"), canRead: col("canRead"), canUpdate: col("canUpdate"),
      canDelete: col("canDelete"), createdAt: col("createdAt"), updatedAt: col("updatedAt"),
    },
    userPermissionOverrides: {
      id: col("id"), userId: col("userId"), module: col("module"),
      canCreate: col("canCreate"), canRead: col("canRead"), canUpdate: col("canUpdate"),
      canDelete: col("canDelete"), createdAt: col("createdAt"),
    },
  };
});

vi.mock("../../server/services/auditLog", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("../../server/services/invoiceGenerator", () => ({
  generateInvoiceFromRental: vi.fn().mockResolvedValue({ invoiceId: 1, invoiceNumber: "INV-2026-0001" }),
  recalculateInvoicePayments: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../server/services/notifications", () => ({
  sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
  notifyOnEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// ── Import router ──────────────────────────────────────────────────────
import { invoicesRouter } from "../../server/routers/invoices.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(invoicesRouter);

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
describe("invoices.batchSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
    insertResults.value = [];
  });

  it("rejects unauthenticated callers", async () => {
    const caller = createCaller(makeCtx());
    await expect(caller.batchSend({ ids: [1] })).rejects.toThrow("Please login");
  });

  it("rejects more than 100 ids", async () => {
    const caller = createCaller(makeCtx("super_admin"));
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    await expect(caller.batchSend({ ids })).rejects.toThrow();
  });

  it("rejects empty ids array", async () => {
    const caller = createCaller(makeCtx("super_admin"));
    await expect(caller.batchSend({ ids: [] })).rejects.toThrow();
  });

  it("throws when DB is null", async () => {
    mockGetDb.mockResolvedValueOnce(null);
    const caller = createCaller(makeCtx("super_admin"));
    await expect(caller.batchSend({ ids: [1] })).rejects.toThrow("Database not available");
  });

  it("returns successIds for draft invoices", async () => {
    queryResults.value = [
      { id: 1, status: "draft", invoiceNumber: "INV-001", issueDate: null, deletedAt: null },
      { id: 2, status: "draft", invoiceNumber: "INV-002", issueDate: null, deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchSend({ ids: [1, 2] });
    expect(result.successIds).toEqual(expect.arrayContaining([1, 2]));
    expect(result.failedIds).toHaveLength(0);
  });

  it("reports failedIds for ids not found in DB", async () => {
    queryResults.value = [
      { id: 1, status: "draft", invoiceNumber: "INV-001", issueDate: null, deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchSend({ ids: [1, 999] });
    expect(result.successIds).toContain(1);
    expect(result.failedIds.some((f) => f.id === 999 && f.reason.includes("not found"))).toBe(true);
  });

  it("reports failedIds for non-draft invoices", async () => {
    queryResults.value = [
      { id: 1, status: "sent", invoiceNumber: "INV-001", issueDate: new Date(), deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchSend({ ids: [1] });
    expect(result.successIds).toHaveLength(0);
    expect(result.failedIds[0].id).toBe(1);
    expect(result.failedIds[0].reason).toMatch(/draft/);
  });

  it("handles mixed: some draft, some non-draft, some missing", async () => {
    queryResults.value = [
      { id: 1, status: "draft", invoiceNumber: "INV-001", issueDate: null, deletedAt: null },
      { id: 2, status: "paid", invoiceNumber: "INV-002", issueDate: new Date(), deletedAt: null },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchSend({ ids: [1, 2, 999] });
    expect(result.successIds).toContain(1);
    expect(result.failedIds.some((f) => f.id === 2)).toBe(true);
    expect(result.failedIds.some((f) => f.id === 999)).toBe(true);
  });

  it("continues processing remaining ids even when DB update throws", async () => {
    queryResults.value = [
      { id: 1, status: "draft", invoiceNumber: "INV-001", issueDate: null, deletedAt: null },
      { id: 2, status: "draft", invoiceNumber: "INV-002", issueDate: null, deletedAt: null },
    ];

    const db = await mockGetDb();
    // First update call throws, second succeeds
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValue(new Error("constraint violation")),
      }),
    } as unknown as ReturnType<typeof db.update>);

    const caller = createCaller(makeCtx("super_admin"));
    const result = await caller.batchSend({ ids: [1, 2] });
    // id 2 should still succeed
    expect(result.failedIds.some((f) => f.id === 1)).toBe(true);
    expect(result.successIds).toContain(2);
  });
});

describe("invoices.list financial projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
  });

  it("adds invoice allocation and order credit balance without changing stored amounts", async () => {
    queryResults.value = [{
      invoices: {
        id: 12,
        status: "paid",
        dueDate: new Date("2026-07-01T00:00:00.000Z"),
        totalAmount: "1000.00",
        amountPaid: "1250.00",
        balanceDue: "0.00",
      },
      customers: { id: 3, name: "Test Customer" },
    }];

    const result = await createCaller(makeCtx("super_admin")).list();

    expect(result[0].invoices).toMatchObject({
      totalAmount: "1000.00",
      amountPaid: "1250.00",
      invoiceAllocated: 1000,
      orderCreditBalance: 250,
    });
  });
});

describe("invoices.deleteMany payment protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
  });

  it("blocks deletion when any invoice has recorded payments (status=paid)", async () => {
    queryResults.value = [
      { id: 1, status: "draft", amountPaid: "0" },
      { id: 2, status: "paid", amountPaid: "500" },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(caller.deleteMany({ ids: [1, 2] })).rejects.toThrow(/recorded payments/);
  });

  it("blocks deletion of a partially-paid invoice whose status is NOT 'paid'", async () => {
    // The bug P1-4 fixed: status != 'paid' but amountPaid > 0 must still be blocked.
    queryResults.value = [
      { id: 3, status: "sent", amountPaid: "120.50" },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(caller.deleteMany({ ids: [3] })).rejects.toThrow(/recorded payments/);
  });

  it("allows deletion when no invoice carries any payment", async () => {
    queryResults.value = [
      { id: 4, status: "draft", amountPaid: "0" },
      { id: 5, status: "sent", amountPaid: "0" },
    ];
    const caller = createCaller(makeCtx("super_admin"));
    await expect(caller.deleteMany({ ids: [4, 5] })).resolves.toMatchObject({ success: true });
  });
});
