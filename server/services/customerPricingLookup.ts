/**
 * Customer Pricing Lookup
 * Resolves effective rates for a customer+equipment combination.
 * Priority: specific fleet > category match > default rates
 */

import { getDb, eq, and, isNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { resolvePricing } from "./pricingResolution";

export interface ResolvedPricing {
  dailyRate: number;
  weeklyRate: number;
  monthlyRate: number;
  twentyEightDayRate?: number;
  source: "customer_fleet" | "customer_category" | "customer_default" | "default";
  discountPercent?: number;
  pricingId?: number;
}

export async function resolveCustomerPricing(
  customerId: number,
  fleetId: number,
): Promise<ResolvedPricing> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // ISO string, NOT a Date: binding a JS Date inside a raw sql`` fragment under
  // postgres-js (prepare:false) serializes it to a locale string and throws,
  // which is swallowed upstream and silently drops customer pricing (wrong price
  // charged). Same class as the portal-signing crash (campaign R3-03).
  const now = new Date().toISOString();

  // 1. Try exact fleet match
  const [fleetMatch] = await db
    .select()
    .from(schema.customerPricing)
    .where(and(
      eq(schema.customerPricing.customerId, customerId),
      eq(schema.customerPricing.rentalFleetId, fleetId),
      eq(schema.customerPricing.isActive, true),
      sql`${schema.customerPricing.validFrom} <= ${now}`,
      sql`(${schema.customerPricing.validTo} IS NULL OR ${schema.customerPricing.validTo} >= ${now})`,
    ))
    .limit(1);

  // Get fleet + equipment model rates for resolution
  const [fleet] = await db
    .select()
    .from(schema.rentalFleet)
    .where(and(eq(schema.rentalFleet.id, fleetId), isNull(schema.rentalFleet.deletedAt)))
    .limit(1);

  if (!fleet) throw new Error(`Fleet #${fleetId} not found`);

  // Look up the equipment model for category-level rates
  let equipmentModel: { dailyRate: string | null; weeklyRate: string | null; monthlyRate: string | null; twentyEightDayRate: string | null } | null = null;
  if (fleet.equipmentModelId) {
    const [model] = await db
      .select({
        dailyRate: schema.equipmentModels.dailyRate,
        weeklyRate: schema.equipmentModels.weeklyRate,
        monthlyRate: schema.equipmentModels.monthlyRate,
        twentyEightDayRate: schema.equipmentModels.twentyEightDayRate,
      })
      .from(schema.equipmentModels)
      .where(and(eq(schema.equipmentModels.id, fleet.equipmentModelId), isNull(schema.equipmentModels.deletedAt)))
      .limit(1);
    if (model) equipmentModel = model;
  }

  const resolved = resolvePricing(fleet, equipmentModel);
  const defaultRates = {
    dailyRate: parseFloat(resolved.dailyRate),
    weeklyRate: parseFloat(resolved.weeklyRate),
    monthlyRate: parseFloat(resolved.monthlyRate),
    twentyEightDayRate: resolved.twentyEightDayRate ? parseFloat(resolved.twentyEightDayRate) : undefined,
  };

  if (fleetMatch) {
    // If discount-based, apply to defaults
    if (fleetMatch.discountPercent) {
      const discount = parseFloat(fleetMatch.discountPercent) / 100;
      return {
        dailyRate: Math.round(defaultRates.dailyRate * (1 - discount) * 100) / 100,
        weeklyRate: Math.round(defaultRates.weeklyRate * (1 - discount) * 100) / 100,
        monthlyRate: Math.round(defaultRates.monthlyRate * (1 - discount) * 100) / 100,
        twentyEightDayRate: defaultRates.twentyEightDayRate
          ? Math.round(defaultRates.twentyEightDayRate * (1 - discount) * 100) / 100
          : undefined,
        source: "customer_fleet",
        discountPercent: parseFloat(fleetMatch.discountPercent),
        pricingId: fleetMatch.id,
      };
    }
    // Direct rate override
    return {
      dailyRate: parseFloat(fleetMatch.dailyRate || "0") || defaultRates.dailyRate,
      weeklyRate: parseFloat(fleetMatch.weeklyRate || "0") || defaultRates.weeklyRate,
      monthlyRate: parseFloat(fleetMatch.monthlyRate || "0") || defaultRates.monthlyRate,
      twentyEightDayRate: fleetMatch.twentyEightDayRate
        ? parseFloat(fleetMatch.twentyEightDayRate)
        : defaultRates.twentyEightDayRate,
      source: "customer_fleet",
      pricingId: fleetMatch.id,
    };
  }

  // 2. Try category match
  if (fleet.category) {
    const [catMatch] = await db
      .select()
      .from(schema.customerPricing)
      .where(and(
        eq(schema.customerPricing.customerId, customerId),
        isNull(schema.customerPricing.rentalFleetId),
        eq(schema.customerPricing.category, fleet.category),
        eq(schema.customerPricing.isActive, true),
        sql`${schema.customerPricing.validFrom} <= ${now}`,
        sql`(${schema.customerPricing.validTo} IS NULL OR ${schema.customerPricing.validTo} >= ${now})`,
      ))
      .limit(1);

    if (catMatch) {
      if (catMatch.discountPercent) {
        const discount = parseFloat(catMatch.discountPercent) / 100;
        return {
          dailyRate: Math.round(defaultRates.dailyRate * (1 - discount) * 100) / 100,
          weeklyRate: Math.round(defaultRates.weeklyRate * (1 - discount) * 100) / 100,
          monthlyRate: Math.round(defaultRates.monthlyRate * (1 - discount) * 100) / 100,
          twentyEightDayRate: defaultRates.twentyEightDayRate
            ? Math.round(defaultRates.twentyEightDayRate * (1 - discount) * 100) / 100
            : undefined,
          source: "customer_category",
          discountPercent: parseFloat(catMatch.discountPercent),
          pricingId: catMatch.id,
        };
      }
      return {
        dailyRate: parseFloat(catMatch.dailyRate || "0") || defaultRates.dailyRate,
        weeklyRate: parseFloat(catMatch.weeklyRate || "0") || defaultRates.weeklyRate,
        monthlyRate: parseFloat(catMatch.monthlyRate || "0") || defaultRates.monthlyRate,
        twentyEightDayRate: catMatch.twentyEightDayRate
          ? parseFloat(catMatch.twentyEightDayRate)
          : defaultRates.twentyEightDayRate,
        source: "customer_category",
        pricingId: catMatch.id,
      };
    }
  }

  // 3. Customer-wide discount (big-customer tier): no fleet/category contract
  // row matched, so fall back to the customer's blanket discountPercent.
  const [customer] = await db
    .select({ discountPercent: schema.customers.discountPercent })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
    .limit(1);
  const custPct = customer ? parseFloat(customer.discountPercent || "0") : 0;
  if (custPct > 0) {
    const discount = custPct / 100;
    return {
      dailyRate: Math.round(defaultRates.dailyRate * (1 - discount) * 100) / 100,
      weeklyRate: Math.round(defaultRates.weeklyRate * (1 - discount) * 100) / 100,
      monthlyRate: Math.round(defaultRates.monthlyRate * (1 - discount) * 100) / 100,
      twentyEightDayRate: defaultRates.twentyEightDayRate
        ? Math.round(defaultRates.twentyEightDayRate * (1 - discount) * 100) / 100
        : undefined,
      source: "customer_default",
      discountPercent: custPct,
    };
  }

  // 4. Default rates
  return { ...defaultRates, source: "default" };
}
