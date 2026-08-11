import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("asset progress conflict links", () => {
  it("links conflicting rentals from the admin presentation only", () => {
    const source = readFileSync("client/src/components/AssetProgressPanel.tsx", "utf8");
    const adminSource = readFileSync("client/src/pages/admin/RentalManagement/RentalDetailDialog.tsx", "utf8");

    expect(source).toContain("showConflictRentalLinks");
    expect(source).toContain("/admin/rental-management?rentalId=");
    expect(adminSource).toContain("showConflictRentalLinks");
  });
});
