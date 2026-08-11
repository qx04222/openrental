/**
 * downtime.update — in-place correction of a recorded downtime row.
 *
 * Pins the two business rules the shared guard enforces for this module:
 *   1. once a credit note has been issued (creditInvoiceId set) the row is frozen;
 *   2. once the parent order is closed/cancelled/settled the row is frozen.
 * Plus: the reason is mandatory evidence, the audit entry carries rentalRequestId
 * (without it the order's change-history tab cannot see it), and moving the
 * downtime window recomputes the derived day counts instead of leaving them stale.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetDb, selectQueue, updateCalls, logAudit } = vi.hoisted(() => {
  const logAudit = vi.fn().mockResolvedValue(undefined);
  const selectQueue: { value: unknown[][] } = { value: [] };
  const updateCalls: { value: Record<string, unknown>[] } = { value: [] };

  const nextSelect = () => (selectQueue.value.length > 0 ? selectQueue.value.shift()! : []);

  const createChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit", "offset", "groupBy"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (v: unknown[]) => void) => resolve(nextSelect());
    return chain;
  };

  const mockDb = {
    select: vi.fn(() => createChain()),
    update: vi.fn(() => ({
      set: (patch: Record<string, unknown>) => {
        updateCalls.value.push(patch);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: 1 }]),
            then: (resolve: (v: unknown) => void) => resolve([{ id: 1 }]),
          }),
        };
      },
    })),
  };

  return { mockGetDb: vi.fn().mockResolvedValue(mockDb), selectQueue, updateCalls, logAudit };
});

vi.mock("../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn(() => "eq"),
  and: vi.fn(() => "and"),
  desc: vi.fn(() => "desc"),
  isNull: vi.fn(() => "isNull"),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, eq: vi.fn(() => "eq"), and: vi.fn(() => "and"), isNull: vi.fn(() => "isNull") };
});

vi.mock("../server/services/auditLog", () => ({ logAudit }));

import { downtimeRouter } from "../server/routers/downtime.router";
import { t } from "../server/_core/trpc";
import type { TrpcContext } from "../server/_core/context";

const caller = t.createCallerFactory(downtimeRouter);

function ctx(): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    // super_admin short-circuits moduleGuard's permission lookup.
    user: {
      id: 7,
      email: "a@test.com",
      name: "A",
      username: "a",
      role: "super_admin",
      isActive: true,
      passwordHash: null,
      phone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      lastSignedIn: null,
      loginMethod: null,
    },
  } as unknown as TrpcContext;
}

const baseRecord = {
  id: 1,
  rentalId: 42,
  rentalFleetId: 5,
  reportedAt: new Date("2026-03-02T14:00:00Z"),
  resolvedAt: null,
  totalCalendarDays: 0,
  excludedDays: 0,
  workingDaysLost: 0,
  dailyRateAtTime: "100.00",
  creditAmount: "0",
  status: "open",
  reason: "Hydraulic leak",
  resolution: null,
  creditInvoiceId: null,
};

const openRental = { id: 42, status: "active", creditFinalizedAt: null, deletedAt: null };

/** Queue the two selects an update performs: the record, then the parent rental. */
function queue(record: Record<string, unknown>, rental: Record<string, unknown> | null = openRental) {
  selectQueue.value = [[record], rental ? [rental] : []];
}

beforeEach(() => {
  selectQueue.value = [];
  updateCalls.value = [];
  logAudit.mockClear();
});

