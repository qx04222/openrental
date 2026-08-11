/**
 * Signature Evidence Router — integration tests via tRPC createCallerFactory
 * Tests getForRental and getForInspection procedures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────
const { mockGetDb, queryResults } = vi.hoisted(() => {
  const queryResults: { value: unknown[] } = { value: [] };

  const createChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of ["select", "from", "where", "orderBy", "limit", "leftJoin"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve([...queryResults.value]);
    return chain;
  };

  const chain = createChain();

  const mockDb = {
    select: vi.fn().mockReturnValue(chain),
    update: vi.fn().mockReturnValue(chain),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    queryResults,
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
    rentalRequests: {
      id: col("id"),
      customerId: col("customerId"),
      customerName: col("customerName"),
      totalAmount: col("totalAmount"),
      contractSignedAt: col("contractSignedAt"),
      signatureIp: col("signatureIp"),
      signatureUserAgent: col("signatureUserAgent"),
      signatureContractHash: col("signatureContractHash"),
      deletedAt: col("deletedAt"),
      status: col("status"),
    },
    inspections: {
      id: col("id"),
      type: col("type"),
      rentalId: col("rentalId"),
      rentalFleetId: col("rentalFleetId"),
      offlineId: col("offlineId"),
      customerSignedAt: col("customerSignedAt"),
      signatureIp: col("signatureIp"),
      signatureUserAgent: col("signatureUserAgent"),
      signatureDocumentHash: col("signatureDocumentHash"),
      deletedAt: col("deletedAt"),
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Test setup ─────────────────────────────────────────────────────────
import { signatureEvidenceRouter } from "../../server/routers/signatureEvidence.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(signatureEvidenceRouter);

function makeCtx(role: "super_admin" | "admin" = "super_admin"): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {}, headers: {} } as unknown as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: { id: 1, username: "admin", role, name: "Admin" },
  };
}

beforeEach(() => {
  queryResults.value = [];
  vi.clearAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("signatureEvidence.getForRental", () => {
  it("throws NOT_FOUND when rental does not exist", async () => {
    queryResults.value = [];
    const caller = createCaller(makeCtx());
    await expect(caller.getForRental({ rentalId: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns null signedAt when contract has not been signed", async () => {
    queryResults.value = [{
      id: 1,
      customerName: "Alice",
      totalAmount: "500.00",
      contractSignedAt: null,
      signatureIp: null,
      signatureUserAgent: null,
      signatureContractHash: null,
    }];
    const caller = createCaller(makeCtx());
    const result = await caller.getForRental({ rentalId: 1 });
    expect(result.signedAt).toBeNull();
    expect(result.signatureIp).toBeNull();
    expect(result.hashMatch).toBe(false);
    expect(result.originalContractHash).toBeNull();
  });

  it("returns all evidence fields when contract is signed", async () => {
    const signedAt = new Date("2026-04-18T10:00:00.000Z");
    queryResults.value = [{
      id: 42,
      customerName: "Bob",
      totalAmount: "1200.00",
      contractSignedAt: signedAt,
      signatureIp: "203.0.113.5",
      signatureUserAgent: "Mozilla/5.0",
      signatureContractHash: "abc123",
    }];
    const caller = createCaller(makeCtx());
    const result = await caller.getForRental({ rentalId: 42 });
    expect(result.signedAt).toEqual(signedAt);
    expect(result.signatureIp).toBe("203.0.113.5");
    expect(result.signatureUserAgent).toBe("Mozilla/5.0");
    expect(result.signatureContractHash).toBe("abc123");
  });

  it("flags hashMatch false when stored hash does not match recomputed hash", async () => {
    const signedAt = new Date("2026-04-18T10:00:00.000Z");
    queryResults.value = [{
      id: 5,
      customerName: "Charlie",
      totalAmount: "750.00",
      contractSignedAt: signedAt,
      signatureIp: "1.2.3.4",
      signatureUserAgent: "curl/7.0",
      signatureContractHash: "deadbeef000000000000000000000000deadbeef000000000000000000000000",
    }];
    const caller = createCaller(makeCtx());
    const result = await caller.getForRental({ rentalId: 5 });
    // The stored hash is a fake value that won't match the recomputed one
    expect(result.hashMatch).toBe(false);
  });

  it("flags hashMatch true when stored hash matches recomputed hash", async () => {
    // We need to reproduce the exact same hash the router computes
    const { hashDocument } = await import("../../server/services/signatureEvidence");
    const signedAt = new Date("2026-04-18T12:00:00.000Z");
    const contractContent = JSON.stringify({
      rentalId: 10,
      totalAmount: "900.00",
      customerName: "Dana",
      signedAt: signedAt.toISOString(),
    });
    const expectedHash = hashDocument(contractContent);

    queryResults.value = [{
      id: 10,
      customerName: "Dana",
      totalAmount: "900.00",
      contractSignedAt: signedAt,
      signatureIp: "10.0.0.1",
      signatureUserAgent: "TestAgent",
      signatureContractHash: expectedHash,
    }];
    const caller = createCaller(makeCtx());
    const result = await caller.getForRental({ rentalId: 10 });
    expect(result.hashMatch).toBe(true);
    expect(result.originalContractHash).toBe(expectedHash);
  });
});

describe("signatureEvidence.getForInspection", () => {
  it("throws NOT_FOUND when inspection does not exist", async () => {
    queryResults.value = [];
    const caller = createCaller(makeCtx());
    await expect(caller.getForInspection({ inspectionId: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns null signedAt when inspection has no signature", async () => {
    queryResults.value = [{
      id: 1,
      type: "dispatch",
      rentalId: 5,
      rentalFleetId: 2,
      offlineId: null,
      customerSignedAt: null,
      signatureIp: null,
      signatureUserAgent: null,
      signatureDocumentHash: null,
    }];
    const caller = createCaller(makeCtx());
    const result = await caller.getForInspection({ inspectionId: 1 });
    expect(result.signedAt).toBeNull();
    expect(result.hashMatch).toBe(false);
  });

  it("returns all evidence fields when inspection is signed", async () => {
    const signedAt = new Date("2026-04-18T09:30:00.000Z");
    queryResults.value = [{
      id: 7,
      type: "return",
      rentalId: 3,
      rentalFleetId: 1,
      offlineId: null,
      customerSignedAt: signedAt,
      signatureIp: "192.168.0.50",
      signatureUserAgent: "OpenRentalApp/1.0",
      signatureDocumentHash: "somehashvalue000000000000000000000000000000000000000000000000000",
    }];
    const caller = createCaller(makeCtx());
    const result = await caller.getForInspection({ inspectionId: 7 });
    expect(result.signedAt).toEqual(signedAt);
    expect(result.signatureIp).toBe("192.168.0.50");
    expect(result.signatureUserAgent).toBe("OpenRentalApp/1.0");
  });

  it("flags hashMatch true when stored hash matches recomputed hash", async () => {
    const { hashDocument } = await import("../../server/services/signatureEvidence");
    const signedAt = new Date("2026-04-18T08:00:00.000Z");
    const docContent = JSON.stringify({
      type: "dispatch",
      rentalId: 20,
      rentalFleetId: 3,
      customerSignedAt: signedAt.toISOString(),
      offlineId: null,
    });
    const expectedHash = hashDocument(docContent);

    queryResults.value = [{
      id: 15,
      type: "dispatch",
      rentalId: 20,
      rentalFleetId: 3,
      offlineId: null,
      customerSignedAt: signedAt,
      signatureIp: "172.16.0.1",
      signatureUserAgent: "Safari/605",
      signatureDocumentHash: expectedHash,
    }];
    const caller = createCaller(makeCtx());
    const result = await caller.getForInspection({ inspectionId: 15 });
    expect(result.hashMatch).toBe(true);
    expect(result.originalDocumentHash).toBe(expectedHash);
  });

  it("flags hashMatch false when stored hash is tampered", async () => {
    const signedAt = new Date("2026-04-18T07:00:00.000Z");
    queryResults.value = [{
      id: 20,
      type: "general",
      rentalId: null,
      rentalFleetId: 5,
      offlineId: "offline-abc",
      customerSignedAt: signedAt,
      signatureIp: "1.1.1.1",
      signatureUserAgent: "Chrome/120",
      signatureDocumentHash: "0000000000000000000000000000000000000000000000000000000000000000",
    }];
    const caller = createCaller(makeCtx());
    const result = await caller.getForInspection({ inspectionId: 20 });
    expect(result.hashMatch).toBe(false);
  });
});
