/**
 * Price Recalculation Service
 * Recalculates rental pricing when dates change.
 * Uses the same DP algorithm as initial pricing to ensure consistency.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { calculateRentalPrice, calculateDaysBetween } from "./pricingCalculation";
import { type InsuranceType } from "../../shared/insurance";
import { calculateInsuranceCostFromSettings } from "./insuranceRate";
import { calculateTax } from "./taxCalculation";
import { calculateOrderDeposit } from "../../shared/deposit";
import { logger } from "../_core/logger";
import { resolvePricing } from "./pricingResolution";
import { getModelRatesAsOf } from "./priceVersions";

type PricingDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export interface PricingSnapshot {
  rentalFee: number;
  insuranceCost: number;
  taxAmount: number;
  freightCost: number;
  depositAmount: number;
  totalAmount: number;
  breakdown: string;
  taxBreakdown: string;
  days: number;
}

export interface RecalculationResult {
  old: PricingSnapshot;
  new: PricingSnapshot;
  diff: {
    rentalFee: number;
    insuranceCost: number;
    taxAmount: number;
    totalAmount: number;
    days: number;
  };
}

export interface RepriceLine {
  startDate: Date | null;
  endDate: Date | null;
  dailyRate: number;
  weeklyRate: number;
  monthlyRate: number;
  quantity: number;
}

/**
 * Reprice line items for a changed order window. A line whose dates track the
 * old order boundaries follows the new dates (same rule as
 * extendLineItemEndDates: end dates ≤ the old order end move with it); a line
 * with its own custom dates keeps them.
 */
export function repriceLineItems(
  lines: RepriceLine[],
  oldStart: Date,
  oldEnd: Date,
  newStart: Date,
  newEnd: Date,
): { rentalFee: number; perLine: { days: number; subtotal: number; breakdown: string }[] } {
  const perLine = lines.map((line) => {
    const start = !line.startDate || line.startDate.getTime() === oldStart.getTime() ? newStart : line.startDate;
    const end = !line.endDate || line.endDate.getTime() <= oldEnd.getTime() ? newEnd : line.endDate;
    const days = calculateDaysBetween(start, end);
    const price = calculateRentalPrice(days, line.dailyRate, line.weeklyRate, line.monthlyRate);
    const subtotal = Math.round(price.total * (line.quantity || 1) * 100) / 100;
    return { days, subtotal, breakdown: price.breakdown };
  });
  const rentalFee = Math.round(perLine.reduce((s, l) => s + l.subtotal, 0) * 100) / 100;
  return { rentalFee, perLine };
}

/**
 * Pro-rata fallback tax: scale the old tax by the change in its BASE
 * (rent + insurance + freight), never by the day ratio — freight doesn't grow
 * with the term, so ratio-scaling the tax over-counts the freight tax
 * (the #20260626TE renewal bug).
 */
export function scaleTaxByBase(oldTax: number, oldBase: number, newBase: number): number {
  if (!(oldBase > 0)) return Math.round(oldTax * 100) / 100;
  return Math.round(((oldTax * newBase) / oldBase) * 100) / 100;
}

/**
 * Price line items at their own booked dates (no window remapping) — the
 * list price of the OLD term, used to detect a negotiated rate.
 */
export function priceLineItems(
  lines: RepriceLine[],
  orderStart: Date,
  orderEnd: Date,
): { rentalFee: number; perLine: { days: number; subtotal: number; breakdown: string }[] } {
  const perLine = lines.map((line) => {
    const days = calculateDaysBetween(line.startDate ?? orderStart, line.endDate ?? orderEnd);
    const price = calculateRentalPrice(days, line.dailyRate, line.weeklyRate, line.monthlyRate);
    const subtotal = Math.round(price.total * (line.quantity || 1) * 100) / 100;
    return { days, subtotal, breakdown: price.breakdown };
  });
  const rentalFee = Math.round(perLine.reduce((s, l) => s + l.subtotal, 0) * 100) / 100;
  return { rentalFee, perLine };
}

/**
 * Carry a negotiated rate through a date change: scale the freshly-computed
 * list rental fee by the ratio the old order was actually booked at
 * (user rule 2026-07-09: 谈判价必须延续，不许续租顶回表价). No scaling when
 * the old fee matched list (±1¢) or when either side is missing/zero — bad
 * or absent data must not zero out the new price.
 */
export function carryNegotiatedRate(oldActualFee: number, oldListFee: number, newListFee: number): number {
  if (!(oldActualFee > 0) || !(oldListFee > 0)) return newListFee;
  if (Math.abs(oldActualFee - oldListFee) < 0.005) return newListFee;
  return Math.round(((newListFee * oldActualFee) / oldListFee) * 100) / 100;
}