describe("downtime.update — guard rails", () => {
  it("refuses once a credit note has been issued", async () => {
    queue({ ...baseRecord, status: "credited", creditInvoiceId: 900 });
    await expect(
      caller(ctx()).update({ id: 1, reason: "typo", editReason: "wrong_amount" }),
    ).rejects.toThrow(/already on an issued invoice/i);
    expect(updateCalls.value).toHaveLength(0);
  });

  it("refuses when the parent order is closed", async () => {
    queue(baseRecord, { ...openRental, status: "completed" });
    await expect(
      caller(ctx()).update({ id: 1, reason: "typo", editReason: "wrong_amount" }),
    ).rejects.toThrow(/order is already closed/i);
    expect(updateCalls.value).toHaveLength(0);
  });

  it("refuses when the credit order is already settled", async () => {
    queue(baseRecord, { ...openRental, creditFinalizedAt: new Date() });
    await expect(
      caller(ctx()).update({ id: 1, reason: "typo", editReason: "wrong_amount" }),
    ).rejects.toThrow(/already settled/i);
  });

  it("refuses an unknown record", async () => {
    selectQueue.value = [[]];
    await expect(
      caller(ctx()).update({ id: 999, reason: "x", editReason: "wrong_amount" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("downtime.update — evidence chain", () => {
  it('requires a note when the reason is "other"', async () => {
    queue(baseRecord);
    await expect(
      caller(ctx()).update({ id: 1, reason: "x", editReason: "other" }),
    ).rejects.toThrow(/note is required/i);
    expect(updateCalls.value).toHaveLength(0);
  });

  it("rejects a reason outside the shared list before any DB work", async () => {
    queue(baseRecord);
    await expect(
      // deliberately bypassing the input type to simulate a hand-rolled client
      caller(ctx()).update({ id: 1, editReason: "made_up" } as never),
    ).rejects.toThrow();
    expect(updateCalls.value).toHaveLength(0);
  });

  it("writes the audit entry with rentalRequestId, reason and old→new diff", async () => {
    queue(baseRecord);
    const res = await caller(ctx()).update({
      id: 1,
      reason: "Hydraulic hose burst",
      editReason: "wrong_document",
      reasonNote: "logged against the wrong fault",
    });

    expect(res).toEqual({ ok: true });
    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = logAudit.mock.calls[0][0];
    expect(entry.entityType).toBe("downtime_record");
    expect(entry.entityId).toBe(1);
    // Without this the order's change-history tab cannot find the entry.
    expect(entry.metadata.rentalRequestId).toBe(42);
    expect(entry.metadata.reason).toBe("wrong_document");
    expect(entry.metadata.reasonNote).toBe("logged against the wrong fault");
    expect(entry.changes.reason).toEqual({
      old: "Hydraulic leak",
      new: "Hydraulic hose burst",
    });
    // updatedAt is bookkeeping, not a business change.
    expect(entry.changes.updatedAt).toBeUndefined();
  });

  it("writes nothing when the submitted values are identical", async () => {
    queue(baseRecord);
    const res = await caller(ctx()).update({
      id: 1,
      reason: "Hydraulic leak",
      editReason: "wrong_amount",
    });
    expect(res).toEqual({ ok: true, unchanged: true });
    expect(updateCalls.value).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("downtime.update — window and derived values", () => {
  it("rejects a resolved time before the reported time", async () => {
    queue({ ...baseRecord, status: "resolved", resolvedAt: new Date("2026-03-06T14:00:00Z") });
    await expect(
      caller(ctx()).update({
        id: 1,
        resolvedAt: "2026-03-01T14:00:00Z",
        editReason: "wrong_amount",
      }),
    ).rejects.toThrow(/after the reported time/i);
  });

  it("recomputes days lost and credit when the window moves on a resolved record", async () => {
    // Mon 2026-03-02 → Fri 2026-03-06 = 5 calendar days, 0 excluded, 5 working.
    queue({
      ...baseRecord,
      status: "resolved",
      resolvedAt: new Date("2026-03-03T14:00:00Z"),
      totalCalendarDays: 2,
      excludedDays: 0,
      workingDaysLost: 2,
      creditAmount: "200.00",
    });

    await caller(ctx()).update({
      id: 1,
      resolvedAt: "2026-03-06T14:00:00Z",
      editReason: "wrong_amount",
    });

    const patch = updateCalls.value[0];
    expect(patch.totalCalendarDays).toBe(5);
    expect(patch.workingDaysLost).toBe(5);
    expect(patch.creditAmount).toBe("500.00");

    const changes = logAudit.mock.calls[0][0].changes;
    expect(changes.workingDaysLost).toEqual({ old: 2, new: 5 });
    expect(changes.creditAmount).toEqual({ old: "200.00", new: "500.00" });
  });

  it("leaves derived values alone when only the text fields change", async () => {
    queue({
      ...baseRecord,
      status: "resolved",
      resolvedAt: new Date("2026-03-03T14:00:00Z"),
      workingDaysLost: 2,
      creditAmount: "200.00",
    });

    await caller(ctx()).update({
      id: 1,
      resolution: "Hose replaced on site",
      editReason: "customer_agreed",
    });

    const patch = updateCalls.value[0];
    expect(patch.workingDaysLost).toBeUndefined();
    expect(patch.creditAmount).toBeUndefined();
    expect(patch.resolution).toBe("Hose replaced on site");
  });
});
