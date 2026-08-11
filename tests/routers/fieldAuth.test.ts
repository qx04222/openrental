/**
 * Field Auth Router — integration tests via tRPC createCallerFactory
 * Tests login flow: credentials, rate limiting, role checks, session creation, logout
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const {
  mockGetDb, selectResults, mockBcryptCompare,
  mockCreateFieldSession, mockDestroyFieldSession, mockCheckRateLimit,
  mockPurgeExpiredEntries,
} = vi.hoisted(() => {
  // We need separate result sets for the two sequential select queries in login
  const selectResults: { first: unknown[]; second: unknown[] } = { first: [], second: [] };
  let selectCallCount = 0;

  const createChain = (getResult: () => unknown[]) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    // Terminal: limit resolves the Promise
    chain.limit = vi.fn().mockImplementation(() => Promise.resolve(getResult()));
    return chain;
  };

  const mockDb = {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      const callNum = selectCallCount;
      return createChain(() => callNum === 1 ? selectResults.first : selectResults.second);
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    selectResults,
    mockBcryptCompare: vi.fn().mockResolvedValue(true),
    mockCreateFieldSession: vi.fn().mockResolvedValue("session-token-123"),
    mockDestroyFieldSession: vi.fn().mockResolvedValue(undefined),
    mockCheckRateLimit: vi.fn().mockReturnValue(true),
    mockPurgeExpiredEntries: vi.fn(),
    resetSelectCount: () => { selectCallCount = 0; },
  };
});

// ── Module mocks ───────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._a: unknown[]) => "eq"),
  and: vi.fn((..._a: unknown[]) => "and"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    users: {
      id: col("id"), email: col("email"), username: col("username"),
      name: col("name"), role: col("role"),
      isActive: col("isActive"), passwordHash: col("passwordHash"),
      deletedAt: col("deletedAt"),
    },
    refreshTokens: {
      userId: col("userId"), tokenHash: col("tokenHash"),
      authType: col("authType"), deviceName: col("deviceName"),
      expiresAt: col("expiresAt"),
    },
  };
});

vi.mock("bcrypt", () => ({
  default: { compare: (...args: unknown[]) => mockBcryptCompare(...args) },
}));

vi.mock("../../server/fieldSession", () => ({
  createFieldSession: (...args: unknown[]) => mockCreateFieldSession(...args),
  destroyFieldSession: (...args: unknown[]) => mockDestroyFieldSession(...args),
}));

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../shared/rateLimiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  purgeExpiredEntries: (...args: unknown[]) => mockPurgeExpiredEntries(...args),
}));

// ── Import router + create caller ──────────────────────────────────────
import {
  fieldAuthRouter,
  purgeFieldLoginLimiterEntries,
} from "../../server/routers/fieldAuth";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(fieldAuthRouter);

function makeCtx(): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: null,
  };
}

const validUser = {
  id: 1, email: "field@test.com", username: "fielduser", name: "Field User",
  role: "field_staff", isActive: true,
  passwordHash: "$2b$10$hashedpassword",
  createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
  lastSignedIn: null,
};

// ── Tests ──────────────────────────────────────────────────────────────
describe("fieldAuth router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults.first = [];
    selectResults.second = [];
    mockBcryptCompare.mockResolvedValue(true);
    mockCheckRateLimit.mockReturnValue(true);
    // Reset the select call counter by getting a fresh db mock
    mockGetDb.mockImplementation(async () => {
      let selectCallCount = 0;

      const createChain = (getResult: () => unknown[]) => {
        const chain: Record<string, ReturnType<typeof vi.fn>> = {};
        for (const m of ["from", "where", "orderBy"]) {
          chain[m] = vi.fn().mockReturnValue(chain);
        }
        chain.limit = vi.fn().mockImplementation(() => Promise.resolve(getResult()));
        return chain;
      };

      return {
        select: vi.fn().mockImplementation(() => {
          selectCallCount++;
          const callNum = selectCallCount;
          return createChain(() => callNum === 1 ? selectResults.first : selectResults.second);
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
    });
  });

  // ── login ─────────────────────────────────────────────────────────
  describe("login", () => {
    it("succeeds with valid credentials (username match)", async () => {
      selectResults.first = [validUser]; // username match
      const ctx = makeCtx();
      const caller = createCaller(ctx);
      const result = await caller.login({ identifier: "fielduser", password: "pass123" });
      expect(result.success).toBe(true);
      expect(result.user.id).toBe(1);
      expect(result.refreshToken).toBeDefined();
      expect(mockCreateFieldSession).toHaveBeenCalledWith(1, expect.any(Number));
      expect(ctx.res.cookie).toHaveBeenCalled();
    });

    it("succeeds with email fallback (username not found)", async () => {
      selectResults.first = []; // username NOT found
      selectResults.second = [validUser]; // email found
      const ctx = makeCtx();
      const caller = createCaller(ctx);
      const result = await caller.login({ identifier: "field@test.com", password: "pass123" });
      expect(result.success).toBe(true);
    });

    it("rejects when rate limited", async () => {
      mockCheckRateLimit.mockReturnValueOnce(false);
      const caller = createCaller(makeCtx());
      await expect(
        caller.login({ identifier: "test", password: "pass" }),
      ).rejects.toThrow("Too many login attempts");
    });

    it("rejects when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx());
      await expect(
        caller.login({ identifier: "test", password: "pass" }),
      ).rejects.toThrow("Database not available");
    });

    it("rejects invalid credentials (user not found)", async () => {
      selectResults.first = [];
      selectResults.second = [];
      const caller = createCaller(makeCtx());
      await expect(
        caller.login({ identifier: "nobody", password: "pass" }),
      ).rejects.toThrow("Invalid credentials");
    });

    it("rejects non-field-staff roles", async () => {
      selectResults.first = [{ ...validUser, role: "viewer" }];
      const caller = createCaller(makeCtx());
      await expect(
        caller.login({ identifier: "test", password: "pass" }),
      ).rejects.toThrow("Field staff access required");
    });

    it("rejects inactive users", async () => {
      selectResults.first = [{ ...validUser, isActive: false }];
      const caller = createCaller(makeCtx());
      await expect(
        caller.login({ identifier: "test", password: "pass" }),
      ).rejects.toThrow("Account is inactive");
    });

    it("rejects when password not set", async () => {
      selectResults.first = [{ ...validUser, passwordHash: null }];
      const caller = createCaller(makeCtx());
      await expect(
        caller.login({ identifier: "test", password: "pass" }),
      ).rejects.toThrow("Password not set");
    });

    it("rejects wrong password", async () => {
      selectResults.first = [validUser];
      mockBcryptCompare.mockResolvedValueOnce(false);
      const caller = createCaller(makeCtx());
      await expect(
        caller.login({ identifier: "test", password: "wrong" }),
      ).rejects.toThrow("Invalid credentials");
    });

    it("uses 30-day session with rememberMe", async () => {
      selectResults.first = [validUser];
      const caller = createCaller(makeCtx());
      await caller.login({ identifier: "test", password: "pass", rememberMe: true });
      expect(mockCreateFieldSession).toHaveBeenCalledWith(1, 30 * 24 * 60 * 60 * 1000);
    });

    it("uses 7-day session without rememberMe", async () => {
      selectResults.first = [validUser];
      const caller = createCaller(makeCtx());
      await caller.login({ identifier: "test", password: "pass", rememberMe: false });
      expect(mockCreateFieldSession).toHaveBeenCalledWith(1, 7 * 24 * 60 * 60 * 1000);
    });

    it("allows super_admin role", async () => {
      selectResults.first = [{ ...validUser, role: "super_admin" }];
      const caller = createCaller(makeCtx());
      const result = await caller.login({ identifier: "test", password: "pass" });
      expect(result.success).toBe(true);
    });

    it("allows admin role", async () => {
      selectResults.first = [{ ...validUser, role: "admin" }];
      const caller = createCaller(makeCtx());
      const result = await caller.login({ identifier: "test", password: "pass" });
      expect(result.success).toBe(true);
    });
  });

  // ── logout ────────────────────────────────────────────────────────
  describe("logout", () => {
    it("destroys session and clears cookies", async () => {
      const ctx = makeCtx();
      (ctx.req as unknown as { cookies: Record<string, string> }).cookies = { openrental_field_session: "token123" };
      const caller = createCaller(ctx);
      const result = await caller.logout();
      expect(result).toEqual({ success: true });
      expect(mockDestroyFieldSession).toHaveBeenCalledWith("token123");
      expect(ctx.res.clearCookie).toHaveBeenCalled();
    });

    it("succeeds even without session cookie", async () => {
      const caller = createCaller(makeCtx());
      const result = await caller.logout();
      expect(result).toEqual({ success: true });
      expect(mockDestroyFieldSession).not.toHaveBeenCalled();
    });

    it("falls back to the main app session cookie", async () => {
      const ctx = makeCtx();
      (ctx.req as unknown as { cookies: Record<string, string> }).cookies = { openrental_session_id: "shared-token" };
      const caller = createCaller(ctx);
      await caller.logout();
      expect(mockDestroyFieldSession).toHaveBeenCalledWith("shared-token");
    });
  });

  describe("helper coverage", () => {
    it("purges expired field login rate-limit entries", () => {
      purgeFieldLoginLimiterEntries();
      expect(mockPurgeExpiredEntries).toHaveBeenCalledTimes(1);
    });
  });
});
