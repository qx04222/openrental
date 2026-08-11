/**
 * Quotation Generator Service
 * Creates quotations from rental requests with proper line items and tax.
 */

import { getDb, eq, and, sql, desc, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { calendarPartsInTimeZone, zonedTodayPlusDaysUtc } from "../_core/dateUtils";
import { calculateDaysBetween } from "./pricingCalculation";
import { logger } from "../_core/logger";

interface GenerateQuotationInput {
  rentalId: number;
  createdBy?: number;
  validDays?: number; // default 30
}

interface QuotationResult {
  quotationId: number;
  quotationNumber: string;
}

async function getNextQuotationNumber(): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const year = calendarPartsInTimeZone(new Date()).year;
  const prefix = `QT-${year}-`;

  const [last] = await db
    .select({ quotationNumber: schema.quotations.quotationNumber })
    .from(schema.quotations)
    .where(sql`${schema.quotations.quotationNumber} LIKE ${prefix + '%'}`)
    .orderBy(desc(schema.quotations.quotationNumber))
    .limit(1);

  let seq = 1;
  if (last?.quotationNumber) {
    const parts = last.quotationNumber.split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(4, "0")}`;
}

export async function generateQuotationFromRental(input: GenerateQuotationInput): Promise<QuotationResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check for existing quotation to prevent duplicates
  const [existing] = await db
    .select({ id: schema.quotations.id, quotationNumber: schema.quotations.quotationNumber })
    .from(schema.quotations)
    .where(and(eq(schema.quotations.rentalId, input.rentalId), isNull(schema.quotations.deletedAt)))
    .limit(1);

  if (existing) {
    logger.info("[QuotationGenerator] Quotation already exists for rental", {
      rentalId: input.rentalId,
      quotationId: existing.id,
    });
    return { quotationId: existing.id, quotationNumber: existing.quotationNumber };
  }

  // Fetch rental with fleet info
  const [rentalRow] = await db
    .select()
    .from(schema.rentalRequests)
    .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
    .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);

  if (!rentalRow) throw new Error(`Rental #${input.rentalId} not found`);

  const rental = rentalRow.rental_requests;
  const fleet = rentalRow.rental_fleet;

  const quotationNumber = await getNextQuotationNumber();

  const rentalFee = parseFloat(rental.rentalFee || "0");
  const freightCost = parseFloat(rental.freightCost || "0");
  const insuranceCost = parseFloat(rental.insuranceCost || "0");
  const taxAmount = parseFloat(rental.taxAmount || "0");
  // The order charged tax on the pre-tax subtotal ROUNDED UP to the dollar
  // (the office sheet's 应收费用(税前) rule, see multiItemPricing). Rebuilding the
  // subtotal without that round-up while carrying the order's tax across gives a
  // total that is a few cents under the order's every time the raw sum is not
  // already whole — a deterministic mismatch, not a rounding wobble.
  const subtotal = Math.ceil(rentalFee + freightCost + insuranceCost);
  const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

  // Fetch GST/HST number from site settings
  let gstHstNumber: string | undefined;
  try {
    const [setting] = await db
      .select()
      .from(schema.siteSettings)
      .where(eq(schema.siteSettings.key, "gstHstNumber"))
      .limit(1);
    gstHstNumber = setting?.value || undefined;
  } catch {
    // ignore
  }

  const validUntil = zonedTodayPlusDaysUtc(input.validDays ?? 30);

  // Insert quotation
  const [quotation] = await db.insert(schema.quotations).values({
    quotationNumber,
    rentalId: rental.id,
    customerId: rental.customerId,
    projectId: rental.projectId ?? null,
    status: "draft",
    subtotal: subtotal.toFixed(2),
    taxAmount: taxAmount.toFixed(2),
    taxBreakdown: rental.taxBreakdown,
    totalAmount: totalAmount.toFixed(2),
    gstHstNumber,
    taxProvince: rental.taxProvince,
    issueDate: new Date(),
    validUntil,
    createdBy: input.createdBy,
  }).returning();

  // Build line items
  const lineItems: Array<{
    quotationId: number;
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    lineType: string;
    sortOrder: number;
  }> = [];

  if (rentalFee > 0) {
    const equipDesc = fleet ? `${fleet.brand} ${fleet.model}` : "Equipment";
    // Display only — DST-safe so the quoted day count matches the priced term.
    const days = calculateDaysBetween(rental.startDate, rental.endDate);
    lineItems.push({
      quotationId: quotation.id,
      description: `Rental: ${equipDesc} (${days} days)`,
      quantity: "1",
      unitPrice: rentalFee.toFixed(2),
      amount: rentalFee.toFixed(2),
      lineType: "rental",
      sortOrder: 1,
    });
  }

  if (freightCost > 0) {
    lineItems.push({
      quotationId: quotation.id,
      description: `Delivery/Shipping`,
      quantity: "1",
      unitPrice: freightCost.toFixed(2),
      amount: freightCost.toFixed(2),
      lineType: "shipping",
      sortOrder: 2,
    });
  }

  if (insuranceCost > 0) {
    const insType = rental.insuranceType === "full" ? "Full Coverage" : "Basic Coverage";
    lineItems.push({
      quotationId: quotation.id,
      description: `Insurance: ${insType}`,
      quantity: "1",
      unitPrice: insuranceCost.toFixed(2),
      amount: insuranceCost.toFixed(2),
      lineType: "insurance",
      sortOrder: 3,
    });
  }

  if (lineItems.length > 0) {
    await db.insert(schema.quotationLineItems).values(lineItems);
  }

  logger.info("[QuotationGenerator] Quotation created", {
    quotationId: quotation.id,
    quotationNumber,
    rentalId: rental.id,
    totalAmount,
  });

  return { quotationId: quotation.id, quotationNumber };
}
