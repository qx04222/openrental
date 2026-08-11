import { describe, expect, it } from "vitest";
import { deriveRentalRollingListState } from "../shared/rentalRollingListState";

const now = new Date("2026-07-15T12:00:00.000Z");

describe("rental rolling state shown in list views", () => {
  it("shows confirmed rolling and return-in-progress states from the term", () => {
    expect(deriveRentalRollingListState({
      rentalStatus: "active",
      endDate: new Date("2026-07-10T00:00:00.000Z"),
      rollingStatus: "active",
      now,
    })).toBe("active");
    expect(deriveRentalRollingListState({
      rentalStatus: "active",
      endDate: new Date("2026-07-10T00:00:00.000Z"),
      rollingStatus: "ending",
      now,
    })).toBe("ending");
  });

  it("marks a past-due ongoing rental without a term for confirmation review", () => {
    expect(deriveRentalRollingListState({
      rentalStatus: "overdue",
      endDate: new Date("2026-07-14T00:00:00.000Z"),
      rollingStatus: null,
      now,
    })).toBe("candidate");
  });

  it("does not infer candidates for future, terminal, credit, or ended-term rentals", () => {
    expect(deriveRentalRollingListState({ rentalStatus: "active", endDate: new Date("2026-07-20T00:00:00.000Z"), rollingStatus: null, now })).toBeNull();
    expect(deriveRentalRollingListState({ rentalStatus: "completed", endDate: new Date("2026-07-10T00:00:00.000Z"), rollingStatus: null, now })).toBeNull();
    expect(deriveRentalRollingListState({ rentalStatus: "completed", endDate: new Date("2026-07-10T00:00:00.000Z"), rollingStatus: "active", now })).toBeNull();
    expect(deriveRentalRollingListState({ rentalStatus: "overdue", endDate: new Date("2026-07-10T00:00:00.000Z"), rollingStatus: null, isCreditOrder: true, now })).toBeNull();
    expect(deriveRentalRollingListState({ rentalStatus: "active", endDate: new Date("2026-07-10T00:00:00.000Z"), rollingStatus: "ended", now })).toBeNull();
  });
});
