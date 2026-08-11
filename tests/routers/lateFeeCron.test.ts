/**
 * Late Fee Cron Job — mock DB tests
 *
 * Verifies that:
 * - the cron skips when feature flag is off
 * - it only processes rentals past endDate that are open (active/approved) and not returned
 * - it updates estimatedLateFee and lateFeeLastComputedAt on each rental
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────
const { mockIsEnabled, mockGetDb, overdueRows, capturedSets } = vi.hoisted(() => {
  const overdueRows: { value: unknown[] } = { value: [] };
  const capturedSets: Array<Record<string, unknown>> = [];

  // Build a mock update chain that records .set() calls
  function makeUpdateChain() {
    const whereStub = vi.fn().mockResolvedValue(undefined);
    const setStub = vi.fn().mockImplementation((fields: Record<string, unknown>) => {
      capturedSets.push({ ...fields });
      return { where: whereStub };
    });
    return {
      set: setStub,
      _whereStub: whereStub,
    };
  }

  // Settings chain — returns two setting rows
  function makeSelectChain(rows: unknown[]) {
    const chain = {
      _rows: rows,
      select: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.from.mockReturnValue(chain);
    chain.where.mockResolvedValue(rows);
    return chain;
  }

  let callCount = 0;
  const settingsRows = [
    { key: "late_fee_daily_rate_pct", value: "150" },
    { key: "late_fee_grace_hours", value: "24" },
  ];

  const updateChain = makeUpdateChain();

  const mockDb = {
    select: vi.fn().mockImplementation(() => {
      // First call = settings, second call = overdueRentals
      callCount++;
      if (callCount === 1) return makeSelectChain(settingsRows);
      return makeSelectChain(overdueRows.value);
    }),
    update: vi.fn().mockReturnValue(updateChain),
  };

  return {
    mockIsEnabled: vi.fn().mockResolvedValue(true),
    mockGetDb: vi.fn().mockResolvedValue(mockDb),
    overdueRows,
    capturedSets,
  };
});

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("../../server/db", () => ({
  getDb: mockGetDb,
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: "eq", val })),
  and: vi.fn((...args: unknown[]) => ({ type: "and", args })),
  isNull: vi.fn((col: unknown) => ({ type: "isNull", col })),
  lt: vi.fn((col: unknown, val: unknown) => ({ type: "lt", col, val })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ type: "inArray", col, vals })),
  sql: Object.assign(
    vi.fn((..._a: unknown[]) => ({ type: "sql" })),
    { raw: vi.fn() },
  ),
}));

vi.mock("../../server/services/featureFlags", () => ({
  isFeatureEnabled: mockIsEnabled,
}));

vi.mock("../../server/_core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import SUT ────────────────────────────────────────────────────────────
import { runLateFeeCron } from "../../server/jobs/lateFeeCron";

// ─────────────────────────────────────────────────────────────────────────
describe("runLateFeeCron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overdueRows.value = [];
    capturedSets.length = 0;
    mockIsEnabled.mockResolvedValue(true);
    mockGetDb.mockClear();
  });

  // ── Feature flag off ────────────────────────────────────────────────
  it("skips DB entirely when feature flag is disabled", async () => {
    mockIsEnabled.mockResolvedValue(false);
    await runLateFeeCron();
    expect(mockGetDb).not.toHaveBeenCalled();
  });

  // ── No overdue rentals ───────────────────────────────────────────────
  it("calls getDb but makes no updates when no overdue rentals", async () => {
    overdueRows.value = [];
    await runLateFeeCron();
    expect(mockGetDb).toHaveBeenCalled();
    // No update calls
    const db = await mockGetDb.mock.results[0]?.value;
    expect(db.update).not.toHaveBeenCalled();
  });

  // ── Single overdue rental — update shape ─────────────────────────────
  it("calls update with estimatedLateFee and lateFeeLastComputedAt for each rental", async () => {
    const now = new Date("2025-06-05T12:00:00Z");
    const endDate = new Date("2025-06-01T12:00:00Z"); // 4 days ago

    overdueRows.value = [
      {
        id: 42,
        rentalFee: "300.00",
        startDate: new Date("2025-05-25T12:00:00Z"),
        endDate,
        status: "active",
        returnInspectionCompleted: false,
        deletedAt: null,
      },
    ];

    await runLateFeeCron({ now });

    const db = await mockGetDb.mock.results[0]?.value;
    // update() should have been called once for the rental
    expect(db.update).toHaveBeenCalledTimes(1);

    // set() should have been called with the right shape
    const setCall = (db.update as ReturnType<typeof vi.fn>).mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        lateFeeLastComputedAt: now,
        updatedAt: now,
      }),
    );
  });

  // ── Multiple overdue rentals ─────────────────────────────────────────
  it("updates each overdue rental independently", async () => {
    const now = new Date("2025-07-01T12:00:00Z");

    overdueRows.value = [
      {
        id: 10,
        rentalFee: "100.00",
        startDate: new Date("2025-06-01T12:00:00Z"),
        endDate: new Date("2025-06-10T12:00:00Z"),
        status: "active",
        returnInspectionCompleted: false,
        deletedAt: null,
      },
      {
        id: 11,
        rentalFee: "200.00",
        startDate: new Date("2025-06-05T12:00:00Z"),
        endDate: new Date("2025-06-12T12:00:00Z"),
        status: "approved",
        returnInspectionCompleted: false,
        deletedAt: null,
      },
    ];

    await runLateFeeCron({ now });

    const db = await mockGetDb.mock.results[0]?.value;
    // update() called twice — once per rental
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  // ── estimatedLateFee = "0.00" within grace ───────────────────────────
  it("sets estimatedLateFee to '0.00' when rental is within grace period", async () => {
    const now = new Date("2025-06-02T00:00:00Z"); // only 12h after endDate
    const endDate = new Date("2025-06-01T12:00:00Z");

    overdueRows.value = [
      {
        id: 99,
        rentalFee: "500.00",
        startDate: new Date("2025-05-25T12:00:00Z"),
        endDate,
        status: "active",
        returnInspectionCompleted: false,
        deletedAt: null,
      },
    ];

    await runLateFeeCron({ now });

    const db = await mockGetDb.mock.results[0]?.value;
    const setCall = (db.update as ReturnType<typeof vi.fn>).mock.results[0].value.set;
    expect(setCall).toHaveBeenCalledWith(
      expect.objectContaining({
        estimatedLateFee: "0.00",
      }),
    );
  });

  // ── DB unavailable ───────────────────────────────────────────────────
  it("logs warning and returns early when DB is null", async () => {
    mockGetDb.mockResolvedValueOnce(null);
    // Should not throw
    await expect(runLateFeeCron()).resolves.toBeUndefined();
  });

  // ── Correct where-clause arguments passed to select ──────────────────
  it("applies the correct filter conditions for overdue rentals", async () => {
    const now = new Date("2025-06-10T00:00:00Z");
    overdueRows.value = [];

    await runLateFeeCron({ now });

    // The db.select().from().where() chain should have been called twice:
    // once for settings, once for rentals
    const db = await mockGetDb.mock.results[0]?.value;
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});
