/**
 * The referral discount used to come off `totalAmount` only, leaving
 * `rentalFee` at list price — and since nothing downstream reads
 * `referralDiscount`, every invoice and quotation rebuilt its subtotal from the
 * undiscounted rent and billed the customer the full amount. The discount
 * existed on the order screen and nowhere else.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../server/services/taxCalculation", () => ({
  // Flat 13% HST on the pre-tax subtotal, enough to pin the tax base.
  calculateTax: vi.fn(async ({ rentalAmount }: { rentalAmount: number }) => ({
    totalTax: Math.round(rentalAmount * 13) / 100,
    taxBreakdown: "HST 13%",
  })),
}));

const { applyReferralDiscount } = await import("../server/services/referralDiscount");
const { calculateTax } = await import("../server/services/taxCalculation");

beforeEach(() => vi.clearAllMocks());

describe("referral discount", () => {
  it("takes the discount off the base rent", async () => {
    const applied = await applyReferralDiscount({
      rentalFee: "1000.00",
      province: "ON",
      discountPercent: "10",
    });

    expect(applied?.discount).toBe(100);
    expect(applied?.rentalFee).toBe("900.00");
  });

  it("moves the tax base down with the rent", async () => {
    // Charging tax on rent the customer was never billed for would overcharge.
    await applyReferralDiscount({
      rentalFee: "1000.00",
      freightCost: "100.00",
      insuranceCost: "50.00",
      province: "ON",
      discountPercent: "10",
    });

    expect(calculateTax).toHaveBeenCalledWith(
      expect.objectContaining({ rentalAmount: 1050 }), // 900 + 100 + 50
    );
  });

  it("reports the pre-discount rent so commission is earned on list price", async () => {
    const applied = await applyReferralDiscount({
      rentalFee: "1000.00",
      province: "ON",
      discountPercent: "10",
    });

    // The referrer earns on the booking, not on the customer's discount.
    expect(applied?.baseFee).toBe(1000);
  });

  it("returns a total that equals its own parts", async () => {
    const applied = await applyReferralDiscount({
      rentalFee: "1000.00",
      freightCost: "100.00",
      insuranceCost: "50.00",
      province: "ON",
      discountPercent: "10",
    });

    const parts = 1050 + parseFloat(applied!.taxAmount);
    expect(parseFloat(applied!.totalAmount)).toBeCloseTo(parts, 2);
  });

  it("declines to touch anything when there is no rent or no discount", async () => {
    expect(await applyReferralDiscount({ rentalFee: "0", province: "ON", discountPercent: "10" })).toBeNull();
    expect(await applyReferralDiscount({ rentalFee: "100", province: "ON", discountPercent: "0" })).toBeNull();
  });

  it("keeps the submitted tax rather than failing the booking when tax lookup dies", async () => {
    vi.mocked(calculateTax).mockRejectedValueOnce(new Error("tax service down"));

    const applied = await applyReferralDiscount({
      rentalFee: "1000.00",
      taxAmount: "130.00",
      province: "ON",
      discountPercent: "10",
    });

    expect(applied?.rentalFee).toBe("900.00");
    expect(applied?.taxAmount).toBe("130.00");
  });
});
