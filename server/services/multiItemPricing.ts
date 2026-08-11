/**
 * Pricing engine for multi-item rentals. Same rules used by both the live
 * customer-facing quote preview and the server-side createWithItems insert,
 * so the customer sees exactly the price that gets persisted.
 *
 * Rules:
 *   rental fee     sum of per-line (best-of dailyRate/weeklyRate/monthlyRate)
 *                  for that line's days × quantity
 *   deposit        sum of per-line calculateDepositFromRules
 *   freight        max single-item freight + 25% × max × (additional lines)
 *                  attachment-only lines (no fleetId) contribute 0
 *   insurance      based on rental fee × pct from settings (none/basic/full)
 *   tax            (rentalFee + freight + insurance) × province rate
 */
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { calculateInsuranceCostFromSettings } from "./insuranceRate";
import { calculateRentalPrice, calculateDaysBetween } from "./pricingCalculation";
import { calculateOrderDeposit } from "../../shared/deposit";
import { calculateBracketFreight, type FreightMethod } from "../../shared/freight";
import { loadFreightConfig, loadDepositConfig } from "./pricingConfig";
import { getDrivingDistanceKm, getWarehouseAddress } from "./shipping";
import { calculateTax } from "./taxCalculation";

type Db = NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;

export interface QuoteItemInput {
  equipmentModelId: number | null;
  fleetIds: number[];           // candidates; pricing uses the first valid one for rate lookup
  itemType: "machine" | "attachment";
  quantity: number;
  startDate?: string | null;    // ISO; falls back to order startDate
  endDate?: string | null;
}

export interface QuoteInput {
  startDate: string;
  endDate: string;
  deliveryMethod: "pickup" | "delivery" | "delivery_and_return";
  deliveryAddress?: string;
  taxProvince?: string;
  insuranceType?: "none" | "basic" | "full";
  /** Customer ID — when set, customer_pricing rows are checked for discounts. */
  customerId?: number;
  items: QuoteItemInput[];
}

export interface QuoteLineResult {
  itemType: "machine" | "attachment";
  days: number;
  quantity: number;
  dailyRate: number;
  weeklyRate: number;
  monthlyRate: number;
  lineSubtotal: number;
  lineDeposit: number;
  freightContribution: number;
  breakdown: string;
}

export interface QuoteResult {
  perLine: QuoteLineResult[];
  rentalFee: number;
  freightCost: number;
  deliveryDistanceKm: number | null;
  /** Freight fell back to the lowest bracket because the distance was unknown. */
  freightEstimated: boolean;
  /** Distance is beyond the auto-quote range — transport must quote manually. */
  freightNeedsManual: boolean;
  insuranceCost: number;
  depositAmount: number;
  taxAmount: number;
  taxBreakdown: string;
  totalAmount: number;
  warnings: string[];
  /** A machine line resolved to no rate (priced at $0). Create endpoints reject
   *  on this so a rate-less model can't be booked for free; preview only warns. */
  hasUnpricedMachine: boolean;
}

async function loadModelRates(db: Db, modelId: number) {
  const [m] = await db
    .select({
      dailyRate: schema.equipmentModels.dailyRate,
      weeklyRate: schema.equipmentModels.weeklyRate,
      monthlyRate: schema.equipmentModels.monthlyRate,
      category: schema.equipmentModels.category,
    })
    .from(schema.equipmentModels)
    .where(and(eq(schema.equipmentModels.id, modelId), isNull(schema.equipmentModels.deletedAt)))
    .limit(1);
  return m || null;
}

async function loadFleetRates(db: Db, fleetId: number) {
  const [f] = await db
    .select({
      dailyRate: schema.rentalFleet.dailyRate,
      weeklyRate: schema.rentalFleet.weeklyRate,
      monthlyRate: schema.rentalFleet.monthlyRate,
      category: schema.rentalFleet.category,
      equipmentModelId: schema.rentalFleet.equipmentModelId,
      catalogCacheId: schema.rentalFleet.catalogCacheId,
      locationId: schema.rentalFleet.locationId,
    })
    .from(schema.rentalFleet)
    .where(and(eq(schema.rentalFleet.id, fleetId), isNull(schema.rentalFleet.deletedAt)))
    .limit(1);
  return f || null;
}

