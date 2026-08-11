import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../server/_core/context";

const {
  listFlagsMock,
  setFlagMock,
  isFeatureEnabledMock,
  listAllEnabledMock,
  logAuditMock,
} = vi.hoisted(() => ({
  listFlagsMock: vi.fn(),
  setFlagMock: vi.fn(),
  isFeatureEnabledMock: vi.fn(),
  listAllEnabledMock: vi.fn(),
  logAuditMock: vi.fn(),
}));

vi.mock("../../server/services/featureFlags", () => ({
  listFlags: listFlagsMock,
  setFlag: setFlagMock,
  isFeatureEnabled: isFeatureEnabledMock,
  listAllEnabled: listAllEnabledMock,
}));

vi.mock("../../server/services/auditLog", () => ({
  logAudit: logAuditMock,
}));

import { featureFlagsRouter } from "../../server/routers/featureFlags.router";
import { t } from "../../server/_core/trpc";

const createCaller = t.createCallerFactory(featureFlagsRouter);

function makeCtx(role: "admin" | "super_admin"): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as TrpcContext["res"],
    user: {
      id: 7,
      email: "ops@example.com",
      name: "Ops Admin",
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

describe("feature flag safety controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFlagMock.mockResolvedValue(undefined);
    isFeatureEnabledMock.mockResolvedValue(true);
  });

  it("rejects ordinary admins", async () => {
    const caller = createCaller(makeCtx("admin"));

    await expect(caller.setEnabled({ key: "dispatch_workflow", enabled: false, reason: "Temporary shutdown" } as never))
      .rejects.toThrow("Only super_admin");
  });

  it("requires a reason for a safety flag", async () => {
    const caller = createCaller(makeCtx("super_admin"));

    await expect(caller.setEnabled({ key: "return_inspection_required", enabled: false } as never))
      .rejects.toThrow("reason");
    expect(setFlagMock).not.toHaveBeenCalled();
  });

  it("audits a safety flag change with old value, new value, and reason", async () => {
    const caller = createCaller(makeCtx("super_admin"));

    await caller.setEnabled({
      key: "dispatch_workflow",
      enabled: false,
      reason: "Dispatch module is temporarily unused",
    } as never);

    expect(setFlagMock).toHaveBeenCalledWith("dispatch_workflow", false);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      action: "update",
      entityType: "feature_flag",
      changes: { enabled: { old: true, new: false } },
      metadata: expect.objectContaining({
        key: "dispatch_workflow",
        reason: "Dispatch module is temporarily unused",
      }),
      ipAddress: "127.0.0.1",
    }));
  });

  it("keeps low-risk flags one-click", async () => {
    const caller = createCaller(makeCtx("super_admin"));

    await caller.setEnabled({ key: "confirm_dialog", enabled: false } as never);

    expect(setFlagMock).toHaveBeenCalledWith("confirm_dialog", false);
  });
});
