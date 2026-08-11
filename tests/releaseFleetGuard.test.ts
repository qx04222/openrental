/**
 * releaseFleetAsset must be order-aware: closing/cancelling an order must NOT
 * flip a unit back to `available` if another *active* order still holds it.
 *
 * Regression (orders 20260629MP / 20260629LB): an overdue order was closed late,
 * after a newer order had already activated on the same unit; the fleet-id-keyed
 * release stranded the active order as "active but not rented" (double-booked alert).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { claimRef, releaseRef, updateSpy, mockDb } = vi.hoisted(() => {
  const claimRef = { value: [] as unknown[] };   // rows from the "still claimed?" probe
  const releaseRef = { value: [{ id: 1 }] as unknown[] }; // rows from the release UPDATE
  const updateSpy = vi.fn(() => ({
    set: () => ({ where: () => ({ returning: async () => releaseRef.value }) }),
  }));
  const mockDb = {
    execute: vi.fn(async () => claimRef.value),
    update: updateSpy,
  };
  return { claimRef, releaseRef, updateSpy, mockDb };
});

vi.mock("../server/db", () => ({ getDb: async () => mockDb }));
vi.mock("../server/_core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { releaseFleetAsset } from "../server/services/rentalStatusSync";

describe("releaseFleetAsset — order-aware release guard", () => {
  beforeEach(() => {
    claimRef.value = [];
    releaseRef.value = [{ id: 1 }];
    vi.clearAllMocks();
  });

  it("does NOT release when another active order still claims the unit", async () => {
    claimRef.value = [{ "?column?": 1 }]; // probe found another active claimant
    await releaseFleetAsset(77, 233); // closing order 233, but 239 still holds 77
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled(); // unit stays rented
  });

  it("releases when no other active order claims the unit", async () => {
    claimRef.value = []; // nobody else holds it
    await releaseFleetAsset(77, 233);
    expect(updateSpy).toHaveBeenCalledTimes(1); // rented → available
  });

  it("releases when called with no excludeRentalId and no active claimant", async () => {
    claimRef.value = [];
    await releaseFleetAsset(71);
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});
