/**
 * Admin Auth Routes — integration tests with mock Express req/res
 * Tests password-login, verify-session, logout (Express routes, not tRPC)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const {
  mockGetDb, queryResults, mockBcryptCompare,
  mockCreateAdminSession, mockGetAdminSession, mockDestroyAdminSession,
  mockCheckRateLimit,
  mockPurgeExpiredEntries,
  mockLoggerError,
} = vi.hoisted(() => {
  const queryResults: { value: unknown[] } = { value: [] };

  const createChain = (getResult: () => unknown[]) => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["select", "from", "where", "limit", "orderBy"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.limit = vi.fn().mockImplementation(() => Promise.resolve(getResult()));
    return chain;
  };

  const chain = createChain(() => [...queryResults.value]);

  const mockDb = {
    select: vi.fn().mockReturnValue(chain),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    queryResults,
    mockBcryptCompare: vi.fn().mockResolvedValue(true),
    mockCreateAdminSession: vi.fn().mockResolvedValue("admin-session-123"),
    mockGetAdminSession: vi.fn().mockResolvedValue(null),
    mockDestroyAdminSession: vi.fn().mockResolvedValue(undefined),
    mockCheckRateLimit: vi.fn().mockReturnValue(true),
    mockPurgeExpiredEntries: vi.fn(),
    mockLoggerError: vi.fn(),
  };
});

// ── Module mocks ───────────────────────────────────────────────────────
vi.mock("../server/db", () => ({
  getDb: mockGetDb,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((..._a: unknown[]) => "eq"),
  or: vi.fn((..._a: unknown[]) => "or"),
  and: vi.fn((..._a: unknown[]) => "and"),
  isNull: vi.fn((..._a: unknown[]) => "isNull"),
}));

vi.mock("../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    users: {
      id: col("id"), email: col("email"), username: col("username"),
      role: col("role"), isActive: col("isActive"),
      passwordHash: col("passwordHash"), deletedAt: col("deletedAt"),
      lastSignedIn: col("lastSignedIn"),
    },
  };
});

vi.mock("bcrypt", () => ({
  default: { compare: (...args: unknown[]) => mockBcryptCompare(...args) },
}));

vi.mock("../server/adminSession", () => ({
  createAdminSession: (...args: unknown[]) => mockCreateAdminSession(...args),
  getAdminSession: (...args: unknown[]) => mockGetAdminSession(...args),
  destroyAdminSession: (...args: unknown[]) => mockDestroyAdminSession(...args),
}));

vi.mock("../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: mockLoggerError, warn: vi.fn() },
}));

vi.mock("../shared/rateLimiter", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  purgeExpiredEntries: (...args: unknown[]) => mockPurgeExpiredEntries(...args),
}));

// ── Import the router ──────────────────────────────────────────────────
import adminAuthRouter, {
  getErrorDetails,
  purgeAdminLoginLimiterEntries,
} from "../server/adminAuthRoutes";

// ── Helper: create mock req/res ────────────────────────────────────────
function makeReq(body: Record<string, unknown> = {}, cookies: Record<string, string> = {}) {
  return { body, cookies, ip: "127.0.0.1" } as unknown as import("express").Request;
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  return res as unknown as import("express").Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

// Get route handlers from the express router
type RouteLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }>;
  };
};

function getHandler(method: "post" | "get", path: string) {
  const stack = (adminAuthRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[0].handle;
    }
  }
  throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
}

const passwordLoginHandler = getHandler("post", "/password-login");
const verifySessionHandler = getHandler("get", "/verify-session");
const logoutHandler = getHandler("post", "/logout");

const adminUser = {
  id: 1, email: "admin@test.com", username: "admin",
  role: "admin", isActive: true,
  passwordHash: "$2b$10$hashed",
};

// ── Tests ──────────────────────────────────────────────────────────────
describe("admin auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
    mockBcryptCompare.mockResolvedValue(true);
    mockCheckRateLimit.mockReturnValue(true);
  });

  describe("helper coverage", () => {
    it("extracts structured database error details", () => {
      const error = Object.assign(
        new Error("insert failed", { cause: new Error("duplicate key") }),
        {
          code: "23505",
          detail: "Key (token) already exists.",
          constraint: "sessions_token_key",
          table: "sessions",
          column: "token",
        }
      );

      expect(getErrorDetails(error)).toEqual(expect.objectContaining({
        message: "insert failed",
        code: "23505",
        detail: "Key (token) already exists.",
        constraint: "sessions_token_key",
        table: "sessions",
        column: "token",
        cause: "duplicate key",
      }));
    });

    it("normalizes primitive errors", () => {
      expect(getErrorDetails("login failed")).toEqual(expect.objectContaining({
        message: "login failed",
        name: "Error",
      }));
    });

    it("purges expired rate-limit entries", () => {
      purgeAdminLoginLimiterEntries();
      expect(mockPurgeExpiredEntries).toHaveBeenCalledTimes(1);
    });
  });

  // ── password-login ────────────────────────────────────────────────
  describe("POST /password-login", () => {
    it("returns 400 for missing credentials", async () => {
      const res = makeRes();
      await passwordLoginHandler(makeReq({}), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("returns 429 when rate limited", async () => {
      mockCheckRateLimit.mockReturnValueOnce(false);
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);
      expect(res.status).toHaveBeenCalledWith(429);
    });

    it("returns 500 when DB null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it("returns 401 for user not found", async () => {
      queryResults.value = [];
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "nobody", password: "pass" }), res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 401 for wrong password", async () => {
      queryResults.value = [adminUser];
      mockBcryptCompare.mockResolvedValueOnce(false);
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "wrong" }), res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 403 for non-admin role", async () => {
      queryResults.value = [{ ...adminUser, role: "user" }];
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("returns 403 for inactive user", async () => {
      queryResults.value = [{ ...adminUser, isActive: false }];
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("succeeds for valid admin", async () => {
      queryResults.value = [adminUser];
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      expect(mockCreateAdminSession).toHaveBeenCalled();
    });

    it("succeeds for super_admin", async () => {
      queryResults.value = [{ ...adminUser, role: "super_admin" }];
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it("returns 401 for user without passwordHash", async () => {
      queryResults.value = [{ ...adminUser, passwordHash: null }];
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns 500 on unexpected error", async () => {
      mockGetDb.mockRejectedValueOnce(new Error("DB crashed"));
      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it("logs structured database error details when session creation fails", async () => {
      queryResults.value = [adminUser];
      const dbError = Object.assign(
        new Error("insert failed", { cause: new Error("duplicate key") }),
        {
          code: "23505",
          detail: "Key (token) already exists.",
          constraint: "sessions_token_key",
          table: "sessions",
          column: "token",
        }
      );
      mockCreateAdminSession.mockRejectedValueOnce(dbError);

      const res = makeRes();
      await passwordLoginHandler(makeReq({ username: "admin", password: "pass" }), res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockLoggerError).toHaveBeenCalledWith(
        "[AdminAuth] Login error",
        expect.objectContaining({
          username: "admin",
          message: "insert failed",
          code: "23505",
          constraint: "sessions_token_key",
          table: "sessions",
          column: "token",
          cause: "duplicate key",
        })
      );
    });
  });

  // ── verify-session ────────────────────────────────────────────────
  describe("GET /verify-session", () => {
    it("returns 401 for no session", async () => {
      const res = makeRes();
      await verifySessionHandler(makeReq(), res);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("returns session info for valid session", async () => {
      mockGetAdminSession.mockResolvedValueOnce({
        email: "admin@test.com",
        role: "admin",
        expiresAt: new Date("2025-12-31"),
      });
      const res = makeRes();
      await verifySessionHandler(makeReq(), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        isAuthenticated: true,
        email: "admin@test.com",
      }));
    });
  });

  // ── logout ────────────────────────────────────────────────────────
  describe("POST /logout", () => {
    it("destroys session and returns success", async () => {
      const res = makeRes();
      await logoutHandler(makeReq(), res);
      expect(mockDestroyAdminSession).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true });
    });
  });
});
