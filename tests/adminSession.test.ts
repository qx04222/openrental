/**
 * Admin Session — unit tests with DB mock
 *
 * Tests createAdminSession (await-then-cookie), getAdminSession, destroyAdminSession
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInsert, mockDelete, mockGetDb, selectResultRef } = vi.hoisted(() => {
  const selectResultRef: { value: unknown[] } = { value: [] };
  const mockInsert = vi.fn();
  const mockDelete = vi.fn();

  const mockDb = {
    insert: mockInsert,
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => Promise.resolve([...selectResultRef.value])),
        })),
      })),
    })),
    delete: mockDelete,
  };
  const mockGetDb = vi.fn().mockResolvedValue(mockDb);
  return { mockInsert, mockDelete, mockGetDb, selectResultRef };
});

vi.mock("../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((_col: unknown, _val: unknown) => "eq"),
  and: vi.fn((..._args: unknown[]) => "and"),
}));

vi.mock("../drizzle/schema", () => ({
  sessions: {
    token: "token",
    sessionType: "sessionType",
    userId: "userId",
    email: "email",
    role: "role",
    expiresAt: "expiresAt",
    createdAt: "createdAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  lte: vi.fn((_col: unknown, _val: unknown) => "lte"),
}));

vi.mock("../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  createAdminSession,
  getAdminSession,
  destroyAdminSession,
  cleanupExpiredSessions,
} from "../server/adminSession";

describe("adminSession", () => {
  let mockRes: {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
  let mockReq: { cookies: Record<string, string> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    mockDelete.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    selectResultRef.value = [];

    mockRes = {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    };
    mockReq = { cookies: {} };
  });

  describe("createAdminSession", () => {
    it("should persist session to DB before setting cookie", async () => {
      const callOrder: string[] = [];
      const mockValues = vi.fn().mockImplementation(() => {
        callOrder.push("db_insert");
        return Promise.resolve();
      });
      mockInsert.mockReturnValue({ values: mockValues });
      mockRes.cookie.mockImplementation(() => {
        callOrder.push("set_cookie");
      });

      const sessionId = await createAdminSession(
        mockRes as never,
        { email: "admin@test.com", role: "admin", userId: 1 },
      );

      expect(typeof sessionId).toBe("string");
      expect(sessionId).toHaveLength(64); // 32 bytes hex
      expect(callOrder).toEqual(["db_insert", "set_cookie"]);
    });

    it("should set httpOnly cookie with correct options", async () => {
      await createAdminSession(
        mockRes as never,
        { email: "admin@test.com", userId: 1 },
      );

      expect(mockRes.cookie).toHaveBeenCalledWith(
        "openrental_admin_session",
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          path: "/",
        }),
      );
    });

    it("should use remember-me duration when specified", async () => {
      await createAdminSession(
        mockRes as never,
        { email: "admin@test.com", userId: 1 },
        { rememberMe: true },
      );

      const cookieCall = mockRes.cookie.mock.calls[0];
      expect(cookieCall[2].maxAge).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("should use default 24h duration without rememberMe", async () => {
      await createAdminSession(
        mockRes as never,
        { email: "admin@test.com", userId: 1 },
      );

      const cookieCall = mockRes.cookie.mock.calls[0];
      expect(cookieCall[2].maxAge).toBe(24 * 60 * 60 * 1000);
    });

    it("should throw if DB insert fails", async () => {
      mockInsert.mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error("DB connection refused")),
      });

      await expect(
        createAdminSession(mockRes as never, { email: "admin@test.com", userId: 1 }),
      ).rejects.toThrow("DB connection refused");

      expect(mockRes.cookie).not.toHaveBeenCalled();
    });

    it("should skip DB persist if no userId provided", async () => {
      await createAdminSession(
        mockRes as never,
        { email: "admin@test.com" },
      );

      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockRes.cookie).toHaveBeenCalled();
    });

    it("should use custom durationMs when provided", async () => {
      const customMs = 2 * 60 * 60 * 1000;
      await createAdminSession(
        mockRes as never,
        { email: "admin@test.com", userId: 1 },
        { durationMs: customMs },
      );

      const cookieCall = mockRes.cookie.mock.calls[0];
      expect(cookieCall[2].maxAge).toBe(customMs);
    });

    it("should throw if DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);

      await expect(
        createAdminSession(mockRes as never, { email: "admin@test.com", userId: 1 }),
      ).rejects.toThrow("Database not available");
    });
  });

  describe("getAdminSession", () => {
    it("should return null if no cookie", async () => {
      mockReq.cookies = {};
      const result = await getAdminSession(mockReq as never);
      expect(result).toBeNull();
    });

    it("should return null if session not found in DB", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      selectResultRef.value = [];
      const result = await getAdminSession(mockReq as never);
      expect(result).toBeNull();
    });

    it("should return session data if valid and not expired", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      const future = new Date(Date.now() + 3600000);
      selectResultRef.value = [{
        token: "test-token",
        sessionType: "admin",
        email: "admin@test.com",
        role: "admin",
        createdAt: new Date(),
        expiresAt: future,
      }];

      const result = await getAdminSession(mockReq as never);
      expect(result).not.toBeNull();
      expect(result!.email).toBe("admin@test.com");
      expect(result!.role).toBe("admin");
    });

    it("should surface userId so context can resolve user by stable PK (not email)", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      selectResultRef.value = [{
        token: "test-token",
        sessionType: "admin",
        userId: 42,
        email: null, // email-less admin (logged in by username) must still resolve
        role: "super_admin",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      }];

      const result = await getAdminSession(mockReq as never);
      expect(result!.userId).toBe(42);
    });

    it("should delete and return null for expired sessions", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      const past = new Date(Date.now() - 3600000);
      selectResultRef.value = [{
        token: "test-token",
        sessionType: "admin",
        email: "admin@test.com",
        role: "admin",
        createdAt: new Date(Date.now() - 7200000),
        expiresAt: past,
      }];

      const result = await getAdminSession(mockReq as never);
      expect(result).toBeNull();
      expect(mockDelete).toHaveBeenCalled();
    });

    it("should return null if DB is unavailable", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      mockGetDb.mockResolvedValueOnce(null);

      const result = await getAdminSession(mockReq as never);
      expect(result).toBeNull();
    });

    it("should default role to admin if not set in session", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      selectResultRef.value = [{
        token: "test-token",
        sessionType: "admin",
        email: "admin@test.com",
        role: undefined,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      }];

      const result = await getAdminSession(mockReq as never);
      expect(result!.role).toBe("admin");
    });
  });

  describe("destroyAdminSession", () => {
    it("should delete session from DB and clear cookie", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      await destroyAdminSession(mockReq as never, mockRes as never);

      expect(mockDelete).toHaveBeenCalled();
      expect(mockRes.clearCookie).toHaveBeenCalled();
    });

    it("should clear cookie even if no session token", async () => {
      mockReq.cookies = {};
      await destroyAdminSession(mockReq as never, mockRes as never);

      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockRes.clearCookie).toHaveBeenCalled();
    });

    it("should handle DB error gracefully", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      mockDelete.mockReturnValueOnce({
        where: vi.fn().mockRejectedValue(new Error("DB error")),
      });

      await expect(
        destroyAdminSession(mockReq as never, mockRes as never),
      ).resolves.not.toThrow();
      expect(mockRes.clearCookie).toHaveBeenCalled();
    });
  });

  describe("cleanupExpiredSessions", () => {
    it("should delete expired sessions", async () => {
      await cleanupExpiredSessions();
      expect(mockDelete).toHaveBeenCalled();
    });

    it("should not throw if DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      await expect(cleanupExpiredSessions()).resolves.not.toThrow();
    });

    it("should not throw on Error instance", async () => {
      mockDelete.mockReturnValueOnce({
        where: vi.fn().mockRejectedValue(new Error("cleanup error")),
      });
      await expect(cleanupExpiredSessions()).resolves.not.toThrow();
    });

    it("should not throw on non-Error throw", async () => {
      mockDelete.mockReturnValueOnce({
        where: vi.fn().mockRejectedValue("string error"),
      });
      await expect(cleanupExpiredSessions()).resolves.not.toThrow();
    });
  });

  describe("getAdminSession error paths", () => {
    it("should return null and log error on DB query failure (Error instance)", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      mockGetDb.mockResolvedValueOnce({
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => ({
              limit: vi.fn().mockRejectedValue(new Error("query crash")),
            })),
          })),
        })),
        delete: mockDelete,
      });

      const result = await getAdminSession(mockReq as never);
      expect(result).toBeNull();
    });

    it("should return null and log error on non-Error throw", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      mockGetDb.mockResolvedValueOnce({
        select: vi.fn().mockImplementation(() => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => ({
              limit: vi.fn().mockRejectedValue("string error"),
            })),
          })),
        })),
        delete: mockDelete,
      });

      const result = await getAdminSession(mockReq as never);
      expect(result).toBeNull();
    });

    it("should return empty email for session with null email", async () => {
      mockReq.cookies = { openrental_admin_session: "test-token" };
      selectResultRef.value = [{
        token: "test-token",
        sessionType: "admin",
        email: null,
        role: "admin",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
      }];

      const result = await getAdminSession(mockReq as never);
      expect(result!.email).toBe("");
    });
  });
});
