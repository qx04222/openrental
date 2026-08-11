/**
 * tests/routers/loginSessionsHeartbeat.test.ts
 *
 * heartbeat is best-effort "keep lastActiveAt fresh". The client fires it and
 * ignores the result, so a transient DB error must fail soft (return
 * { ok: false }) rather than throw a 5xx — which the fleet audit otherwise
 * flags as P0 noise. These tests lock in that contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
const { mockGetDb, updateBehavior } = vi.hoisted(() => {
  // Toggle whether the awaited update rejects (simulates a pooler recycle /
  // dropped connection mid-heartbeat).
  const updateBehavior: { reject: boolean } = { reject: false };

  const makeUpdateChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.set = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockImplementation(() =>
      updateBehavior.reject
        ? Promise.reject(new Error("connection terminated unexpectedly"))
        : Promise.resolve([]),
    );
    return chain;
  };

  const mockDb = { update: vi.fn().mockImplementation(() => makeUpdateChain()) };

  return { mockGetDb: vi.fn().mockResolvedValue(mockDb), updateBehavior };
});

// ── Module mocks ───────────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn(() => "eq"),
  and: vi.fn(() => "and"),
  isNull: vi.fn(() => "isNull"),
  gte: vi.fn(() => "gte"),
  lte: vi.fn(() => "lte"),
  desc: vi.fn(() => "desc"),
  sql: vi.fn(() => "sql"),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (n: string) => n;
  return {
    loginSessions: {
      id: col("id"), userId: col("userId"), sessionToken: col("sessionToken"),
      loginAt: col("loginAt"), logoutAt: col("logoutAt"), lastActiveAt: col("lastActiveAt"),
      durationSeconds: col("durationSeconds"), ipAddress: col("ipAddress"),
      browser: col("browser"), os: col("os"), deviceType: col("deviceType"),
    },
    users: { id: col("id"), name: col("name"), username: col("username") },
    rolePermissions: {},
    userPermissionOverrides: {},
  };
});

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// ── Import router + create caller ──────────────────────────────────────────
import { loginSessionsRouter } from "../../server/routers/loginSessions.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";
import { ADMIN_COOKIE_NAME } from "../../shared/const";

const createCaller = t.createCallerFactory(loginSessionsRouter);

function makeCtx(cookie?: string): TrpcContext {
  return {
    req: {
      ip: "127.0.0.1",
      cookies: cookie ? { [ADMIN_COOKIE_NAME]: cookie } : {},
    } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 1, email: "admin@test.com", name: "Admin", username: "admin",
      role: "admin" as const, isActive: true, passwordHash: null, phone: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      lastSignedIn: null, loginMethod: null,
    },
  } as TrpcContext;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe("loginSessions.heartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateBehavior.reject = false;
  });

  it("returns ok:true after a successful update", async () => {
    const caller = createCaller(makeCtx("session-token-abc"));
    await expect(caller.heartbeat()).resolves.toEqual({ ok: true });
  });

  it("returns ok:false without touching the db when no session cookie is present", async () => {
    const caller = createCaller(makeCtx());
    await expect(caller.heartbeat()).resolves.toEqual({ ok: false });
    expect(mockGetDb).toHaveBeenCalled();
  });

  it("fails soft (ok:false, never throws) when the db update rejects — no 5xx", async () => {
    updateBehavior.reject = true;
    const caller = createCaller(makeCtx("session-token-abc"));
    await expect(caller.heartbeat()).resolves.toEqual({ ok: false });
  });
});
