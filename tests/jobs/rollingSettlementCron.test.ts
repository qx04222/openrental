import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, enabledMock, settleMock, warnMock, infoMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  enabledMock: vi.fn(),
  settleMock: vi.fn(),
  warnMock: vi.fn(),
  infoMock: vi.fn(),
}));

vi.mock("../../server/db", () => ({
  getDb: getDbMock,
  and: vi.fn(() => "and"),
  inArray: vi.fn(() => "inArray"),
  isNull: vi.fn(() => "isNull"),
  lte: vi.fn(() => "lte"),
}));
vi.mock("../../server/services/featureFlags", () => ({ isFeatureEnabled: enabledMock }));
vi.mock("../../server/services/rollingSettlement", () => ({
  settleRollingBoundary: settleMock,
  rollingSettlementDueWhere: vi.fn(() => "dueWhere"),
}));
vi.mock("../../server/_core/logger", () => ({
  logger: { warn: warnMock, info: infoMock, error: vi.fn() },
}));

import { runRollingSettlementCron } from "../../server/jobs/rollingSettlementCron";

function selectDb(rows: Array<{ id: number }>) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => void) => resolve(rows);
  return { select: vi.fn(() => chain) };
}

describe("rolling settlement cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enabledMock.mockResolvedValue(true);
    getDbMock.mockResolvedValue(selectDb([{ id: 1 }, { id: 2 }]));
    settleMock.mockResolvedValue({ settled: true, invoiceId: 10 });
  });

  it("performs no database reads while the rollout flag is disabled", async () => {
    enabledMock.mockResolvedValue(false);

    await expect(runRollingSettlementCron()).resolves.toEqual({ due: 0, settled: 0, failed: 0 });
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it("settles every due active or ending term", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");

    await expect(runRollingSettlementCron({ now })).resolves.toEqual({ due: 2, settled: 2, failed: 0 });
    expect(settleMock).toHaveBeenNthCalledWith(1, expect.any(Object), { termId: 1, now });
    expect(settleMock).toHaveBeenNthCalledWith(2, expect.any(Object), { termId: 2, now });
  });

  it("continues after one term fails", async () => {
    settleMock.mockRejectedValueOnce(new Error("invoice insert failed"));

    await expect(runRollingSettlementCron()).resolves.toEqual({ due: 2, settled: 1, failed: 1 });
    expect(settleMock).toHaveBeenCalledTimes(2);
    expect(warnMock).toHaveBeenCalledWith("[RollingSettlementCron] Term settlement failed", expect.objectContaining({ termId: 1 }));
  });
});
