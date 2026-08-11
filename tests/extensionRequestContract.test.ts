import { describe, expect, it } from "vitest";
import { toExtensionRequestRow, type ExtensionRequestListItem } from "../client/src/lib/extensionRequestRow";

function requestItem(overrides: Partial<ExtensionRequestListItem> = {}): ExtensionRequestListItem {
  return {
    extension: {
      id: 42,
      rentalRequestId: 278,
      customerId: 7,
      requestedEndDate: new Date("2026-07-18T01:00:00.000Z"),
      reason: "Customer requested more time",
      status: "approved",
      adminNotes: null,
      reviewedBy: 1,
      reviewedAt: new Date("2026-07-17T13:00:00.000Z"),
      createdAt: new Date("2026-07-17T12:00:00.000Z"),
      updatedAt: new Date("2026-07-17T13:00:00.000Z"),
    },
    customer: {
      id: 7,
      name: "Test Customer",
      email: "customer@example.com",
      phone: "416-555-0100",
      company: "Test Co",
    },
    rental: {
      id: 278,
      rentalNumber: "20260716NG",
      equipmentDescription: "SDLG STR1000H",
      startDate: new Date("2026-07-16T04:00:00.000Z"),
      endDate: new Date("2026-07-17T04:00:00.000Z"),
      status: "completed",
    },
    ...overrides,
  };
}

describe("extension request API contract", () => {
  it("maps the nested API response without flattening it", () => {
    expect(toExtensionRequestRow(requestItem())).toMatchObject({
      id: 42,
      customerName: "Test Customer",
      rentalId: 278,
      rentalNumber: "20260716NG",
      rawReason: "Customer requested more time",
      status: "approved",
    });
  });

  it("preserves a usable row when nullable joins are missing", () => {
    expect(toExtensionRequestRow(requestItem({ customer: null, rental: null }))).toMatchObject({
      customerName: "-",
      rentalNumber: "#278",
    });
  });

  it("formats the requested end date in the Toronto business timezone", () => {
    const item = requestItem();
    const expected = item.extension.requestedEndDate.toLocaleDateString("en-CA", {
      timeZone: "America/Toronto",
    });

    expect(toExtensionRequestRow(item).requestedDate).toBe(expected);
  });
});
