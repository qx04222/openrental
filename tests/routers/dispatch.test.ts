import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetDb,
  mockDb,
  queryResults,
  queryQueue,
  insertResults,
  mockLogAudit,
  mockAssignFleet,
  mockReleaseFleet,
  mockTransitionRental,
  mockLoggerError,
  mockRecordProgress,
  mockAssertConflict,
} = vi.hoisted(() => {
  const queryResults: { value: unknown[] } = { value: [] };
  const queryQueue: { value: unknown[][] } = { value: [] };
  const insertResults: { value: unknown[] } = { value: [] };

  const nextQueryResult = () => {
    if (queryQueue.value.length > 0) {
      return queryQueue.value.shift()!;
    }
    return [...queryResults.value];
  };

  const createReadChain = () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> & { then?: (resolve: (value: unknown[]) => void) => void } = {};
    for (const method of ["from", "leftJoin", "where", "orderBy", "limit"]) {
      chain[method] = vi.fn().mockReturnValue(chain);
    }
    chain.then = (resolve: (value: unknown[]) => void) => resolve(nextQueryResult());
    return chain;
  };

  const mockDb = {
    select: vi.fn().mockImplementation(() => createReadChain()),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => Promise.resolve([...insertResults.value])),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => Promise.resolve([...insertResults.value])),
          then: (resolve: (value: undefined) => void) => resolve(undefined),
        }),
      }),
    }),
  };

  return {
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    mockDb,
    queryResults,
    queryQueue,
    insertResults,
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
    mockAssignFleet: vi.fn().mockResolvedValue({ success: true }),
    mockReleaseFleet: vi.fn().mockResolvedValue(undefined),
    mockTransitionRental: vi.fn().mockResolvedValue({ ok: true, failures: [] }),
    mockLoggerError: vi.fn(),
    mockRecordProgress: vi.fn().mockResolvedValue(undefined),
    mockAssertConflict: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((..._args: unknown[]) => "eq"),
  desc: vi.fn((..._args: unknown[]) => "desc"),
  and: vi.fn((..._args: unknown[]) => "and"),
  isNull: vi.fn((..._args: unknown[]) => "isNull"),
}));

