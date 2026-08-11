import { describe, expect, it } from "vitest";
import { deriveFleetRentalConflicts } from "../server/services/rentalFleetConflict";

const claim = (overrides: Partial<{
  rentalFleetId: number;
  rentalId: number;
  rentalNumber: string | null;
  customerName: string;
  status: string;
}> = {}) => ({
  rentalFleetId: 71,
  rentalId: 58,
  rentalNumber: "20260528TB",
  customerName: "Okoye General Contracting",
  status: "overdue",
  ...overrides,
});

describe("fleet rental conflict derivation", () => {
  it("reports two distinct open rentals claiming the same fleet unit", () => {
    const conflicts = deriveFleetRentalConflicts([
      claim(),
      claim({ rentalId: 251, rentalNumber: "20260702TI", customerName: "Birchwood Landscaping" }),
    ]);

    expect(conflicts.get(71)).toEqual({
      rentalFleetId: 71,
      rentals: [
        expect.objectContaining({ rentalId: 58, rentalNumber: "20260528TB" }),
        expect.objectContaining({ rentalId: 251, rentalNumber: "20260702TI" }),
      ],
    });
  });

  it("deduplicates parent and line-item claims from the same rental", () => {
    const conflicts = deriveFleetRentalConflicts([claim(), claim()]);

    expect(conflicts.size).toBe(0);
  });

  it("does not report different fleet units as a conflict", () => {
    const conflicts = deriveFleetRentalConflicts([
      claim(),
      claim({ rentalFleetId: 72, rentalId: 251, rentalNumber: "20260702TI" }),
    ]);

    expect(conflicts.size).toBe(0);
  });
});
