import { describe, expect, it, vi } from "vitest";
import * as schema from "../drizzle/schema";
import { claimAllFleetForRental } from "../server/services/rentalLineItemSync";

function makeTx(fleetIds: number[], claimResults: number[][]) {
  const updateCalls: unknown[] = [];
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(fleetIds.map((rentalFleetId) => ({ rentalFleetId }))),
      }),
    }),
    update: vi.fn().mockImplementation((table: unknown) => {
      updateCalls.push(table);
      if (table === schema.rentalFleet) {
        return {
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockImplementation(async () => {
                const ids = claimResults.shift() ?? [];
                return ids.map((id) => ({ id }));
              }),
            }),
          }),
        };
      }
      return {
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      };
    }),
  };
  return { tx, updateCalls };
}

describe("claimAllFleetForRental", () => {
  it("claims every unit through the caller transaction", async () => {
    const { tx, updateCalls } = makeTx([11, 12], [[11], [12]]);

    await expect(claimAllFleetForRental(tx as never, 42)).resolves.toEqual([11, 12]);
    expect(updateCalls).toEqual([schema.rentalFleet, schema.rentalFleet]);
  });

  it("throws when any unit cannot be claimed so the outer transaction rolls back", async () => {
    const { tx } = makeTx([11, 12], [[11], []]);

    await expect(claimAllFleetForRental(tx as never, 42)).rejects.toThrow(
      "Fleet asset 12 is no longer operationally available",
    );
  });

  it("keeps the parent fleet pointer synchronized for a single-unit rental", async () => {
    const { tx, updateCalls } = makeTx([11], [[11]]);

    await claimAllFleetForRental(tx as never, 42);
    expect(updateCalls).toEqual([schema.rentalFleet, schema.rentalRequests]);
  });
});
