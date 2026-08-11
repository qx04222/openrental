/**
 * Work-order line corrections (parts + labour), with the evidence chain.
 *
 * Before this, a part could only ever be ADDED — there was no update and no
 * delete at all — and labour could be deleted with no reason recorded. The two
 * business rules that govern every correction in this system apply here too:
 *
 *   1. Already invoiced → refuse. A work order's only invoice link is the damage
 *      claim it was raised from (work_orders.damageClaimId → damage_claims.invoiceId);
 *      neither work_order_parts nor work_order_labor carries an invoiceId column.
 *   2. Order already closed → refuse. Same path: damage_claims.rentalId.
 *
 * Plus one rule specific to this module: a work order that is itself completed
 * or cancelled is closed to line edits, even when it hangs off no order at all
 * (internal PM / own-truck jobs, where rule 2 cannot apply).
 *
 * The db is mocked with an ordered queue of select() results — the procedures'
 * query order is documented per test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enCommon from "../client/src/i18n/locales/en/common.json";

const { mockDb, selectQueue, updateSpy, deleteSpy, mockLogAudit } = vi.hoisted(() => {
  const selectQueue: { value: unknown[][] } = { value: [] };

  const thenable = (rows: () => unknown[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "where", "orderBy", "limit", "returning"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(rows());
    return chain;
  };

  const updateSpy = vi.fn();
  const deleteSpy = vi.fn();

  const mockDb = {
    select: vi.fn(() => thenable(() => selectQueue.value.shift() ?? [])),
    update: vi.fn((table: unknown) => ({
      set: (values: unknown) => {
        updateSpy(table, values);
        return thenable(() => []);
      },
    })),
    delete: vi.fn((table: unknown) => {
      deleteSpy(table);
      return thenable(() => []);
    }),
  };

  return { mockDb, selectQueue, updateSpy, deleteSpy, mockLogAudit: vi.fn() };
});

vi.mock("../server/db", async () => {
  const dz = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    getDb: async () => mockDb,
    eq: dz.eq, and: dz.and, or: dz.or, isNull: dz.isNull, desc: dz.desc, sql: dz.sql,
  };
});

vi.mock("../server/services/auditLog", () => ({ logAudit: mockLogAudit }));

import { workOrdersRouter } from "../server/routers/workOrders.router";
import { t } from "../server/_core/trpc";
import type { TrpcContext } from "../server/_core/context";

const createCaller = t.createCallerFactory(workOrdersRouter);

function adminCaller() {
  return createCaller({
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 9, email: "admin@test.com", name: "Admin", username: "admin",
      role: "super_admin" as const, isActive: true, passwordHash: null, phone: null,
      createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
      lastSignedIn: null, loginMethod: null,
    },
  });
}

const PART = {
  id: 11, workOrderId: 5, partName: "Filter", partNumber: "F-1",
  quantity: "1.00", unitCost: "20.00", totalCost: "20.00", createdAt: new Date(),
};

const LABOR = {
  id: 21, workOrderId: 5, technicianName: "Li", userId: null, workDetail: "swap filter",
  startAt: new Date("2026-07-10T13:00:00Z"), endAt: new Date("2026-07-10T15:00:00Z"),
  createdAt: new Date(),
};

const openWo = (over: Record<string, unknown> = {}) => ({
  id: 5, status: "in_progress", damageClaimId: null, laborCost: "0", partsCost: "20.00",
  laborRate: "100.00", deletedAt: null, ...over,
});

/** i18nKey carried on a thrown i18nError. */
function i18nKeyOf(err: unknown) {
  return (err as TRPCError & { cause?: { i18nKey?: string } }).cause?.i18nKey;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.value = [];
});

