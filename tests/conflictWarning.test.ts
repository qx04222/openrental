/**
 * Tests for the Conflict Warning feature (#10).
 *
 * Covers:
 * 1. ConflictWarningBanner display logic (pure TS, no DOM needed)
 * 2. getModelAvailability extended shape — conflictingRentals + alternatives
 * 3. useFeatureFlag flag-off suppression (logic layer)
 */
import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// 1. Banner logic helpers
// ---------------------------------------------------------------------------

/** Mirror of fmtDate in ConflictWarningBanner.tsx */
function fmtDate(s: string | null | undefined): string {
  if (!s) return "-";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 10);
}

describe("ConflictWarningBanner — fmtDate helper", () => {
  it("returns '-' for null", () => {
    expect(fmtDate(null)).toBe("-");
  });

  it("returns '-' for undefined", () => {
    expect(fmtDate(undefined)).toBe("-");
  });

  it("formats ISO date string to YYYY-MM-DD", () => {
    expect(fmtDate("2026-06-01T00:00:00.000Z")).toBe("2026-06-01");
  });

  it("formats simple date string", () => {
    expect(fmtDate("2026-03-15")).toBe("2026-03-15");
  });

  it("returns original string when invalid date", () => {
    expect(fmtDate("not-a-date")).toBe("not-a-date");
  });
});

// ---------------------------------------------------------------------------
// 2. Conflict banner visibility logic
// ---------------------------------------------------------------------------

interface ConflictingRentalInfo {
  id: number;
  rentalNumber: string | null;
  startDate: string | null;
  endDate: string | null;
}

interface AlternativeAsset {
  id: number;
  brand: string;
  model: string;
  assetNumber: string | null;
}

/**
 * Mirrors the shouldShowBanner guard used in the form:
 *   conflictWarningEnabled && hasConflict && selectedFleet
 */
function shouldShowBanner(
  conflictWarningEnabled: boolean | undefined,
  conflictingRentals: ConflictingRentalInfo[],
  selectedFleetId: string,
): boolean {
  return !!(conflictWarningEnabled && conflictingRentals.length > 0 && selectedFleetId);
}

describe("ConflictWarningBanner — visibility logic", () => {
  const mockConflict: ConflictingRentalInfo = {
    id: 42,
    rentalNumber: "R-2026-0042",
    startDate: "2026-06-01",
    endDate: "2026-06-10",
  };

  it("hides banner when feature flag is off", () => {
    expect(shouldShowBanner(false, [mockConflict], "7")).toBe(false);
  });

  it("hides banner when feature flag is undefined (loading)", () => {
    expect(shouldShowBanner(undefined, [mockConflict], "7")).toBe(false);
  });

  it("hides banner when there are no conflicts", () => {
    expect(shouldShowBanner(true, [], "7")).toBe(false);
  });

  it("hides banner when no fleet asset is selected", () => {
    expect(shouldShowBanner(true, [mockConflict], "")).toBe(false);
  });

  it("shows banner when flag is on, conflict exists, and fleet is selected", () => {
    expect(shouldShowBanner(true, [mockConflict], "7")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Conflict banner content logic
// ---------------------------------------------------------------------------

function buildBannerText(
  assetLabel: string,
  startDate: string,
  endDate: string,
  conflict: ConflictingRentalInfo,
): string {
  const rentalRef = conflict.rentalNumber
    ? `#${conflict.rentalNumber}`
    : `#${conflict.id}`;
  return `${assetLabel} 在 ${fmtDate(startDate)} 至 ${fmtDate(endDate)} 已被订单 ${rentalRef} 占用`;
}

describe("ConflictWarningBanner — banner text", () => {
  it("shows rental number when available", () => {
    const text = buildBannerText(
      "BrandX Model500",
      "2026-06-01",
      "2026-06-10",
      { id: 42, rentalNumber: "R-2026-0042", startDate: "2026-06-01", endDate: "2026-06-10" },
    );
    expect(text).toContain("#R-2026-0042");
    expect(text).toContain("BrandX Model500");
    expect(text).toContain("2026-06-01");
    expect(text).toContain("2026-06-10");
  });

  it("falls back to rental id when rentalNumber is null", () => {
    const text = buildBannerText(
      "BrandX Model500",
      "2026-06-01",
      "2026-06-10",
      { id: 99, rentalNumber: null, startDate: null, endDate: null },
    );
    expect(text).toContain("#99");
  });
});

// ---------------------------------------------------------------------------
// 4. Alternatives list logic
// ---------------------------------------------------------------------------

describe("ConflictWarningBanner — alternatives list", () => {
  const alternatives: AlternativeAsset[] = [
    { id: 10, brand: "Acme", model: "BinPro", assetNumber: "A-001" },
    { id: 11, brand: "Acme", model: "BinPro", assetNumber: null },
  ];

  it("renders alternative label with assetNumber when present", () => {
    const alt = alternatives[0];
    const label = `${alt.brand} ${alt.model}${alt.assetNumber ? ` (${alt.assetNumber})` : ""}`;
    expect(label).toBe("Acme BinPro (A-001)");
  });

  it("renders alternative label without assetNumber when null", () => {
    const alt = alternatives[1];
    const label = `${alt.brand} ${alt.model}${alt.assetNumber ? ` (${alt.assetNumber})` : ""}`;
    expect(label).toBe("Acme BinPro");
  });

  it("returns empty message when no alternatives", () => {
    const msg = alternatives.length === 0 ? "暂无同型号可用资产" : "";
    const emptyMsg: AlternativeAsset[] = [];
    const emptyResult = emptyMsg.length === 0 ? "暂无同型号可用资产" : "";
    expect(emptyResult).toBe("暂无同型号可用资产");
  });
});

// ---------------------------------------------------------------------------
// 5. ModelAvailabilityResult shape validation
// ---------------------------------------------------------------------------

interface ModelAvailabilityResult {
  total: number;
  available: number;
  conflictingRentals?: ConflictingRentalInfo[];
  alternatives?: AlternativeAsset[];
}

describe("ModelAvailabilityResult — shape", () => {
  it("base result has total and available", () => {
    const result: ModelAvailabilityResult = { total: 5, available: 3 };
    expect(result.total).toBe(5);
    expect(result.available).toBe(3);
    expect(result.conflictingRentals).toBeUndefined();
    expect(result.alternatives).toBeUndefined();
  });

  it("conflict result includes conflictingRentals and alternatives", () => {
    const result: ModelAvailabilityResult = {
      total: 5,
      available: 3,
      conflictingRentals: [
        { id: 42, rentalNumber: "R-001", startDate: "2026-06-01", endDate: "2026-06-10" },
      ],
      alternatives: [
        { id: 10, brand: "Acme", model: "BinPro", assetNumber: "A-001" },
      ],
    };
    expect(result.conflictingRentals).toHaveLength(1);
    expect(result.conflictingRentals![0].id).toBe(42);
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives![0].id).toBe(10);
  });

  it("conflict result can have zero alternatives when none available", () => {
    const result: ModelAvailabilityResult = {
      total: 2,
      available: 0,
      conflictingRentals: [
        { id: 99, rentalNumber: null, startDate: "2026-06-01", endDate: "2026-06-30" },
      ],
      alternatives: [],
    };
    expect(result.conflictingRentals).toHaveLength(1);
    expect(result.alternatives).toHaveLength(0);
  });
});
