import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../server/_core/context";

const {
  getDbMock,
  getPoliciesMock,
  loadProgressMock,
  loadFieldProgressMock,
  listEventsMock,
  recordEventMock,
  logAuditMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getPoliciesMock: vi.fn(),
  loadProgressMock: vi.fn(),
  loadFieldProgressMock: vi.fn(),
  listEventsMock: vi.fn(),
  recordEventMock: vi.fn(),
  logAuditMock: vi.fn(),
}));

vi.mock("../../server/db", () => ({ getDb: getDbMock }));
vi.mock("../../server/services/rentalOperationPolicies", () => ({
  getRentalOperationPolicies: getPoliciesMock,
}));
vi.mock("../../server/services/rentalAssetProgress", () => ({
  loadRentalAssetProgress: loadProgressMock,
  loadFieldRentalAssetProgress: loadFieldProgressMock,
  listAssetProgressEvents: listEventsMock,
  recordAssetProgressEvent: recordEventMock,
}));
vi.mock("../../server/services/auditLog", () => ({ logAudit: logAuditMock }));

import { rentalAssetProgressRouter } from "../../server/routers/rentalAssetProgress.router";
import { t } from "../../server/_core/trpc";

const createCaller = t.createCallerFactory(rentalAssetProgressRouter);

function makeCtx(role: "admin" | "super_admin" | "field_staff"): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: role === "field_staff" ? 9 : 7,
      email: "ops@example.com",
      name: "Operator",
      username: "ops",
      role,
      isActive: true,
      passwordHash: null,
      phone: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      lastSignedIn: null,
      loginMethod: null,
    },
  };
}

const progress = (overrides: Record<string, unknown> = {}) => ({
  rentalRequestId: 10,
  rentalFleetId: 101,
  stage: "return_pending",
  entryInspection: "not_required",
  deliveryTransport: "disabled",
  returnInspection: "pending",
  pickupTransport: "disabled",
  rentalStatus: "active",
  lastUpdatedAt: new Date("2026-07-15T12:00:00.000Z"),
  occupancyConflict: false,
  conflictingRentals: [],
  ...overrides,
});

describe("rental asset progress router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockResolvedValue({});
    getPoliciesMock.mockResolvedValue({
      dispatchWorkflow: false,
      dispatchInspectionRequired: false,
      returnInspectionRequired: true,
    });
    loadProgressMock.mockResolvedValue([progress()]);
    loadFieldProgressMock.mockResolvedValue([progress()]);
    listEventsMock.mockResolvedValue([]);
    recordEventMock.mockResolvedValue(undefined);
    logAuditMock.mockResolvedValue(undefined);
  });

  it("returns the canonical resolver shape to admin", async () => {
    const caller = createCaller(makeCtx("admin"));

    await expect(caller.byRental({ rentalId: 10 })).resolves.toEqual([progress()]);
    expect(loadProgressMock).toHaveBeenCalledWith({}, 10, expect.any(Object));
  });

  it("returns the same shape to field staff", async () => {
    const caller = createCaller(makeCtx("field_staff"));

    await expect(caller.fieldList()).resolves.toEqual([progress()]);
    expect(loadFieldProgressMock).toHaveBeenCalledWith({}, 9, expect.any(Object));
  });

  it("records return start idempotently for a member unit", async () => {
    const caller = createCaller(makeCtx("field_staff"));

    await caller.startReturn({ rentalId: 10, rentalFleetId: 101 });

    expect(recordEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
      eventKey: "return_started:10:101",
      eventType: "return_started",
      source: "pwa",
      actorUserId: 9,
    }));
  });

  it("blocks return start when the fleet unit belongs to multiple open rentals", async () => {
    loadFieldProgressMock.mockResolvedValue([progress({
      occupancyConflict: true,
      conflictingRentals: [
        { rentalId: 10, rentalNumber: "20260528TB" },
        { rentalId: 11, rentalNumber: "20260702TI" },
      ],
    })]);
    const caller = createCaller(makeCtx("field_staff"));

    await expect(caller.startReturn({ rentalId: 10, rentalFleetId: 101 }))
      .rejects.toThrow("occupancy conflict");
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("rejects field timeline access for equipment outside the operator's visible list", async () => {
    loadFieldProgressMock.mockResolvedValue([]);
    const caller = createCaller(makeCtx("field_staff"));

    await expect(caller.timeline({ rentalId: 10, rentalFleetId: 101 }))
      .rejects.toThrow("not available");
    expect(listEventsMock).not.toHaveBeenCalled();
  });

  it("rejects return start before the rental is active", async () => {
    loadFieldProgressMock.mockResolvedValue([progress({
      stage: "entry_ready",
      rentalStatus: "approved",
    })]);
    const caller = createCaller(makeCtx("field_staff"));

    await expect(caller.startReturn({ rentalId: 10, rentalFleetId: 101 }))
      .rejects.toThrow("not ready to start return");
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("rejects return start for equipment outside the rental", async () => {
    const caller = createCaller(makeCtx("admin"));

    await expect(caller.startReturn({ rentalId: 10, rentalFleetId: 999 }))
      .rejects.toThrow("not available");
    expect(recordEventMock).not.toHaveBeenCalled();
  });

  it("allows only super admin to bypass an inspection", async () => {
    const caller = createCaller(makeCtx("admin"));

    await expect(caller.bypassInspection({
      rentalId: 10,
      rentalFleetId: 101,
      inspectionType: "return",
      reason: "Verified at the remote yard",
    })).rejects.toThrow("Super admin");
  });

  it("records and audits a per-unit bypass without creating an inspection", async () => {
    const caller = createCaller(makeCtx("super_admin"));

    await caller.bypassInspection({
      rentalId: 10,
      rentalFleetId: 101,
      inspectionType: "return",
      reason: "Verified at the remote yard",
    });

    expect(recordEventMock).toHaveBeenCalledWith({}, expect.objectContaining({
      eventKey: "return_inspection_bypassed:10:101",
      eventType: "return_inspection_bypassed",
      reason: "Verified at the remote yard",
      actorUserId: 7,
    }));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      action: "inspection_bypass",
      entityType: "rental_asset_progress",
      entityId: 10,
      metadata: expect.objectContaining({ rentalFleetId: 101, inspectionType: "return" }),
    }));
  });

  it("rejects bypass when real inspection evidence already exists", async () => {
    loadProgressMock.mockResolvedValue([progress({ returnInspection: "completed" })]);
    const caller = createCaller(makeCtx("super_admin"));

    await expect(caller.bypassInspection({
      rentalId: 10,
      rentalFleetId: 101,
      inspectionType: "return",
      reason: "Verified at the remote yard",
    })).rejects.toThrow("already completed");
  });

  it("rejects a return-inspection bypass before return processing starts", async () => {
    loadProgressMock.mockResolvedValue([progress({
      stage: "in_rental",
      returnInspection: "pending",
    })]);
    const caller = createCaller(makeCtx("super_admin"));

    await expect(caller.bypassInspection({
      rentalId: 10,
      rentalFleetId: 101,
      inspectionType: "return",
      reason: "Verified at the remote yard",
    })).rejects.toThrow("not available at this stage");
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});
