import { describe, expect, it } from "vitest";
import { matchesTableSearch } from "../client/src/lib/tableSearch";
import { buildRentalSearchText } from "../client/src/pages/admin/RentalManagement/rentalSearch";
import { getGlobalSearchPath, getPositiveSearchParam } from "../client/src/lib/adminSearchNavigation";

describe("Rental Management search", () => {
  const row = {
    rental_requests: {
      id: 25,
      rentalNumber: "20260506ZB",
      financialOrderNumber: "SOT12701",
      customerName: "A&J Canada Construction Inc.",
      customerEmail: "dispatch@example.com",
      customerPhone: "416-555-0125",
      customerCompany: "A&J Canada",
      equipmentDescription: "2 Ton Mini Excavator",
      status: "completed",
      startDate: "2026-04-29T00:00:00.000Z",
      endDate: "2026-04-30T00:00:00.000Z",
    },
    rental_fleet: {
      brand: "SDLG",
      model: "ER627H",
      serialNumber: "E627-1",
      assetNumber: "FLEET-059",
      category: "Mini Excavator",
    },
  };

  it("includes every staff-visible rental identifier in normalized search text", () => {
    const text = buildRentalSearchText(row, {
      statusLabel: "已完成",
      formatDate: (value) => value.startsWith("2026-04-29") ? "2026/04/29" : "2026/04/30",
    });

    for (const expected of [
      "25", "#25", "20260506ZB", "SOT12701", "A&J Canada Construction Inc.",
      "dispatch@example.com", "416-555-0125", "2 Ton Mini Excavator", "SDLG",
      "ER627H", "E627-1", "FLEET-059", "Mini Excavator", "completed", "已完成",
      "2026/04/29", "2026/04/30",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("lets a table search values supplied by the page instead of only column keys", () => {
    const columns = [{ key: "id" }];
    const displayRow = { id: 25, displayedOrderNumber: "20260506ZB" };

    expect(matchesTableSearch(displayRow, columns, "20260506zb", (item) => item.displayedOrderNumber)).toBe(true);
    expect(matchesTableSearch(displayRow, columns, "missing", (item) => item.displayedOrderNumber)).toBe(false);
  });

  it("keeps nested column-key search as the default behavior", () => {
    const columns = [{ key: "customer.name" }];
    expect(matchesTableSearch({ customer: { name: "Dana Lee" } }, columns, "dana")).toBe(true);
  });
});

describe("Global Search navigation", () => {
  it.each([
    ["customer", 8, "/admin/customers/8"],
    ["fleet", 9, "/admin/rental-fleet?fleetId=9"],
    ["rental", 25, "/admin/rental-management?rentalId=25"],
    ["invoice", 42, "/admin/invoices?invoiceId=42"],
    ["project", 77, "/admin/projects?projectId=77"],
  ] as const)("opens the exact %s record", (kind, id, expected) => {
    expect(getGlobalSearchPath(kind, id)).toBe(expected);
  });

  it("accepts only positive integer deep-link IDs", () => {
    expect(getPositiveSearchParam("rentalId=25", "rentalId")).toBe(25);
    expect(getPositiveSearchParam("?rentalId=0", "rentalId")).toBeNull();
    expect(getPositiveSearchParam("rentalId=-2", "rentalId")).toBeNull();
    expect(getPositiveSearchParam("rentalId=2.5", "rentalId")).toBeNull();
    expect(getPositiveSearchParam("rentalId=abc", "rentalId")).toBeNull();
  });
});