// One-way driving distance (km) from the asset's warehouse to the delivery
// address — the basis for the distance-bracket freight. null when it can't be
// determined (→ manual freight).
async function freightDistanceForFleet(db: Db, fleetId: number, deliveryAddress: string): Promise<number | null> {
  try {
    const [fleet] = await db
      .select({ locationId: schema.rentalFleet.locationId })
      .from(schema.rentalFleet)
      .where(and(eq(schema.rentalFleet.id, fleetId), isNull(schema.rentalFleet.deletedAt)))
      .limit(1);
    let origin = { addressLine1: "100 Example Ave", city: "Toronto", province: "ON", postalCode: "M5V 0A1" };
    if (fleet?.locationId) {
      const wh = await getWarehouseAddress(fleet.locationId);
      if (wh && wh.addressLine1 && wh.city) origin = wh;
    }
    const dest = { addressLine1: deliveryAddress, city: "", province: "", postalCode: "" };
    return await getDrivingDistanceKm(origin, dest);
  } catch {
    return null;
  }
}

export async function quoteMultiItem(db: Db, input: QuoteInput): Promise<QuoteResult> {
  const warnings: string[] = [];
  let hasUnpricedMachine = false;
  const orderStart = new Date(input.startDate);
  const orderEnd = new Date(input.endDate);
  if (isNaN(orderStart.getTime()) || isNaN(orderEnd.getTime()) || orderEnd <= orderStart) {
    return {
      perLine: [], rentalFee: 0, freightCost: 0, deliveryDistanceKm: null,
      freightEstimated: false, freightNeedsManual: false, insuranceCost: 0,
      depositAmount: 0, taxAmount: 0, taxBreakdown: "", totalAmount: 0,
      warnings: ["Invalid date range"], hasUnpricedMachine: false,
    };
  }

  // ── Per-line: rates, days, subtotal, deposit, freight contribution ──
  const perLine: QuoteLineResult[] = [];
  let firstFleetId: number | null = null;

  for (const item of input.items) {
    const ls = item.startDate ? new Date(item.startDate) : orderStart;
    const le = item.endDate ? new Date(item.endDate) : orderEnd;
    const days = calculateDaysBetween(ls, le);

    // Rate lookup: prefer model rate, fall back to fleet rate
    let daily = 0, weekly = 0, monthly = 0, category: string | null = null;
    if (item.equipmentModelId) {
      const m = await loadModelRates(db, item.equipmentModelId);
      if (m) {
        daily = parseFloat(m.dailyRate || "0");
        weekly = parseFloat(m.weeklyRate || "0");
        monthly = parseFloat(m.monthlyRate || "0");
        category = m.category;
      }
    }
    if (!daily && item.fleetIds[0]) {
      const f = await loadFleetRates(db, item.fleetIds[0]);
      if (f) {
        daily = parseFloat(f.dailyRate || "0");
        weekly = parseFloat(f.weeklyRate || "0");
        monthly = parseFloat(f.monthlyRate || "0");
        category = category || f.category;
        // Fall back to the unit's linked MODEL rate when the unit has no own rate.
        // Rates are commonly set at the model/category level (not per unit), and
        // the public/self-serve path passes equipmentModelId=null — without this,
        // such a unit would quote at $0. Mirrors the UI's resolvedDailyRate.
        if (!daily && !weekly && !monthly && f.equipmentModelId) {
          const m = await loadModelRates(db, f.equipmentModelId);
          if (m) {
            daily = parseFloat(m.dailyRate || "0");
            weekly = parseFloat(m.weeklyRate || "0");
            monthly = parseFloat(m.monthlyRate || "0");
            category = category || m.category;
          }
        }
      }
    }

    // Customer-specific pricing override (per-fleet contract or category discount).
    // Falls back silently when no customer / no fleet candidate / no rule.
    if (input.customerId && item.fleetIds[0]) {
      try {
        const { resolveCustomerPricing } = await import("./customerPricingLookup");
        const cp = await resolveCustomerPricing(input.customerId, item.fleetIds[0]);
        if (cp.source !== "default") {
          daily = cp.dailyRate;
          weekly = cp.weeklyRate;
          monthly = cp.monthlyRate;
        }
      } catch {
        // best-effort; default rates already loaded
      }
    }

    // A machine line with no positive rate would price at $0 — surface it as a
    // warning instead of letting a misconfigured asset quote for free.
    if (item.itemType !== "attachment" && daily <= 0 && weekly <= 0 && monthly <= 0) {
      warnings.push("One or more items have no rental rate configured and were priced at $0");
      hasUnpricedMachine = true;
    }

    const priceCalc = calculateRentalPrice(days, daily, weekly, monthly);
    const lineSubtotal = priceCalc.total * item.quantity;

    // Deposit is computed once at the order level (day-tiered, below), not per line.
    const lineDeposit = 0;

    // Track the first usable fleet id so freight (one delivery for the whole
    // order) can be priced by distance below.
    if (firstFleetId == null && item.fleetIds[0]) firstFleetId = item.fleetIds[0];

    perLine.push({
      itemType: item.itemType,
      days,
      quantity: item.quantity,
      dailyRate: daily,
      weeklyRate: weekly,
      monthlyRate: monthly,
      lineSubtotal: Math.round(lineSubtotal * 100) / 100,
      lineDeposit: Math.round(lineDeposit * 100) / 100,
      freightContribution: 0,
      breakdown: priceCalc.breakdown,
    });
  }

  const rentalFee = perLine.reduce((s, l) => s + l.lineSubtotal, 0);

  // ── Freight: one delivery for the whole order, priced by distance bracket. ──
  //   round-trip = distance tier; one-way = tier ÷ 2 × 1.15 (nearest $10).
  //   Over the max distance → 0 + a "needs manual quote" warning.
  let freightCost = 0;
  // One-way driving distance (warehouse → delivery address). Persisted on the
  // order so delivery distance can be reported without the dispatch feature.
  let deliveryDistanceKm: number | null = null;
  // freightEstimated: distance unknown → charged the lowest bracket, verify later.
  // freightNeedsManual: distance beyond the auto-quote range → transport must quote.
  let freightEstimated = false;
  let freightNeedsManual = false;
  if (input.deliveryMethod !== "pickup" && input.deliveryAddress && firstFleetId != null) {
    const distanceKm = await freightDistanceForFleet(db, firstFleetId, input.deliveryAddress);
    deliveryDistanceKm = distanceKm;
    const freightCfg = await loadFreightConfig(db);
    const fr = calculateBracketFreight(distanceKm, input.deliveryMethod as FreightMethod, freightCfg);
    freightCost = fr.cost;
    freightNeedsManual = !!fr.needsManual;
    freightEstimated = !!fr.assumedMinTier;
    if (fr.needsManual) {
      warnings.push("Delivery distance exceeds the auto-quote range — confirm freight with the transport department.");
    } else if (fr.assumedMinTier) {
      warnings.push("Delivery distance could not be determined — charged the lowest (≤30 km) bracket; confirm freight with the transport department.");
    }
  }
  freightCost = Math.round(freightCost * 100) / 100;

  // ── Insurance ──
  // Reads the same keys the admin's RentalSettings → Insurance tab writes:
  //   insurance_basic_rate   numeric like "0.15"  (15% of rental fee)
  //   insurance_full_rate    numeric like "0.25"
  // Fallbacks match the current production rates so display == engine even if
  // a key is somehow missing.
  let insuranceCost = 0;
  if (input.insuranceType && input.insuranceType !== "none") {
    insuranceCost = await calculateInsuranceCostFromSettings(db, rentalFee, input.insuranceType);
  }

  // ── Pre-tax subtotal ──
  // Match the office sheet's 应收费用(税前) = ROUNDUP(租金 + 保险 + 运费, 0):
  // round the pre-tax subtotal UP to the whole dollar. Tax, total and the
  // security deposit all derive from this single rounded subtotal.
  const pretaxSubtotal = Math.ceil(rentalFee + freightCost + insuranceCost);

  // ── Tax (HST on the rounded pre-tax subtotal) ──
  let taxAmount = 0;
  let taxBreakdown = "";
  if (input.taxProvince) {
    try {
      const taxRes = await calculateTax({
        province: input.taxProvince,
        rentalAmount: pretaxSubtotal,
        shippingAmount: 0,
        ldwAmount: 0,
        depositAmount: 0,
      });
      taxAmount = taxRes.totalTax;
      taxBreakdown = taxRes.taxBreakdown;
    } catch {
      warnings.push("Tax calculation unavailable");
    }
  }

  // ── Deposit ──
  // 1.5 × the after-tax (rent + insurance + freight) total, rounded up to $50.
  // Account / credit customers (creditLimit > 0) are waived to $0. Held as a
  // liability — NOT added to the billed total.
  let creditLimit = 0;
  if (input.customerId) {
    const [cust] = await db
      .select({ creditLimit: schema.customers.creditLimit })
      .from(schema.customers)
      .where(and(eq(schema.customers.id, input.customerId), isNull(schema.customers.deletedAt)))
      .limit(1);
    creditLimit = cust?.creditLimit ? parseFloat(cust.creditLimit) : 0;
  }
  const depositConfig = await loadDepositConfig(db);
  const afterTaxTotal = pretaxSubtotal + taxAmount;
  const depositAmount = calculateOrderDeposit(afterTaxTotal, { creditLimit, config: depositConfig });

  const totalAmount = Math.round((pretaxSubtotal + taxAmount) * 100) / 100;

  return {
    perLine,
    rentalFee: Math.round(rentalFee * 100) / 100,
    freightCost,
    deliveryDistanceKm,
    freightEstimated,
    freightNeedsManual,
    insuranceCost,
    depositAmount: Math.round(depositAmount * 100) / 100,
    taxAmount: Math.round(taxAmount * 100) / 100,
    taxBreakdown,
    totalAmount,
    warnings,
    hasUnpricedMachine,
  };
}