describe("updatePart — the guard", () => {
  it("refuses a reason of 'other' with no note", async () => {
    // select order: part
    selectQueue.value = [[PART]];
    await expect(
      adminCaller().updatePart({ id: 11, unitCost: 30, reason: "other" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.edit.noteRequired");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rejects a reason outside the shared enum at the input boundary", async () => {
    await expect(
      // @ts-expect-error deliberately invalid reason
      adminCaller().updatePart({ id: 11, unitCost: 30, reason: "because_i_said_so" }),
    ).rejects.toThrow();
  });

  it("refuses when the work order itself is completed", async () => {
    // select order: part, work order
    selectQueue.value = [[PART], [openWo({ status: "completed" })]];
    await expect(
      adminCaller().updatePart({ id: 11, unitCost: 30, reason: "wrong_amount" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.workOrder.closed");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses when the work order is cancelled", async () => {
    selectQueue.value = [[PART], [openWo({ status: "cancelled" })]];
    await expect(
      adminCaller().updatePart({ id: 11, unitCost: 30, reason: "wrong_amount" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.workOrder.closed");
  });

  it("refuses when the damage claim it hangs off is already invoiced", async () => {
    // select order: part, work order, damage claim
    selectQueue.value = [
      [PART],
      [openWo({ damageClaimId: 77 })],
      [{ rentalId: 100, invoiceId: 900 }],
    ];
    await expect(
      adminCaller().updatePart({ id: 11, unitCost: 30, reason: "wrong_amount" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.edit.alreadyInvoiced");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses when the linked order is already closed", async () => {
    // select order: part, work order, damage claim, rental
    selectQueue.value = [
      [PART],
      [openWo({ damageClaimId: 77 })],
      [{ rentalId: 100, invoiceId: null }],
      [{ id: 100, status: "completed", creditFinalizedAt: null }],
    ];
    await expect(
      adminCaller().updatePart({ id: 11, unitCost: 30, reason: "wrong_amount" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.edit.orderClosed");
  });

  it("refuses when the credit order is already settled", async () => {
    selectQueue.value = [
      [PART],
      [openWo({ damageClaimId: 77 })],
      [{ rentalId: 100, invoiceId: null }],
      [{ id: 100, status: "active", creditFinalizedAt: new Date() }],
    ];
    await expect(
      adminCaller().updatePart({ id: 11, unitCost: 30, reason: "wrong_amount" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.edit.orderSettled");
  });

  it("reports a missing part line as not found", async () => {
    selectQueue.value = [[]];
    await expect(
      adminCaller().updatePart({ id: 11, unitCost: 30, reason: "wrong_amount" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.workOrder.partNotFound");
  });
});

describe("updatePart — the happy path", () => {
  // A standalone work order (no damage claim): rule 2 cannot apply, rule 1 alone governs.
  // select order: part, work order, [rollup sum, work order]
  const standalone = () => {
    selectQueue.value = [[PART], [openWo()], [{ partsCost: "60.00" }], [openWo()]];
  };

  it("re-derives totalCost from quantity × unitCost rather than trusting the client", async () => {
    standalone();
    await adminCaller().updatePart({ id: 11, quantity: 2, unitCost: 30, reason: "wrong_amount" });

    const partPatch = updateSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(partPatch.quantity).toBe("2.00");
    expect(partPatch.unitCost).toBe("30.00");
    expect(partPatch.totalCost).toBe("60.00");
  });

  it("rolls the new parts cost up onto the work order", async () => {
    standalone();
    await adminCaller().updatePart({ id: 11, quantity: 2, unitCost: 30, reason: "wrong_amount" });

    const woPatch = updateSpy.mock.calls[1][1] as Record<string, unknown>;
    expect(woPatch.partsCost).toBe("60.00");
    expect(woPatch.totalCost).toBe("60.00"); // laborCost 0 + parts 60
  });

  it("writes the evidence chain: what changed, why, and under which entity type", async () => {
    standalone();
    await adminCaller().updatePart({ id: 11, unitCost: 30, reason: "wrong_amount", reasonNote: "typo" });

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0];
    // The white-listed entity type — anything else is invisible on the change-history tab
    expect(entry.entityType).toBe("work_order_part");
    expect(entry.entityId).toBe(11);
    expect(entry.action).toBe("update");
    expect(entry.changes.unitCost).toEqual({ old: "20.00", new: "30.00" });
    expect(entry.changes.partName).toBeUndefined(); // unchanged fields are not logged
    expect(entry.metadata.reason).toBe("wrong_amount");
    expect(entry.metadata.reasonNote).toBe("typo");
    expect(entry.metadata.workOrderId).toBe(5);
  });

  it("carries rentalRequestId into metadata so the order's change-history tab sees it", async () => {
    selectQueue.value = [
      [PART],
      [openWo({ damageClaimId: 77 })],
      [{ rentalId: 100, invoiceId: null }],
      [{ id: 100, status: "active", creditFinalizedAt: null }],
      [{ partsCost: "30.00" }],
      [openWo({ damageClaimId: 77 })],
    ];
    await adminCaller().updatePart({ id: 11, unitCost: 30, reason: "wrong_amount" });
    expect(mockLogAudit.mock.calls[0][0].metadata.rentalRequestId).toBe(100);
  });

  it("writes nothing at all when the submitted values match what is already stored", async () => {
    selectQueue.value = [[PART], [openWo()]];
    const res = await adminCaller().updatePart({
      id: 11, partName: "Filter", quantity: 1, unitCost: 20, reason: "wrong_amount",
    });
    expect(res).toEqual({ ok: true, unchanged: true });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe("deletePart", () => {
  it("is guarded by the same rules as an edit", async () => {
    selectQueue.value = [[PART], [openWo({ status: "completed" })]];
    await expect(
      adminCaller().deletePart({ id: 11, reason: "duplicate" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.workOrder.closed");
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("physically deletes but records every column of the removed row", async () => {
    // The table has no deletedAt column, so the audit entry IS the evidence.
    selectQueue.value = [[PART], [openWo()], [{ partsCost: "0" }], [openWo()]];
    await adminCaller().deletePart({ id: 11, reason: "duplicate" });

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe("delete");
    expect(entry.entityType).toBe("work_order_part");
    expect(entry.changes.partName).toEqual({ old: "Filter", new: null });
    expect(entry.changes.unitCost).toEqual({ old: "20.00", new: null });
    expect(entry.changes.totalCost).toEqual({ old: "20.00", new: null });
    expect(entry.metadata.reason).toBe("duplicate");
  });

  it("re-derives the work order's parts cost after the row is gone", async () => {
    selectQueue.value = [[PART], [openWo()], [{ partsCost: "0" }], [openWo({ laborCost: "50.00" })]];
    await adminCaller().deletePart({ id: 11, reason: "duplicate" });
    const woPatch = updateSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(woPatch.partsCost).toBe("0.00");
    expect(woPatch.totalCost).toBe("50.00");
  });
});

describe("updateLabor", () => {
  it("refuses an end time at or before the start time", async () => {
    selectQueue.value = [[LABOR], [openWo()]];
    await expect(
      adminCaller().updateLabor({ id: 21, endAt: "2026-07-10T08:00", reason: "wrong_amount" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.workOrder.endAfterStart");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("is guarded by the work order's own status", async () => {
    selectQueue.value = [[LABOR], [openWo({ status: "completed" })]];
    await expect(
      adminCaller().updateLabor({ id: 21, technicianName: "Wang", reason: "wrong_document" }),
    ).rejects.toSatisfy((e: unknown) => i18nKeyOf(e) === "errors.workOrder.closed");
  });

  it("records the correction under work_order_labor", async () => {
    // select order: labour, work order, [rollup entries, work order]
    selectQueue.value = [[LABOR], [openWo()], [], [openWo()]];
    await adminCaller().updateLabor({ id: 21, technicianName: "Wang", reason: "wrong_document" });

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.entityType).toBe("work_order_labor");
    expect(entry.changes.technicianName).toEqual({ old: "Li", new: "Wang" });
    expect(entry.metadata.reason).toBe("wrong_document");
  });

  it("re-derives the work order's hours and labour cost from the log", async () => {
    // One 2h entry at $100/h after the edit
    selectQueue.value = [
      [LABOR], [openWo()],
      [{ startAt: new Date("2026-07-10T13:00:00Z"), endAt: new Date("2026-07-10T15:00:00Z") }],
      [openWo()],
    ];
    await adminCaller().updateLabor({ id: 21, technicianName: "Wang", reason: "wrong_document" });

    const woPatch = updateSpy.mock.calls[1][1] as Record<string, unknown>;
    expect(woPatch.actualHours).toBe("2.00");
    expect(woPatch.laborCost).toBe("200.00");
    expect(woPatch.totalCost).toBe("220.00"); // + partsCost 20.00
  });

  it("writes nothing when nothing actually changed", async () => {
    selectQueue.value = [[LABOR], [openWo()]];
    const res = await adminCaller().updateLabor({ id: 21, technicianName: "Li", reason: "wrong_amount" });
    expect(res).toEqual({ ok: true, unchanged: true });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});

describe("deleteLabor", () => {
  it("no longer deletes silently — a reason is now mandatory", async () => {
    await expect(
      // @ts-expect-error the old signature took only an id
      adminCaller().deleteLabor({ id: 21 }),
    ).rejects.toThrow();
  });

  it("records the whole removed entry as evidence", async () => {
    selectQueue.value = [[LABOR], [openWo()], [], [openWo()]];
    await adminCaller().deleteLabor({ id: 21, reason: "duplicate" });

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe("delete");
    expect(entry.entityType).toBe("work_order_labor");
    expect(entry.changes.technicianName).toEqual({ old: "Li", new: null });
    expect(entry.changes.workDetail).toEqual({ old: "swap filter", new: null });
  });
});

describe("i18n", () => {
  it("every new error key exists in both locales", () => {
    for (const key of [
      "errors.workOrder.closed",
      "errors.workOrder.notFound",
      "errors.workOrder.partNotFound",
      "errors.workOrder.laborNotFound",
    ]) {
      expect(zhCommon, `zh missing ${key}`).toHaveProperty(key);
      expect(enCommon, `en missing ${key}`).toHaveProperty(key);
    }
  });
});
