/**
 * auditLog.search router — unit tests via tRPC createCallerFactory.
 * Covers: role guard, filter combinations, facet aggregation, pagination.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────
const { mockGetDb, queryQueue } = vi.hoisted(() => {
  const queryQueue: { value: unknown[][] } = { value: [] };

  const nextResult = () => {
    if (queryQueue.value.length > 0) {
      return queryQueue.value.shift()!;
    }
    return [];
  };

  const createChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> & {
      then?: (resolve: (v: unknown[]) => void) => void;
    } = {};
    for (const m of [
      "select",
      "from",
      "leftJoin",
      "where",
      "orderBy",
      "limit",
      "offset",
      "groupBy",
    ]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve) => resolve(nextResult());
    return chain;
  };

  const mockDb = {
    select: vi.fn().mockImplementation(() => createChain()),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    queryQueue,
  };
});

// ── Module mocks ───────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  and: vi.fn((..._a: unknown[]) => "and"),
  or: vi.fn((..._a: unknown[]) => "or"),
  gte: vi.fn((..._a: unknown[]) => "gte"),
  lte: vi.fn((..._a: unknown[]) => "lte"),
  desc: vi.fn((..._a: unknown[]) => "desc"),
  ilike: vi.fn((..._a: unknown[]) => "ilike"),
  sql: Object.assign(vi.fn((..._a: unknown[]) => "sql"), {
    raw: vi.fn((..._a: unknown[]) => "sql_raw"),
  }),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    auditLogs: {
      id: col("id"),
      userId: col("userId"),
      action: col("action"),
      entityType: col("entityType"),
      entityId: col("entityId"),
      changes: col("changes"),
      ipAddress: col("ipAddress"),
      createdAt: col("createdAt"),
    },
    users: {
      id: col("id"),
      name: col("name"),
      username: col("username"),
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

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// ── Import router ──────────────────────────────────────────────
import { auditLogRouter } from "../../server/routers/auditLog.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(auditLogRouter);

function makeCtx(role?: "super_admin" | "admin" | "user"): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: role
      ? {
          id: 1,
          email: "admin@test.com",
          name: "Test Admin",
          username: "test-admin",
          role,
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

/** Push N results onto the queue (each call to the DB consumes one batch). */
function enqueue(...batches: unknown[][]) {
  queryQueue.value.push(...batches);
}

