import { calculateTax } from "./taxCalculation";
import { logger } from "../_core/logger";

/**
 * Apply a referral promotion to an order's money.
 *
 * The discount comes off the BASE RENT. That matters in two directions:
 *
 *  - It used to come off `totalAmount` only, leaving `rentalFee` at list price.
 *    Nothing downstream reads `referralDiscount`, so every invoice and quotation
 *    rebuilt its subtotal as rent + freight + insurance and billed the customer
 *    the full undiscounted amount — the discount existed on the order screen and
 *    nowhere else.
 *  - Tax follows the discounted rent, since that is what the customer actually
 *    pays. Discounting the total without touching the tax base would have the
 *    customer paying tax on money they were never charged.
 *
 * The referral ledger's commission is deliberately NOT affected: the referrer
 * earns on the list price of the booking, not on what the customer paid after
 * their own discount. Callers must use the returned `baseFee` for that, which is
 * why this returns it rather than letting the caller re-read a mutated field.
 */
export interface ReferralDiscountResult {
  /** Rent before the discount — the basis for referral commission. */
  baseFee: number;
  discount: number;
  rentalFee: string;
  taxAmount: string;
  taxBreakdown: string;
  totalAmount: string;
}

export async function applyReferralDiscount(opts: {
  rentalFee: string;
  freightCost?: string | null;
  insuranceCost?: string | null;
  taxAmount?: string | null;
  taxBreakdown?: string | null;
  province: string;
  discountPercent: string;
}): Promise<ReferralDiscountResult | null> {
  const baseFee = parseFloat(opts.rentalFee);
  if (!Number.isFinite(baseFee) || baseFee <= 0) return null;

  const discountPct = parseFloat(opts.discountPercent);
  if (!Number.isFinite(discountPct) || discountPct <= 0) return null;

  const discount = Math.round(baseFee * discountPct) / 100;
  const discountedFee = Math.max(0, Math.round((baseFee - discount) * 100) / 100);

  const freight = parseFloat(opts.freightCost || "0") || 0;
  const insurance = parseFloat(opts.insuranceCost || "0") || 0;
  // Matches the order-creation basis (multiItemPricing): tax is charged on the
  // rounded-up pre-tax subtotal, and never on the refundable deposit.
  const pretaxSubtotal = Math.ceil(discountedFee + freight + insurance);

  let taxAmount = parseFloat(opts.taxAmount || "0") || 0;
  let taxBreakdown = opts.taxBreakdown || "";
  try {
    const taxResult = await calculateTax({
      rentalAmount: pretaxSubtotal,
      shippingAmount: 0,
      ldwAmount: 0,
      depositAmount: 0,
      province: opts.province,
    });
    taxAmount = taxResult.totalTax;
    taxBreakdown = taxResult.taxBreakdown;
  } catch (err) {
    // Keeping the caller's tax is wrong by the discount's worth of tax, but it
    // is far better than failing the booking outright — and it is loud.
    logger.error("[referralDiscount] Tax recalculation failed, keeping submitted tax", { err });
  }

  return {
    baseFee,
    discount,
    rentalFee: discountedFee.toFixed(2),
    taxAmount: taxAmount.toFixed(2),
    taxBreakdown,
    totalAmount: (Math.round((pretaxSubtotal + taxAmount) * 100) / 100).toFixed(2),
  };
}
