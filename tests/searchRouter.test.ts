/**
 * search.global procedure — unit tests
 * Covers: Zod validation, per-category result shape, numeric ID branch for rentals.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockGetDb, mockSelect, queryQueue } = vi.hoisted(() => {
  // Each call to db.select() consumes the next entry from queryQueue.
  // Tests push arrays into queryQueue in the order the procedure calls select().
  const queryQueue: { value: unknown[][] } = { value: [] };

  const createReadChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> & {
      then?: (resolve: (value: unknown[]) => void) => void;
    } = {};
    for (const method of ["from", "leftJoin", "where", "orderBy", "limit"]) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (value: unknown[]) => void) => {
      const next = queryQueue.value.shift() ?? [];
      resolve(next);
    };
    return chain;
  };

  const mockSelect = vi.fn().mockImplementation(() => createReadChain());
  const mockDb = { select: mockSelect };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    mockSelect,
    queryQueue,
  };
});

vi.mock("../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  and: vi.fn((..._a: unknown[]) => "and"),
  or: vi.fn((..._a: unknown[]) => "or"),
  ilike: vi.fn((..._a: unknown[]) => "ilike"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
  desc: vi.fn((..._a: unknown[]) => "desc"),
  sql: vi.fn((..._a: unknown[]) => "sql"),
}));

vi.mock("../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    customers: {
      id: col("id"), name: col("name"), email: col("email"), company: col("company"),
      phone: col("phone"), city: col("city"), totalRentals: col("totalRentals"),
      deletedAt: col("deletedAt"),
    },
    rentalFleet: {
      id: col("id"), brand: col("brand"), model: col("model"), category: col("category"),
      serialNumber: col("serialNumber"), currentStatus: col("currentStatus"),
      assetNumber: col("assetNumber"), deletedAt: col("deletedAt"),
    },
    rentalRequests: {
      id: col("id"), customerName: col("customerName"), customerEmail: col("customerEmail"),
      customerCompany: col("customerCompany"), status: col("status"),
      totalAmount: col("totalAmount"), startDate: col("startDate"), endDate: col("endDate"),
      rentalNumber: col("rentalNumber"), financialOrderNumber: col("financialOrderNumber"),
      rentalFleetId: col("rentalFleetId"), createdAt: col("createdAt"), deletedAt: col("deletedAt"),
    },
    invoices: {
      id: col("id"), invoiceNumber: col("invoiceNumber"), status: col("status"),
      totalAmount: col("totalAmount"), dueDate: col("dueDate"),
      customerId: col("customerId"), createdAt: col("createdAt"), deletedAt: col("deletedAt"),
    },
    projects: {
      id: col("id"), name: col("name"), status: col("status"), siteAddress: col("siteAddress"),
      city: col("city"), contactName: col("contactName"),
      createdAt: col("createdAt"), deletedAt: col("deletedAt"),
    },
  };
});

// ── Import router + create caller ──────────────────────────────────────
import { searchRouter } from "../server/routers/search.router";
import { t } from "../server/_core/trpc";
import type { TrpcContext } from "../server/_core/context";

const createCaller = t.createCallerFactory(searchRouter);

function adminCtx(): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 1,
      email: "admin@test.com",
      name: "Admin",
      username: "admin",
      role: "super_admin" as const,
      isActive: true,
      passwordHash: null,
      phone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      lastSignedIn: null,
      loginMethod: null,
    },
  };
}

// Helper: push one empty array per category (customers, fleet, rentals, invoices, projects)
function pushEmpty() {
  queryQueue.value.push([], [], [], [], []);
}

// ── Tests ──────────────────────────────────────────────────────────────
describe("search.global", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryQueue.value = [];
  });

  // ── Zod validation ────────────────────────────────────────────────
  describe("input validation", () => {
    it("rejects empty query string", async () => {
      const caller = createCaller(adminCtx());
      await expect(caller.global({ query: "" })).rejects.toThrow();
    });

    it("rejects query longer than 200 chars", async () => {
      const caller = createCaller(adminCtx());
      await expect(caller.global({ query: "x".repeat(201) })).rejects.toThrow();
    });

    it("rejects limit of 0", async () => {
      pushEmpty();
      const caller = createCaller(adminCtx());
      await expect(caller.global({ query: "abc", limit: 0 })).rejects.toThrow();
    });

    it("rejects limit above 20", async () => {
      pushEmpty();
      const caller = createCaller(adminCtx());
      await expect(caller.global({ query: "abc", limit: 21 })).rejects.toThrow();
    });
  });

  // ── Return shape ──────────────────────────────────────────────────
  describe("result shape", () => {
    it("returns all five category keys when db returns rows", async () => {
      const customer = { id: 1, name: "Alice", email: "a@test.com", company: null, phone: null, city: null, totalRentals: 2 };
      const fleet = { id: 10, brand: "CAT", model: "336", category: "excavator", serialNumber: "SN1", currentStatus: "available" };
      const rental = { id: 100, customerName: "Alice", status: "active", totalAmount: "1000", startDate: new Date(), endDate: new Date(), fleetBrand: "CAT", fleetModel: "336" };
      const invoice = { id: 200, invoiceNumber: "INV-001", status: "sent", totalAmount: "500", dueDate: new Date(), customerName: "Alice", customerEmail: "a@test.com" };
      const project = { id: 300, name: "Site A", status: "active", siteAddress: "123 Main St", city: "Calgary", contactName: "Bob" };

      queryQueue.value.push([customer], [fleet], [rental], [invoice], [project]);

      const caller = createCaller(adminCtx());
      const result = await caller.global({ query: "alice" });

      expect(result).toHaveProperty("customers");
      expect(result).toHaveProperty("fleet");
      expect(result).toHaveProperty("rentals");
      expect(result).toHaveProperty("invoices");
      expect(result).toHaveProperty("projects");

      expect(result.customers).toHaveLength(1);
      expect(result.fleet).toHaveLength(1);
      expect(result.rentals).toHaveLength(1);
      expect(result.invoices).toHaveLength(1);
      expect(result.projects).toHaveLength(1);
    });

    it("returns empty arrays when db returns nothing", async () => {
      pushEmpty();
      const caller = createCaller(adminCtx());
      const result = await caller.global({ query: "nomatch" });

      expect(result.customers).toEqual([]);
      expect(result.fleet).toEqual([]);
      expect(result.rentals).toEqual([]);
      expect(result.invoices).toEqual([]);
      expect(result.projects).toEqual([]);
    });

    it("customers shape includes expected fields", async () => {
      const customer = { id: 5, name: "Bob", email: "b@test.com", company: "Acme", phone: "555-0100", city: "Edmonton", totalRentals: 3 };
      queryQueue.value.push([customer], [], [], [], []);

      const caller = createCaller(adminCtx());
      const result = await caller.global({ query: "Bob" });

      const c = result.customers[0];
      expect(c).toMatchObject({ id: 5, name: "Bob", email: "b@test.com", totalRentals: 3 });
    });

    it("invoices shape includes invoiceNumber and status", async () => {
      const invoice = { id: 42, invoiceNumber: "INV-042", status: "paid", totalAmount: "250", dueDate: null, customerName: "Carol", customerEmail: "c@test.com" };
      queryQueue.value.push([], [], [], [invoice], []);

      const caller = createCaller(adminCtx());
      const result = await caller.global({ query: "INV" });

      expect(result.invoices[0]).toMatchObject({ invoiceNumber: "INV-042", status: "paid" });
    });

    it("selects human-readable rental numbers for the result row", async () => {
      pushEmpty();
      const caller = createCaller(adminCtx());
      await caller.global({ query: "SOT12701" });

      const rentalProjection = mockSelect.mock.calls[2]?.[0];
      expect(rentalProjection).toMatchObject({
        rentalNumber: "rentalNumber",
        financialOrderNumber: "financialOrderNumber",
      });
    });

    it("projects shape includes name and siteAddress", async () => {
      const project = { id: 7, name: "Warehouse Build", status: "active", siteAddress: "99 Industrial Rd", city: "Red Deer", contactName: "Dave" };
      queryQueue.value.push([], [], [], [], [project]);

      const caller = createCaller(adminCtx());
      const result = await caller.global({ query: "warehouse" });

      expect(result.projects[0]).toMatchObject({ name: "Warehouse Build", siteAddress: "99 Industrial Rd" });
    });
  });

  // ── Numeric ID branch for rentals ─────────────────────────────────
  describe("numeric query", () => {
    it("performs a select when query is numeric (ID match branch)", async () => {
      const rental = { id: 123, customerName: "Dave", status: "completed", totalAmount: "800", startDate: null, endDate: null, fleetBrand: null, fleetModel: null };
      queryQueue.value.push([], [], [rental], [], []);

      const caller = createCaller(adminCtx());
      const result = await caller.global({ query: "123" });

      // The rental matching on ID 123 is surfaced in the rentals array
      expect(result.rentals).toHaveLength(1);
      expect(result.rentals[0].id).toBe(123);
    });

    it("does not throw when query is a multi-digit number", async () => {
      pushEmpty();
      const caller = createCaller(adminCtx());
      await expect(caller.global({ query: "9999" })).resolves.toBeDefined();
    });
  });

  // ── DB unavailable ────────────────────────────────────────────────
  describe("db unavailable", () => {
    it("returns all empty arrays when db is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(adminCtx());
      const result = await caller.global({ query: "anything" });
      expect(result).toEqual({ customers: [], fleet: [], rentals: [], invoices: [], projects: [] });
    });
  });
});