vi.mock("../../drizzle/schema", () => {
  const col = (name: string) => name;
  return {
    dispatchOrders: {
      id: col("id"),
      status: col("status"),
      deletedAt: col("deletedAt"),
      createdAt: col("createdAt"),
      updatedAt: col("updatedAt"),
      completedDate: col("completedDate"),
      orderType: col("orderType"),
      rentalRequestId: col("rentalRequestId"),
      rentalFleetId: col("rentalFleetId"),
      customerId: col("customerId"),
      assignedDriverId: col("assignedDriverId"),
      scheduledDate: col("scheduledDate"),
      pickupAddress: col("pickupAddress"),
      deliveryAddress: col("deliveryAddress"),
      pickupWarehouseId: col("pickupWarehouseId"),
      deliveryWarehouseId: col("deliveryWarehouseId"),
      shippingCost: col("shippingCost"),
      notes: col("notes"),
      driverNotes: col("driverNotes"),
      distance: col("distance"),
      priority: col("priority"),
    },
    customers: {
      id: col("id"),
      name: col("name"),
      phone: col("phone"),
    },
    rentalFleet: {
      id: col("id"),
      brand: col("brand"),
      model: col("model"),
      locationId: col("locationId"),
    },
    users: {
      id: col("id"),
      name: col("name"),
      username: col("username"),
    },
    drivers: {
      id: col("id"),
      name: col("name"),
      phone: col("phone"),
      email: col("email"),
      userId: col("userId"),
      isActive: col("isActive"),
      deletedAt: col("deletedAt"),
    },
    rentalRequests: {
      id: col("id"),
      status: col("status"),
      deletedAt: col("deletedAt"),
      rentalFleetId: col("rentalFleetId"),
      customerId: col("customerId"),
      startDate: col("startDate"),
      endDate: col("endDate"),
      deliveryMethod: col("deliveryMethod"),
      deliveryAddress: col("deliveryAddress"),
      returnInspectionCompleted: col("returnInspectionCompleted"),
    },
    warehouses: {
      id: col("id"),
      address: col("address"),
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

vi.mock("../../server/services/auditLog", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("../../server/services/rentalAssetProgress", () => ({
  recordAssetProgressEvent: (...args: unknown[]) => mockRecordProgress(...args),
}));

vi.mock("../../server/services/rentalFleetConflict", () => ({
  assertFleetRentalPairUnambiguous: (...args: unknown[]) => mockAssertConflict(...args),
}));

vi.mock("../../server/services/rentalLineItemSync", () => ({
  assignAllFleetForRental: (...args: unknown[]) => mockAssignFleet(...args),
  releaseAllFleetForRental: (...args: unknown[]) => mockReleaseFleet(...args),
  // Manual dispatch resolves the fleet unit (and its warehouse) through this.
  getRentalFulfillmentUnits: vi.fn().mockResolvedValue([
    { lineItemId: null, rentalFleetId: 5, equipmentModelId: null, itemType: "machine", quantity: 1, brand: "", model: "", category: "", assetNumber: null, locationId: 1, startDate: null, endDate: null },
  ]),
}));

vi.mock("../../server/routers/rentalRequests.router", () => ({
  transitionRentalStatus: (...args: unknown[]) => mockTransitionRental(...args),
}));

vi.mock("../../server/_core/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { dispatchRouter } from "../../server/routers/dispatch.router";
import { t } from "../../server/_core/trpc";
import type { TrpcContext } from "../../server/_core/context";

const createCaller = t.createCallerFactory(dispatchRouter);

function makeCtx(role?: "super_admin" | "admin" | "field_staff"): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: role
      ? {
          id: role === "field_staff" ? 42 : 1,
          email: "user@test.com",
          name: "Test User",
          username: "test-user",
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

describe("dispatch router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.value = [];
    queryQueue.value = [];
    insertResults.value = [];
  });

  describe("permissions", () => {
    it("list rejects unauthenticated users", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.list()).rejects.toThrow("Please login");
    });

    it("myDeliveries rejects unauthenticated users", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.myDeliveries()).rejects.toThrow("Please login");
    });
  });

  describe("list", () => {
    it("returns empty when DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.list()).toEqual([]);
    });

    it("returns dispatch orders with optional status filter", async () => {
      queryResults.value = [{ dispatch_orders: { id: 1, status: "assigned" } }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.list({ status: "assigned", limit: 10 })).resolves.toEqual(queryResults.value);
    });

    it("returns all non-deleted dispatch orders when no status filter is provided", async () => {
      queryResults.value = [{ dispatch_orders: { id: 3, status: "pending" } }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.list()).resolves.toEqual(queryResults.value);
    });
  });

  describe("getByRentalId", () => {
    it("returns empty when DB is null", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      expect(await caller.getByRentalId({ rentalId: 7 })).toEqual([]);
    });

    it("returns dispatch history for a rental", async () => {
      queryResults.value = [{ dispatch_orders: { id: 2, rentalRequestId: 7 } }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.getByRentalId({ rentalId: 7 })).resolves.toEqual(queryResults.value);
    });
  });

  describe("create", () => {
    it("throws when DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.create({ orderType: "delivery" })).rejects.toThrow("Database not available");
    });

    it("autofills addresses from the linked rental for delivery orders", async () => {
      // New flow: flat rental select, then warehouse select for the chosen unit.
      queryQueue.value = [
        [{ customerId: 9, deliveryAddress: "123 Customer Rd", deliveryDistanceKm: null }],
        [{ address: "1 Warehouse Way" }],
      ];
      insertResults.value = [{ id: 99, orderType: "delivery", rentalFleetId: 5 }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.create({ orderType: "delivery", rentalRequestId: 11 });
      expect(result).toEqual(insertResults.value[0]);
    });

    it("autofills return pickup addresses for pickup orders", async () => {
      queryQueue.value = [
        [{ customerId: 9, deliveryAddress: "123 Customer Rd", deliveryDistanceKm: null }],
        [{ address: "1 Warehouse Way" }],
      ];
      insertResults.value = [{ id: 100, orderType: "pickup", pickupAddress: "123 Customer Rd" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.create({ orderType: "pickup", rentalRequestId: 12 });
      expect(result).toEqual(insertResults.value[0]);
    });

    it("auto-fills distance from the linked rental's deliveryDistanceKm (no manual entry)", async () => {
      queryQueue.value = [
        [{ customerId: 9, deliveryAddress: "123 Customer Rd", deliveryDistanceKm: "20.20" }],
        [{ address: "1 Warehouse Way" }],
      ];
      insertResults.value = [{ id: 102, orderType: "delivery" }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.create({ orderType: "delivery", rentalRequestId: 13 });
      const valuesFn = mockDb.insert.mock.results.at(-1)!.value.values;
      expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ distance: "20.20" }));
    });

    it("creates standalone dispatch orders without linked rental autofill", async () => {
      insertResults.value = [{ id: 101, orderType: "delivery", deliveryAddress: "Manual address" }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.create({ orderType: "delivery", deliveryAddress: "Manual address" });
      expect(result).toEqual(insertResults.value[0]);
    });
  });

  describe("updateStatus", () => {
    it("throws when DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "assigned" })).rejects.toThrow("Database not available");
    });

    it("throws when the dispatch order does not exist", async () => {
      queryQueue.value = [[]];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "assigned" })).rejects.toThrow("Dispatch order not found");
    });

    it("rejects invalid state transitions", async () => {
      queryQueue.value = [[{ status: "pending" }]];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "completed" })).rejects.toThrow("Cannot transition");
    });

    it("activates the rental when a delivery is completed", async () => {
      queryQueue.value = [
        [{ status: "in_transit" }],
        [{ id: 15, status: "approved", rentalFleetId: 5, returnInspectionCompleted: false }],
      ];
      insertResults.value = [{ id: 1, status: "delivered", orderType: "delivery", rentalRequestId: 15 }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.updateStatus({ id: 1, status: "delivered" });
      expect(result).toEqual(insertResults.value[0]);
      expect(mockTransitionRental).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        rentalId: 15,
        targetStatus: "active",
      }));
    });

    it("updates non-terminal statuses without triggering rental synchronization", async () => {
      queryQueue.value = [[{ status: "pending" }]];
      insertResults.value = [{ id: 1, status: "assigned", orderType: "delivery", rentalRequestId: 15 }];
      const caller = createCaller(makeCtx("super_admin"));
      const result = await caller.updateStatus({ id: 1, status: "assigned", driverNotes: "Assigned to route" });
      expect(result).toEqual(insertResults.value[0]);
      expect(mockAssignFleet).not.toHaveBeenCalled();
      expect(mockReleaseFleet).not.toHaveBeenCalled();
      expect(mockTransitionRental).not.toHaveBeenCalled();
    });

    it("records equipment progress for a linked dispatch status change", async () => {
      queryQueue.value = [[{ status: "pending" }]];
      insertResults.value = [{
        id: 1,
        status: "assigned",
        orderType: "delivery",
        rentalRequestId: 15,
        rentalFleetId: 5,
      }];
      const caller = createCaller(makeCtx("super_admin"));

      await caller.updateStatus({ id: 1, status: "assigned" });

      expect(mockRecordProgress).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        eventKey: "dispatch:1:assigned",
        rentalRequestId: 15,
        rentalFleetId: 5,
        eventType: "delivery_dispatch_assigned",
        source: "dispatch",
      }));
    });

    it("completes the rental when a pickup finishes after return inspection", async () => {
      queryQueue.value = [
        [{ status: "delivered" }],
        [{ id: 15, status: "active", rentalFleetId: 5, returnInspectionCompleted: true }],
      ];
      insertResults.value = [{ id: 1, status: "completed", orderType: "pickup", rentalRequestId: 15 }];
      const caller = createCaller(makeCtx("super_admin"));
      await caller.updateStatus({ id: 1, status: "completed" });
      expect(mockTransitionRental).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        rentalId: 15,
        targetStatus: "completed",
      }));
    });

    it("logs and swallows rental side-effect failures", async () => {
      queryQueue.value = [
        [{ status: "in_transit" }],
        [{ id: 15, status: "approved", rentalFleetId: 5, returnInspectionCompleted: false }],
      ];
      insertResults.value = [{ id: 1, status: "delivered", orderType: "delivery", rentalRequestId: 15 }];
      mockTransitionRental.mockRejectedValueOnce(new Error("sync failed"));
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.updateStatus({ id: 1, status: "delivered" })).resolves.toEqual(insertResults.value[0]);
      expect(mockLoggerError).toHaveBeenCalledWith(
        "[Dispatch] Auto status update failed",
        expect.objectContaining({ error: "sync failed" }),
      );
    });
  });

  describe("assignDriver", () => {
    it("throws when DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.assignDriver({ id: 5, driverId: 42 })).rejects.toThrow("Database not available");
    });

    it("marks the order as assigned", async () => {
      queryQueue.value = [[{ status: "pending" }]]; // current-status guard SELECT
      insertResults.value = [{ id: 5, assignedDriverId: 42, status: "assigned" }];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.assignDriver({ id: 5, driverId: 42 })).resolves.toEqual(insertResults.value[0]);
    });

    it("rejects assigning a driver to a terminal-state order", async () => {
      queryQueue.value = [[{ status: "completed" }]];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.assignDriver({ id: 5, driverId: 42 })).rejects.toThrow(/Cannot assign a driver/);
    });
  });

  describe("delete", () => {
    it("throws when the order does not exist", async () => {
      queryQueue.value = [[]];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 1 })).rejects.toThrow("Dispatch order not found");
    });

    it("rejects deleting active orders", async () => {
      queryQueue.value = [[{ id: 1, status: "assigned", orderType: "delivery" }]];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 1 })).rejects.toThrow("Cannot delete active dispatch order");
    });

    it("soft deletes completed orders and logs audit", async () => {
      queryQueue.value = [[{ id: 1, status: "completed", orderType: "delivery" }]];
      const caller = createCaller(makeCtx("super_admin"));
      await expect(caller.delete({ id: 1 })).resolves.toEqual({ success: true });
      expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "delete",
        entityType: "dispatch",
        entityId: 1,
      }));
    });
  });

  describe("myDeliveries", () => {
    it("returns empty when DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("field_staff"));
      expect(await caller.myDeliveries()).toEqual([]);
    });

    it("returns deliveries for the authenticated driver", async () => {
      queryResults.value = [{ dispatch_orders: { id: 7, assignedDriverId: 42, status: "assigned" } }];
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.myDeliveries({ status: "assigned" })).resolves.toEqual(queryResults.value);
    });
  });

  describe("updateMyStatus", () => {
    it("throws when DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.updateMyStatus({ id: 1, status: "in_transit" })).rejects.toThrow("Database not available");
    });

    it("throws when the order is not assigned to the current driver", async () => {
      // 1st query resolves the linked driver record, 2nd (the dispatch lookup) returns empty
      queryQueue.value = [[{ id: 42 }], []];
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.updateMyStatus({ id: 1, status: "in_transit" })).rejects.toThrow("not assigned to you");
    });

    it("rejects invalid field-staff transitions", async () => {
      queryQueue.value = [[{ id: 42 }], [{ id: 1, status: "assigned" }]];
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.updateMyStatus({ id: 1, status: "completed" })).rejects.toThrow("Cannot transition");
    });

    it("blocks a field dispatch update for an ambiguously occupied fleet unit", async () => {
      queryQueue.value = [[{ id: 42 }], [{ id: 1, status: "assigned", rentalRequestId: 15, rentalFleetId: 5 }]];
      mockAssertConflict.mockRejectedValueOnce(new Error("Fleet occupancy conflict"));
      const caller = createCaller(makeCtx("field_staff"));

      await expect(caller.updateMyStatus({ id: 1, status: "in_transit" }))
        .rejects.toThrow("occupancy conflict");
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("updates the order and activates the rental on delivery", async () => {
      queryQueue.value = [
        [{ id: 42 }],
        [{ id: 1, status: "in_transit" }],
        [{ id: 15, status: "approved", rentalFleetId: 5, returnInspectionCompleted: false }],
      ];
      insertResults.value = [{ id: 1, status: "delivered", orderType: "delivery", rentalRequestId: 15 }];
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.updateMyStatus({ id: 1, status: "delivered", driverNotes: "Done" })).resolves.toEqual(insertResults.value[0]);
      expect(mockTransitionRental).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        rentalId: 15,
        targetStatus: "active",
      }));
    });

    it("updates in-transit progress without rental side effects", async () => {
      queryQueue.value = [[{ id: 42 }], [{ id: 1, status: "assigned" }]];
      insertResults.value = [{ id: 1, status: "in_transit", orderType: "delivery", rentalRequestId: 15 }];
      const caller = createCaller(makeCtx("field_staff"));
      const result = await caller.updateMyStatus({ id: 1, status: "in_transit" });
      expect(result).toEqual(insertResults.value[0]);
      expect(mockAssignFleet).not.toHaveBeenCalled();
      expect(mockReleaseFleet).not.toHaveBeenCalled();
      expect(mockTransitionRental).not.toHaveBeenCalled();
    });

    // Post multi-line refactor (20b811a) fleet linkage lives in rental_line_items,
    // not on rental_requests.rentalFleetId. updateMyStatus now always delegates to
    // assignAllFleetForRental, which resolves the per-line fleet IDs and no-ops when
    // none are linked. So delivery-of-approved always invokes the multi-line sync.
    it("delegates fleet assignment to the multi-line sync on delivery completion", async () => {
      queryQueue.value = [
        [{ id: 42 }],
        [{ id: 1, status: "in_transit" }],
        [{ id: 15, status: "approved", rentalFleetId: null, returnInspectionCompleted: false }],
      ];
      insertResults.value = [{ id: 1, status: "delivered", orderType: "delivery", rentalRequestId: 15 }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.updateMyStatus({ id: 1, status: "delivered" });
      expect(mockTransitionRental).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        rentalId: 15,
        targetStatus: "active",
      }));
    });

    it("delegates pickup readiness to the lifecycle service", async () => {
      queryQueue.value = [
        [{ id: 42 }],
        [{ id: 1, status: "delivered" }],
        [{ id: 15, status: "active", rentalFleetId: 5, returnInspectionCompleted: false }],
      ];
      insertResults.value = [{ id: 1, status: "completed", orderType: "pickup", rentalRequestId: 15 }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.updateMyStatus({ id: 1, status: "completed" });
      expect(mockTransitionRental).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        rentalId: 15,
        targetStatus: "completed",
        earlyReturn: true,
      }));
    });

    it("completes the rental and releases the fleet on pickup completion", async () => {
      queryQueue.value = [
        [{ id: 42 }],
        [{ id: 1, status: "delivered" }],
        [{ id: 15, status: "active", rentalFleetId: 5, returnInspectionCompleted: true }],
      ];
      insertResults.value = [{ id: 1, status: "completed", orderType: "pickup", rentalRequestId: 15 }];
      const caller = createCaller(makeCtx("field_staff"));
      await caller.updateMyStatus({ id: 1, status: "completed" });
      expect(mockTransitionRental).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        rentalId: 15,
        targetStatus: "completed",
      }));
    });

    it("logs and swallows rental sync failures for field staff updates", async () => {
      queryQueue.value = [
        [{ id: 42 }],
        [{ id: 1, status: "in_transit" }],
        [{ id: 15, status: "approved", rentalFleetId: 5, returnInspectionCompleted: false }],
      ];
      insertResults.value = [{ id: 1, status: "delivered", orderType: "delivery", rentalRequestId: 15 }];
      mockTransitionRental.mockRejectedValueOnce(new Error("field sync failed"));
      const caller = createCaller(makeCtx("field_staff"));
      await expect(caller.updateMyStatus({ id: 1, status: "delivered" })).resolves.toEqual(insertResults.value[0]);
      expect(mockLoggerError).toHaveBeenCalledWith(
        "[Dispatch] Auto status update failed",
        expect.objectContaining({ error: "field sync failed" }),
      );
    });
  });
});
