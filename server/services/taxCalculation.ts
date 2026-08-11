/**
 * Canada Province-Based Tax Calculation
 *
 * Tax Location Rule:
 * - Delivery orders: tax based on DELIVERY location province
 * - Pickup orders: tax based on PICKUP location province
 *
 * Tax Base:
 * - Taxable: rental + shipping + LDW
 * - NOT taxable: deposit
 *
 * Tax Logic:
 * - If hstRate exists → use HST only
 * - Else → GST + PST
 */

import { getDb, sql } from "../db";
import { logger } from "../_core/logger";

export interface TaxRate {
  province: string;
  provinceName: string;
  gstRate: number;
  pstRate: number;
  hstRate: number;
  isActive: boolean;
}

export interface TaxCalculationInput {
  rentalAmount: number;
  shippingAmount: number;
  ldwAmount: number;
  depositAmount: number;
  province: string;
}

export interface TaxCalculationResult {
  taxBase: number;
  gstAmount: number;
  pstAmount: number;
  hstAmount: number;
  totalTax: number;
  taxRate: number;
  province: string;
  provinceName: string;
  taxBreakdown: string;
}

export async function getTaxRateByProvince(province: string): Promise<TaxRate | null> {
  const db = await getDb();
  if (!db) {
    logger.error("[TaxCalculation] Database not available");
    return null;
  }

  try {
    const sanitizedProvince = province.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);

    interface TaxRateRow {
      province: string;
      provinceName: string;
      gstRate: string | number;
      pstRate: string | number;
      hstRate: string | number;
      isActive: boolean;
    }

    const result = (await db.execute(sql`
      SELECT province, "provinceName", "gstRate", "pstRate", "hstRate", "isActive"
      FROM tax_rates
      WHERE province = ${sanitizedProvince} AND "isActive" = true
      LIMIT 1
    `)) as unknown as TaxRateRow[];

    if (!result || result.length === 0) {
      logger.warn("[TaxCalculation] No tax rate found for province", { province });
      return null;
    }

    const row = result[0];
    return {
      province: row.province,
      provinceName: row.provinceName,
      gstRate: parseFloat(String(row.gstRate) || "0"),
      pstRate: parseFloat(String(row.pstRate) || "0"),
      hstRate: parseFloat(String(row.hstRate) || "0"),
      isActive: row.isActive === true,
    };
  } catch (error) {
    logger.error("[TaxCalculation] Error fetching tax rate", {
      province,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function calculateTax(input: TaxCalculationInput): Promise<TaxCalculationResult> {
  const { rentalAmount, shippingAmount, ldwAmount, province } = input;

  const taxBase = rentalAmount + shippingAmount + ldwAmount;
  const taxRate = await getTaxRateByProvince(province);

  if (!taxRate) {
    // Fallback to Ontario HST 13% for unknown provinces (Canadian business default)
    logger.warn("[TaxCalculation] Province not found, applying Ontario HST 13% fallback", { province });
    const fallbackRate = 0.13;
    const fallbackTax = Math.round(taxBase * fallbackRate * 100) / 100;
    return {
      taxBase: Math.round(taxBase * 100) / 100,
      gstAmount: 0,
      pstAmount: 0,
      hstAmount: fallbackTax,
      totalTax: fallbackTax,
      taxRate: fallbackRate,
      province: province.toUpperCase(),
      provinceName: "Unknown (ON fallback)",
      taxBreakdown: "HST 13.00% (default)",
    };
  }

  let gstAmount = 0;
  let pstAmount = 0;
  let hstAmount = 0;
  let totalTax = 0;
  let taxBreakdown = "";
  let combinedRate = 0;

  if (taxRate.hstRate > 0) {
    hstAmount = taxBase * taxRate.hstRate;
    totalTax = hstAmount;
    combinedRate = taxRate.hstRate;
    taxBreakdown = `HST ${(taxRate.hstRate * 100).toFixed(2)}%`;
  } else {
    gstAmount = taxBase * taxRate.gstRate;
    pstAmount = taxBase * taxRate.pstRate;
    totalTax = gstAmount + pstAmount;
    combinedRate = taxRate.gstRate + taxRate.pstRate;

    if (taxRate.gstRate > 0 && taxRate.pstRate > 0) {
      taxBreakdown = `GST ${(taxRate.gstRate * 100).toFixed(2)}% + PST ${(taxRate.pstRate * 100).toFixed(2)}%`;
    } else if (taxRate.gstRate > 0) {
      taxBreakdown = `GST ${(taxRate.gstRate * 100).toFixed(2)}%`;
    } else if (taxRate.pstRate > 0) {
      taxBreakdown = `PST ${(taxRate.pstRate * 100).toFixed(2)}%`;
    } else {
      taxBreakdown = "No tax";
    }
  }

  return {
    taxBase: Math.round(taxBase * 100) / 100,
    gstAmount: Math.round(gstAmount * 100) / 100,
    pstAmount: Math.round(pstAmount * 100) / 100,
    hstAmount: Math.round(hstAmount * 100) / 100,
    totalTax: Math.round(totalTax * 100) / 100,
    taxRate: combinedRate,
    province: taxRate.province,
    provinceName: taxRate.provinceName,
    taxBreakdown,
  };
}

export async function getAllTaxRates(): Promise<TaxRate[]> {
  const db = await getDb();
  if (!db) {
    logger.error("[TaxCalculation] Database not available");
    return [];
  }

  try {
    interface TaxRateRowAll {
      province: string;
      provinceName: string;
      gstRate: string | number;
      pstRate: string | number;
      hstRate: string | number;
      isActive: boolean;
    }

    const result = (await db.execute(sql`
      SELECT province, "provinceName", "gstRate", "pstRate", "hstRate", "isActive"
      FROM tax_rates
      WHERE "isActive" = true
      ORDER BY province
    `)) as unknown as TaxRateRowAll[];

    if (!result) return [];

    return result.map((row: TaxRateRowAll) => ({
      province: row.province,
      provinceName: row.provinceName,
      gstRate: parseFloat(String(row.gstRate) || "0"),
      pstRate: parseFloat(String(row.pstRate) || "0"),
      hstRate: parseFloat(String(row.hstRate) || "0"),
      isActive: row.isActive === true,
    }));
  } catch (error) {
    logger.error("[TaxCalculation] Error fetching all tax rates", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
