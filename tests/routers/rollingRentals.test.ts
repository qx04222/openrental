import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../server/_core/context";

const {
  getDbMock,
  featureEnabledMock,
  summaryMock,
  startMock,
  readyMock,
  responsibilityMock,
  pickupMock,
  previewMock,
  confirmMock,
  assertConflictMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  featureEnabledMock: vi.fn(),
  summaryMock: vi.fn(),
  startMock: vi.fn(),
  readyMock: vi.fn(),
  responsibilityMock: vi.fn(),
  pickupMock: vi.fn(),
  previewMock: vi.fn(),
  confirmMock: vi.fn(),
  assertConflictMock: vi.fn(),
}));

vi.mock("../../server/db", () => ({ getDb: getDbMock }));
vi.mock("../../server/services/featureFlags", () => ({
  isFeatureEnabled: featureEnabledMock,
}));
vi.mock("../../server/services/rollingRentalOperations", () => ({
  getRollingRentalSummary: summaryMock,
  startRollingRenewal: startMock,
  markCustomerReady: readyMock,
  changeDelayResponsibility: responsibilityMock,
  recordPhysicalPickup: pickupMock,
  previewHistoricalClassification: previewMock,
}));
vi.mock("../../server/services/rollingSettlement", () => ({
  confirmHistoricalClassification: confirmMock,
}));
vi.mock("../../server/services/rentalFleetConflict", () => ({
  assertFleetRentalPairUnambiguous: assertConflictMock,
}));

import { rollingRentalsRouter } from "../../server/routers/rollingRentals.router";
import { t } from "../../server/_core/trpc";

const createCaller = t.createCallerFactory(rollingRentalsRouter);

function makeCtx(role: "super_admin" | "admin" | "field_staff" | "user"): TrpcContext {
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

describe("rolling rentals router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockResolvedValue({});
    featureEnabledMock.mockResolvedValue(true);
    summaryMock.mockResolvedValue({ term: null, operations: [] });
    startMock.mockResolvedValue({ created: true, term: { id: 1 } });
    readyMock.mockResolvedValue({ operations: 2 });
    responsibilityMock.mockResolvedValue({ operations: 2 });
    pickupMock.mockResolvedValue({ pickedUpAt: new Date("2026-08-03T15:00:00.000Z") });
    previewMock.mockResolvedValue({ previewHash: "abc", amount: 125 });
    confirmMock.mockResolvedValue({ termId: 1, invoiceId: 2 });
    assertConflictMock.mockResolvedValue(undefined);
  });

  it("returns the rolling summary to an admin", async () => {
    const caller = createCaller(makeCtx("admin"));

    await expect(caller.summary({ rentalId: 10 })).resolves.toEqual({ term: null, operations: [] });
    expect(summaryMock).toHaveBeenCalledWith({}, 10);
  });

  it("starts a rolling term with the authenticated admin actor", async () => {
    const caller = createCaller(makeCtx("admin"));
    const confirmedAt = new Date("2026-08-01T12:00:00.000Z");

    await caller.start({ rentalId: 10, confirmedAt });

    expect(startMock).toHaveBeenCalledWith({}, expect.objectContaining({
      rentalId: 10,
      confirmedAt,
      actor: { id: 7, ip: "127.0.0.1" },
    }));
  });

  it("rejects commercial mutations when the rollout flag is disabled", async () => {
    featureEnabledMock.mockResolvedValue(false);
    const caller = createCaller(makeCtx("admin"));

    await expect(caller.start({ rentalId: 10 })).rejects.toThrow("disabled");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("does not allow field staff to change commercial terms", async () => {
    const caller = createCaller(makeCtx("field_staff"));

    await expect(caller.customerReady({
      rentalId: 10,
      customerReadyAt: new Date(),
    })).rejects.toThrow();
    expect(readyMock).not.toHaveBeenCalled();
  });

  it("records customer-ready time with company responsibility by default", async () => {
    const caller = createCaller(makeCtx("admin"));
    const customerReadyAt = new Date("2026-08-01T15:00:00.000Z");
    const scheduledPickupAt = new Date("2026-08-02T15:00:00.000Z");

    await caller.customerReady({ rentalId: 10, customerReadyAt, scheduledPickupAt });

    expect(readyMock).toHaveBeenCalledWith({}, expect.objectContaining({
      rentalId: 10,
      customerReadyAt,
      scheduledPickupAt,
      actor: { id: 7, ip: "127.0.0.1" },
    }));
  });

  it("requires an audited reason to change delay responsibility", async () => {
    const caller = createCaller(makeCtx("admin"));

    await expect(caller.setResponsibility({
      rentalId: 10,
      responsibility: "customer",
      reason: "late",
    })).rejects.toThrow();

    await caller.setResponsibility({
      rentalId: 10,
      responsibility: "customer",
      reason: "Customer site was not ready",
    });
    expect(responsibilityMock).toHaveBeenCalledWith({}, expect.objectContaining({
      responsibility: "customer",
      reason: "Customer site was not ready",
    }));
  });

  it("allows field staff and admins to record physical pickup", async () => {
    const pickedUpAt = new Date("2026-08-03T15:00:00.000Z");

    await createCaller(makeCtx("field_staff")).pickup({
      rentalId: 10,
      rentalFleetId: 101,
      pickedUpAt,
    });
    await createCaller(makeCtx("admin")).pickup({
      rentalId: 10,
      rentalFleetId: 102,
      pickedUpAt,
    });

    expect(pickupMock).toHaveBeenNthCalledWith(1, {}, expect.objectContaining({
      rentalFleetId: 101,
      actor: { id: 9, ip: "127.0.0.1", source: "pwa" },
    }));
    expect(pickupMock).toHaveBeenNthCalledWith(2, {}, expect.objectContaining({
      rentalFleetId: 102,
      actor: { id: 7, ip: "127.0.0.1", source: "admin_web" },
    }));
  });

  it("rejects ordinary users from pickup", async () => {
    const caller = createCaller(makeCtx("user"));

    await expect(caller.pickup({ rentalId: 10, rentalFleetId: 101 }))
      .rejects.toThrow("not authorized");
    expect(pickupMock).not.toHaveBeenCalled();
  });

  it("checks fleet occupancy before recording a physical pickup", async () => {
    assertConflictMock.mockRejectedValueOnce(new Error("Fleet occupancy conflict"));
    const caller = createCaller(makeCtx("field_staff"));

    await expect(caller.pickup({ rentalId: 10, rentalFleetId: 101 }))
      .rejects.toThrow("occupancy conflict");
    expect(pickupMock).not.toHaveBeenCalled();
  });

  it("previews historical conversion without mutating the rental", async () => {
    const caller = createCaller(makeCtx("admin"));

    await caller.classificationPreview({ rentalId: 10 });

    expect(previewMock).toHaveBeenCalledWith({}, 10, expect.any(Date));
  });

  it("requires the preview time and hash to confirm historical conversion", async () => {
    const caller = createCaller(makeCtx("admin"));
    const confirmedAt = new Date("2026-08-01T12:00:00.000Z");
    const previewHash = "a".repeat(64);

    await caller.classificationConfirm({ rentalId: 10, confirmedAt, previewHash });

    expect(confirmMock).toHaveBeenCalledWith({}, expect.objectContaining({
      rentalId: 10,
      confirmedAt,
      previewHash,
      actor: { id: 7, ip: "127.0.0.1" },
    }));
  });
});
