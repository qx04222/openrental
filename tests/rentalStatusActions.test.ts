import { describe, expect, it } from "vitest";
import { directRentalStatusOptions } from "../client/src/lib/rentalStatusActions";

describe("directRentalStatusOptions", () => {
  it("does not offer completed as a direct status change for an open rental", () => {
    expect(directRentalStatusOptions("active")).not.toContain("completed");
    expect(directRentalStatusOptions("overdue")).not.toContain("completed");
    expect(directRentalStatusOptions("approved")).not.toContain("completed");
  });

  it("keeps completed visible as the selected value on an already closed rental", () => {
    expect(directRentalStatusOptions("completed")).toContain("completed");
  });
});