/** Minimal audit row shape returned by the mock DB */
function makeRow(overrides: Partial<{
  id: number;
  userId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  changes: string | null;
  ipAddress: string | null;
  createdAt: Date;
  userName: string | null;
  userUsername: string | null;
}> = {}) {
  return {
    id: 1,
    userId: 1,
    action: "create",
    entityType: "rental",
    entityId: 10,
    changes: null,
    ipAddress: "127.0.0.1",
    createdAt: new Date("2024-01-01T10:00:00Z"),
    userName: "Alice",
    userUsername: "alice",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("auditLog.search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryQueue.value = [];
  });

  // ── Role guard ──────────────────────────────────────────────

  describe("role guard", () => {
    it("rejects unauthenticated callers with UNAUTHORIZED", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.search({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("rejects admin role with FORBIDDEN", async () => {
      const caller = createCaller(makeCtx("admin"));
      await expect(caller.search({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects user role with FORBIDDEN", async () => {
      const caller = createCaller(makeCtx("user"));
      await expect(caller.search({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("allows super_admin", async () => {
      // rows, count, user facets, action facets, entityType facets
      enqueue(
        [makeRow()],
        [{ count: 1 }],
        [{ id: 1, count: 1 }],
        [{ action: "create", count: 1 }],
        [{ type: "rental", count: 1 }],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({});
      expect(result.rows).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  // ── Filter combinations ────────────────────────────────────

  describe("filters", () => {
    it("returns rows with no filters", async () => {
      enqueue(
        [makeRow(), makeRow({ id: 2 })],
        [{ count: 2 }],
        [],
        [],
        [],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({});
      expect(result.rows).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("respects userId filter", async () => {
      enqueue(
        [makeRow({ userId: 5 })],
        [{ count: 1 }],
        [{ id: 5, count: 1 }],
        [{ action: "create", count: 1 }],
        [{ type: "rental", count: 1 }],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({ userId: 5 });
      expect(result.rows[0].userId).toBe(5);
    });

    it("respects entityType filter", async () => {
      enqueue(
        [makeRow({ entityType: "fleet" })],
        [{ count: 1 }],
        [],
        [],
        [{ type: "fleet", count: 1 }],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({ entityType: "fleet" });
      expect(result.rows[0].entityType).toBe("fleet");
    });

    it("respects action filter", async () => {
      enqueue(
        [makeRow({ action: "delete" })],
        [{ count: 1 }],
        [],
        [{ action: "delete", count: 1 }],
        [],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({ action: "delete" });
      expect(result.rows[0].action).toBe("delete");
    });

    it("respects dateFrom and dateTo filters (accepts strings)", async () => {
      enqueue(
        [makeRow()],
        [{ count: 1 }],
        [],
        [],
        [],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({
        dateFrom: "2024-01-01",
        dateTo: "2024-12-31",
      });
      expect(result.rows).toHaveLength(1);
    });

    it("respects free-text query filter", async () => {
      enqueue(
        [makeRow({ ipAddress: "10.0.0.1" })],
        [{ count: 1 }],
        [],
        [],
        [],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({ query: "10.0.0" });
      expect(result.rows[0].ipAddress).toBe("10.0.0.1");
    });

    it("returns empty rows when no matches", async () => {
      enqueue(
        [],
        [{ count: 0 }],
        [],
        [],
        [],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({ entityType: "nonexistent" });
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // ── Facet aggregation ──────────────────────────────────────

  describe("facets", () => {
    it("returns user facets with id and count", async () => {
      enqueue(
        [],
        [{ count: 0 }],
        [{ id: 1, count: 5 }, { id: 2, count: 3 }],
        [],
        [],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({});
      expect(result.facets.users).toEqual([
        { id: 1, count: 5 },
        { id: 2, count: 3 },
      ]);
    });

    it("returns action facets with action and count", async () => {
      enqueue(
        [],
        [{ count: 0 }],
        [],
        [{ action: "create", count: 10 }, { action: "delete", count: 2 }],
        [],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({});
      expect(result.facets.actions).toEqual([
        { action: "create", count: 10 },
        { action: "delete", count: 2 },
      ]);
    });

    it("returns entityType facets with type and count", async () => {
      enqueue(
        [],
        [{ count: 0 }],
        [],
        [],
        [{ type: "rental", count: 20 }, { type: "fleet", count: 4 }],
      );
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({});
      expect(result.facets.entityTypes).toEqual([
        { type: "rental", count: 20 },
        { type: "fleet", count: 4 },
      ]);
    });

    it("returns empty facets when DB has no data", async () => {
      enqueue([], [{ count: 0 }], [], [], []);
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({});
      expect(result.facets.users).toEqual([]);
      expect(result.facets.actions).toEqual([]);
      expect(result.facets.entityTypes).toEqual([]);
    });
  });

  // ── Pagination ─────────────────────────────────────────────

  describe("pagination", () => {
    it("respects limit and offset defaults (50/0)", async () => {
      enqueue([], [{ count: 0 }], [], [], []);
      const caller = createCaller(makeCtx("super_admin"));
      // Should not throw — defaults are applied by Zod schema
      await expect(caller.search({})).resolves.toBeDefined();
    });

    it("respects custom limit and offset", async () => {
      enqueue([], [{ count: 100 }], [], [], []);
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({ limit: 10, offset: 20 });
      expect(result.total).toBe(100);
    });

    it("rejects limit above 200", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.search({ limit: 201 })).rejects.toThrow();
    });

    it("rejects negative offset", async () => {
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.search({ offset: -1 })).rejects.toThrow();
    });
  });

  // ── DB unavailable ─────────────────────────────────────────

  describe("DB unavailable", () => {
    it("returns empty result when DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.search({});
      expect(result).toEqual({
        rows: [],
        total: 0,
        facets: { users: [], actions: [], entityTypes: [] },
      });
    });
  });
});
