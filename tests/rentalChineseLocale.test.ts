import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rentalZh = JSON.parse(readFileSync("client/src/i18n/locales/zh/rental.json", "utf8"));
const commonZh = JSON.parse(readFileSync("client/src/i18n/locales/zh/common.json", "utf8"));
const inspectionZh = JSON.parse(readFileSync("client/src/i18n/locales/zh/inspection.json", "utf8"));
const adminZh = JSON.parse(readFileSync("client/src/i18n/locales/zh/admin.json", "utf8"));
const portalZh = JSON.parse(readFileSync("client/src/i18n/locales/zh/portal.json", "utf8"));

describe("rental Chinese locale gate", () => {
  it("has Chinese labels for known rental workflow enums and actions", () => {
    const values = [
      rentalZh["management.pickupOption"],
      commonZh.delete,
      inspectionZh.dispatch,
      inspectionZh.return,
      adminZh["invoices.typeRental"],
      adminZh["invoices.typeCreditNote"],
      commonZh["status.in_transit"],
      commonZh["status.delivered"],
    ];
    for (const value of values) {
      expect(value).toBeTruthy();
      expect(value).not.toMatch(/^(pickup|delete|dispatch|return|rental|credit note|in transit|delivered)$/i);
    }
  });

  it("does not render known raw English actions or delivery enums in rental management", () => {
    const listSource = readFileSync("client/src/pages/admin/RentalManagement/index.tsx", "utf8");
    const detailSource = readFileSync("client/src/pages/admin/RentalManagement/RentalDetailDialog.tsx", "utf8");
    const inspectionSource = readFileSync("client/src/pages/admin/RentalManagement/InspectionDetailDialog.tsx", "utf8");
    const fieldSource = readFileSync("client/src/pages/FieldDeliveries.tsx", "utf8");
    const extensionSource = readFileSync("client/src/pages/admin/ExtensionRequests.tsx", "utf8");

    expect(listSource).not.toContain('aria-label="Delete"');
    expect(listSource).not.toContain('aria-label="Close"');
    expect(listSource).not.toMatch(/>\s*(Approve All|Cancel All|Override and Create)\s*</);
    expect(detailSource).not.toMatch(/>\s*Duplicate\s*</);
    expect(detailSource).not.toContain('(r.deliveryMethod || "pickup").replace(/_/g, " ")');
    expect(inspectionSource).not.toMatch(/(aria-label|alt)="(Close|Remove|pending)"/);
    expect(fieldSource).not.toContain("LIVE OPERATIONS");
    expect(extensionSource).not.toMatch(/aria-label="(Approve|Reject|Close)"/);
    expect(portalZh.extensionRequests.adminRenewalReason).toContain("{{days}}");
    expect(rentalZh["management.deleteConfirmDetailed"]).toContain("{{rental}}");
    expect(rentalZh["management.deleteConfirmDetailed"]).toContain("{{customer}}");
  });
});
