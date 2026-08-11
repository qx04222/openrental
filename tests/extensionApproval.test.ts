import { describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import { approveExtensionRequest } from "../server/services/extensionApproval";

const extension = {
  id: 9,
  rentalRequestId: 42,
  customerId: 7,
  requestedEndDate: new Date("2026-08-15T00:00:00.000Z"),
  status: "pending",
};
const rental = {
  id: 42,
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  endDate: new Date("2026-07-31T00:00:00.000Z"),
  rentalFee: "1200.00",
  insuranceCost: "120.00",
  taxAmount: "171.60",
  totalAmount: "1491.60",
};

function makeDb(extensionResult: unknown[] = [{ ...extension, status: "approved" }]) {
  const selectQueue = [[extension], [rental]];
  const writes: Array<{ table: unknown; data: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; data: unknown }> = [];
  const tx = {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(async () => selectQueue.shift() ?? []),
        }),
      }),
    })),
    update: vi.fn().mockImplementation((table: unknown) => ({
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        writes.push({ table, data });
        return {
          where: vi.fn().mockReturnValue(
            table === schema.extensionRequests
              ? { returning: vi.fn().mockResolvedValue(extensionResult) }
              : Promise.resolve(undefined),
          ),
        };
      }),
    })),
    insert: vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((data: unknown) => {
        inserts.push({ table, data });
        return { onConflictDoNothing: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  };
  const db = { transaction: vi.fn((fn: (value: typeof tx) => unknown) => fn(tx)) };
  return { db, writes, inserts };
}

function dependencies() {
  return {
    recalculatePricing: vi.fn().mockResolvedValue({
      new: {
        rentalFee: 1800,
        insuranceCost: 180,
        taxAmount: 257.4,
        taxBreakdown: "HST 13%",
        depositAmount: 600,
        totalAmount: 2237.4,
      },
    }),
    getFleetIds: vi.fn().mockResolvedValue([5]),
    checkAvailability: vi.fn().mockResolvedValue({ isAvailable: true, conflictingRentals: [] }),
    extendLineItems: vi.fn().mockResolvedValue({ updated: 1 }),
    syncDispatch: vi.fn().mockResolvedValue({ updated: 1 }),
  };
}

describe("approveExtensionRequest", () => {
  it("reprices, extends linked records, and approves in one transaction", async () => {
    const { db, writes, inserts } = makeDb();
    const deps = dependencies();

    const result = await approveExtensionRequest(db as never, {
      id: 9,
      adminNotes: "Customer confirmed",
      reviewedBy: 3,
    }, deps as never);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(deps.recalculatePricing).toHaveBeenCalledWith(
      42,
      rental.startDate,
      extension.requestedEndDate,
      expect.anything(),
    );
    expect(deps.extendLineItems).toHaveBeenCalledWith(expect.anything(), 42, rental.endDate, extension.requestedEndDate);
    expect(deps.syncDispatch).toHaveBeenCalledWith(expect.anything(), 42, { endDate: extension.requestedEndDate });
    expect(writes).toContainEqual(expect.objectContaining({
      table: schema.rentalRequests,
      data: expect.objectContaining({ endDate: extension.requestedEndDate, rentalFee: "1800.00", depositAmount: "600.00" }),
    }));
    expect(writes).toContainEqual(expect.objectContaining({
      table: schema.extensionRequests,
      data: expect.objectContaining({ status: "approved", adminNotes: "Customer confirmed", reviewedBy: 3 }),
    }));
    expect(inserts).toContainEqual(expect.objectContaining({
      table: schema.rentalLifecycleEffects,
      data: expect.arrayContaining([
        expect.objectContaining({ effectType: "renewal_supplement", rentalRequestId: 42 }),
        expect.objectContaining({ effectType: "notification", rentalRequestId: 42 }),
      ]),
    }));
    expect(result.commandKey).toBe("extension:9:approval");
    expect(result.updated.status).toBe("approved");
  });

  it("aborts without any write when repricing fails", async () => {
    const { db, writes } = makeDb();
    const deps = dependencies();
    deps.recalculatePricing.mockRejectedValue(new Error("pricing unavailable"));

    await expect(approveExtensionRequest(db as never, {
      id: 9,
      reviewedBy: 3,
    }, deps as never)).rejects.toThrow("pricing unavailable");
    expect(writes).toEqual([]);
  });

  it("rejects an extension that overlaps another booking", async () => {
    const { db, writes } = makeDb();
    const deps = dependencies();
    deps.checkAvailability.mockResolvedValue({
      isAvailable: false,
      conflictingRentals: [{ id: 77 }],
    } as never);

    await expect(approveExtensionRequest(db as never, {
      id: 9,
      reviewedBy: 3,
    }, deps as never)).rejects.toThrow("conflicts with another rental");
    expect(writes).toEqual([]);
  });

  it("treats a lost pending-status compare-and-set as a conflict", async () => {
    const { db } = makeDb([]);

    await expect(approveExtensionRequest(db as never, {
      id: 9,
      reviewedBy: 3,
    }, dependencies() as never)).rejects.toThrow("already reviewed");
  });
});
