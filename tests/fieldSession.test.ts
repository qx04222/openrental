/**
 * Field Session — unit tests with DB mock
 *
 * Tests createFieldSession (await-then-persist), getFieldSessionUserId, destroyFieldSession
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInsert, mockSelect, mockDelete, mockSelectResult, mockGetDb } = vi.hoisted(() => {
  const mockSelectResult: unknown[] = [];
  const mockInsert = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  const mockSelect = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(() => Promise.resolve([...mockSelectResult])),
      }),
    }),
  });
  const mockDelete = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  const mockDb = { insert: mockInsert, select: mockSelect, delete: mockDelete };
  const mockGetDb = vi.fn().mockResolvedValue(mockDb);
  return { mockInsert, mockSelect, mockDelete, mockSelectResult, mockGetDb };
});

vi.mock("../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((_col: unknown, val: unknown) => ({ _eq: val })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
}));

vi.mock("../drizzle/schema", () => ({
  sessions: {
    token: "token",
    sessionType: "sessionType",
    userId: "userId",
    expiresAt: "expiresAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  lte: vi.fn((_col: unknown, val: unknown) => ({ _lte: val })),
}));

vi.mock("../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  createFieldSession,
  getFieldSessionUserId,
  destroyFieldSession,
  cleanupExpiredSessions,
} from "../server/fieldSession";

describe("fieldSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
    mockSelectResult.length = 0;
  });

  describe("createFieldSession", () => {
    it("should return a UUID token after persisting to DB", async () => {
      const token = await createFieldSession(42);
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(mockInsert).toHaveBeenCalled();
    });

    it("should use default 30-day duration if not specified", async () => {
      const mockValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: mockValues });

      await createFieldSession(42);

      const insertArg = mockValues.mock.calls[0][0];
      const expiresAt = insertArg.expiresAt as Date;
      const expectedMs = 30 * 24 * 60 * 60 * 1000;
      expect(Math.abs(expiresAt.getTime() - Date.now() - expectedMs)).toBeLessThan(5000);
    });

    it("should use custom duration when provided", async () => {
      const mockValues = vi.fn().mockResolvedValue(undefined);
      mockInsert.mockReturnValue({ values: mockValues });

      const customDuration = 7 * 24 * 60 * 60 * 1000;
      await createFieldSession(42, customDuration);

      const insertArg = mockValues.mock.calls[0][0];
      const expiresAt = insertArg.expiresAt as Date;
      expect(Math.abs(expiresAt.getTime() - Date.now() - customDuration)).toBeLessThan(5000);
    });

    it("should throw if DB insert fails (not fire-and-forget)", async () => {
      mockInsert.mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error("connection timeout")),
      });

      await expect(createFieldSession(42)).rejects.toThrow("connection timeout");
    });

    it("should throw if DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);

      await expect(createFieldSession(42)).rejects.toThrow("Database not available");
    });
  });

  describe("getFieldSessionUserId", () => {
    it("should return userId for valid, non-expired session", async () => {
      mockSelectResult.push({
        token: "test-uuid",
        sessionType: "field",
        userId: 42,
        expiresAt: new Date(Date.now() + 3600000),
      });

      const userId = await getFieldSessionUserId("test-uuid");
      expect(userId).toBe(42);
    });

    it("should return undefined for non-existent token", async () => {
      const userId = await getFieldSessionUserId("nonexistent-token");
      expect(userId).toBeUndefined();
    });

    it("should return undefined and delete expired session", async () => {
      mockSelectResult.push({
        token: "expired-uuid",
        sessionType: "field",
        userId: 42,
        expiresAt: new Date(Date.now() - 3600000),
      });

      const userId = await getFieldSessionUserId("expired-uuid");
      expect(userId).toBeUndefined();
      expect(mockDelete).toHaveBeenCalled();
    });

    it("should return undefined if DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);

      const userId = await getFieldSessionUserId("test-uuid");
      expect(userId).toBeUndefined();
    });

    it("should handle DB errors gracefully (Error instance)", async () => {
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error("query failed")),
          }),
        }),
      });

      const userId = await getFieldSessionUserId("test-uuid");
      expect(userId).toBeUndefined();
    });

    it("should handle non-Error throw gracefully", async () => {
      mockSelect.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue("string error"),
          }),
        }),
      });

      const userId = await getFieldSessionUserId("test-uuid");
      expect(userId).toBeUndefined();
    });
  });

  describe("destroyFieldSession", () => {
    it("should delete session from DB", async () => {
      await destroyFieldSession("test-uuid");
      expect(mockDelete).toHaveBeenCalled();
    });

    it("should not throw on DB error", async () => {
      mockDelete.mockReturnValueOnce({
        where: vi.fn().mockRejectedValue(new Error("DB error")),
      });

      await expect(destroyFieldSession("test-uuid")).resolves.not.toThrow();
    });

    it("should not throw if DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      await expect(destroyFieldSession("test-uuid")).resolves.not.toThrow();
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

    it("should not throw on DB error", async () => {
      mockDelete.mockReturnValueOnce({
        where: vi.fn().mockRejectedValue(new Error("cleanup error")),
      });
      await expect(cleanupExpiredSessions()).resolves.not.toThrow();
    });
  });
});