/**
 * Recalculate rental pricing based on new dates.
 * freightCost and depositAmount stay unchanged (not date-dependent).
 * Multi-item orders (header rentalFleetId NULL, priced via rental_line_items)
 * are repriced per line from the line rate snapshots.
 */
export async function recalculateRentalPricing(
  rentalId: number,
  newStartDate: Date,
  newEndDate: Date,
  dbOverride?: PricingDb,
): Promise<RecalculationResult> {
  const db = dbOverride ?? await getDb();
  if (!db) throw new Error("Database not available");

  // Fetch rental + fleet + equipment model data
  const [data] = await db
    .select()
    .from(schema.rentalRequests)
    .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
    // The deposit policy waives account customers, so the credit limit has to
    // travel with the order — recalculating without it silently un-waives them.
    .leftJoin(schema.customers, and(eq(schema.rentalRequests.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
    .where(and(eq(schema.rentalRequests.id, rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);

  if (!data) throw new Error("Rental not found");

  const rental = data.rental_requests;
  const fleet = data.rental_fleet;

  // Multi-item orders carry no header fleet — they price via line items below.
  const lineItems = await db
    .select()
    .from(schema.rentalLineItems)
    .where(and(
      eq(schema.rentalLineItems.rentalRequestId, rentalId),
      isNull(schema.rentalLineItems.deletedAt),
    ))
    .orderBy(schema.rentalLineItems.id);

  if (!fleet && lineItems.length === 0) throw new Error("Fleet asset not found for rental");

  // Old pricing snapshot
  const oldDays = calculateDaysBetween(new Date(rental.startDate), new Date(rental.endDate));
  const oldRentalFee = parseFloat(rental.rentalFee || "0");
  const oldInsuranceCost = parseFloat(rental.insuranceCost || "0");
  const oldTaxAmount = parseFloat(rental.taxAmount || "0");
  const oldFreightCost = parseFloat(rental.freightCost || "0");
  const oldDepositAmount = parseFloat(rental.depositAmount || "0");
  const oldTotalAmount = parseFloat(rental.totalAmount || "0");

  // New pricing calculation
  const newDays = calculateDaysBetween(newStartDate, newEndDate);
  let newRentalFee: number;
  let newBreakdown: string;
  // List price of the OLD term — compared against the booked fee to detect a
  // negotiated rate that must carry through the date change.
  let oldListRentalFee = 0;

  if (fleet) {
    // Single-asset path. Resolve pricing: fleet override → equipment model
    // (category) → none. The category rate is resolved as-of the order's
    // creation date so that editing an old order's dates keeps the price that
    // was in effect when it was booked, even if the category rate has since
    // changed (effective-dated versioning). Fleet-level overrides are not
    // versioned and still take precedence via resolvePricing.
    let equipmentModel: { dailyRate: string | null; weeklyRate: string | null; monthlyRate: string | null; twentyEightDayRate: string | null } | null = null;
    if (fleet.equipmentModelId) {
      equipmentModel = await getModelRatesAsOf(db, fleet.equipmentModelId, new Date(rental.createdAt));
    }

    const resolved = resolvePricing(fleet, equipmentModel);
    const dailyRate = parseFloat(resolved.dailyRate);
    const weeklyRate = parseFloat(resolved.weeklyRate);
    const monthlyRate = parseFloat(resolved.monthlyRate);
    const newRentalPrice = calculateRentalPrice(newDays, dailyRate, weeklyRate, monthlyRate);
    newRentalFee = newRentalPrice.total;
    newBreakdown = newRentalPrice.breakdown;
    oldListRentalFee = calculateRentalPrice(oldDays, dailyRate, weeklyRate, monthlyRate).total;
  } else {
    // Multi-item path: reprice each line from its booked rate snapshot
    // (falling back to fleet/model resolution for legacy lines without one).
    const repriceLines: RepriceLine[] = [];
    for (const line of lineItems) {
      let dailyRate = parseFloat(line.dailyRate || "0");
      let weeklyRate = parseFloat(line.weeklyRate || "0");
      let monthlyRate = parseFloat(line.monthlyRate || "0");
      if (!(dailyRate > 0) && !(weeklyRate > 0) && !(monthlyRate > 0) && line.rentalFleetId) {
        const [lineFleet] = await db
          .select()
          .from(schema.rentalFleet)
          .where(and(eq(schema.rentalFleet.id, line.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
          .limit(1);
        if (lineFleet) {
          const model = lineFleet.equipmentModelId
            ? await getModelRatesAsOf(db, lineFleet.equipmentModelId, new Date(rental.createdAt))
            : null;
          const resolved = resolvePricing(lineFleet, model);
          dailyRate = parseFloat(resolved.dailyRate);
          weeklyRate = parseFloat(resolved.weeklyRate);
          monthlyRate = parseFloat(resolved.monthlyRate);
        }
      }
      repriceLines.push({
        startDate: line.startDate,
        endDate: line.endDate,
        dailyRate,
        weeklyRate,
        monthlyRate,
        quantity: line.quantity || 1,
      });
    }
    const repriced = repriceLineItems(
      repriceLines,
      new Date(rental.startDate),
      new Date(rental.endDate),
      newStartDate,
      newEndDate,
    );
    newRentalFee = repriced.rentalFee;
    newBreakdown = repriced.perLine.map((l, i) => `Line ${i + 1} (${l.days}d): ${l.breakdown}`).join(" | ");
    oldListRentalFee = priceLineItems(repriceLines, new Date(rental.startDate), new Date(rental.endDate)).rentalFee;
  }

  // Negotiated / manually-adjusted rate carries through: keep the booked
  // discount (or markup) ratio instead of snapping back to list price.
  newRentalFee = carryNegotiatedRate(oldRentalFee, oldListRentalFee, newRentalFee);

  // Insurance recalc based on new rental fee
  const insuranceType = (rental.insuranceType || "none") as InsuranceType;
  // Configured rate, same source order creation uses — the hardcoded constants
  // only stand in when the setting is missing.
  const newInsuranceCost = await calculateInsuranceCostFromSettings(db, newRentalFee, insuranceType);

  // Freight stays the same (not date-dependent)
  const newFreightCost = oldFreightCost;

  // Pre-tax subtotal, rounded UP to the whole dollar (sheet 应收费用税前 = ROUNDUP).
  // Tax, total and the deposit all derive from this single rounded subtotal.
  const pretaxSubtotal = Math.ceil(newRentalFee + newFreightCost + newInsuranceCost);

  // Tax recalc — HST on the rounded pre-tax subtotal (deposit not taxed)
  const taxProvince = rental.taxProvince || rental.deliveryProvince || rental.pickupProvince || "ON";
  let newTaxAmount = 0;
  let newTaxBreakdown = rental.taxBreakdown || "";

  try {
    const taxResult = await calculateTax({
      rentalAmount: pretaxSubtotal,
      shippingAmount: 0,
      ldwAmount: 0,
      depositAmount: 0,
      province: taxProvince,
    });
    newTaxAmount = taxResult.totalTax;
    newTaxBreakdown = taxResult.taxBreakdown;
  } catch (err) {
    logger.error("[PriceRecalculation] Tax calculation failed, keeping old tax", { err });
    newTaxAmount = oldTaxAmount;
  }

  // Billed total excludes the refundable deposit — it's a held liability, not
  // revenue (matches multiItemPricing and the reports "billed total" definition).
  const newTotalAmount = Math.round((pretaxSubtotal + newTaxAmount) * 100) / 100;

  // One deposit policy, the same one order creation uses: 1.5x the after-tax
  // total, rounded up to $50, waived for account customers. This used to call
  // the day-tiered formula instead — a different base (pre-tax), a different
  // curve, a different rounding step, and no credit waiver — so any date change
  // silently repriced the deposit under rules the order was never quoted under,
  // and re-imposed a deposit on customers whose account terms waive it.
  const newDepositAmount = calculateOrderDeposit(newTotalAmount, {
    // numeric comes back from postgres.js as a string.
    creditLimit: parseFloat(data.customers?.creditLimit ?? "0"),
  });

  const oldSnapshot: PricingSnapshot = {
    rentalFee: oldRentalFee,
    insuranceCost: oldInsuranceCost,
    taxAmount: oldTaxAmount,
    freightCost: oldFreightCost,
    depositAmount: oldDepositAmount,
    totalAmount: oldTotalAmount,
    breakdown: "",
    taxBreakdown: rental.taxBreakdown || "",
    days: oldDays,
  };

  const newSnapshot: PricingSnapshot = {
    rentalFee: newRentalFee,
    insuranceCost: newInsuranceCost,
    taxAmount: newTaxAmount,
    freightCost: newFreightCost,
    depositAmount: newDepositAmount,
    totalAmount: newTotalAmount,
    breakdown: newBreakdown,
    taxBreakdown: newTaxBreakdown,
    days: newDays,
  };

  return {
    old: oldSnapshot,
    new: newSnapshot,
    diff: {
      rentalFee: Math.round((newRentalFee - oldRentalFee) * 100) / 100,
      insuranceCost: Math.round((newInsuranceCost - oldInsuranceCost) * 100) / 100,
      taxAmount: Math.round((newTaxAmount - oldTaxAmount) * 100) / 100,
      totalAmount: Math.round((newTotalAmount - oldTotalAmount) * 100) / 100,
      days: newDays - oldDays,
    },
  };
}
