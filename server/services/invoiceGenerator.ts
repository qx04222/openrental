/**
 * Invoice Generator Service
 * Creates invoices from rental requests with proper line items and tax compliance.
 */

import { TRPCError } from "@trpc/server";
import { getDb, eq, and, sql, asc, desc, isNull, isNotNull, inArray } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { isFeatureEnabled } from "./featureFlags";
import { computeLateFee, dailyBaseRateFromRental } from "./lateFee";
import { calculateTax } from "./taxCalculation";
import { calendarPartsInTimeZone, zonedTodayPlusDaysUtc } from "../_core/dateUtils";
import { calculateDaysBetween } from "./pricingCalculation";
import { CHARGE_TYPES } from "../../shared/creditOrders";
import { derivePaymentState, allocatePrepayments } from "../../shared/paymentStatus";
import { setRecomputedCreditEntry, overpaymentSourceKey } from "./customerCredit";
import { planExtraChargeReconciliation, rentalInvoiceSourceKey } from "./invoiceReconciliation";

interface GenerateInvoiceInput {
  rentalId: number;
  createdBy?: number;
  dueInDays?: number; // default 30
  gstHstNumber?: string;
  /**
   * Actual machine return date. The late-fee (overdue-RETURN) charge, when the
   * `late_fee_auto` flag is on, is computed against this date — NOT "now" — so the
   * fee reflects how long the machine was actually held past end date and stops
   * growing once returned. Omit only when the machine is genuinely still out.
   */
  actualReturnDate?: Date | null;
}

interface InvoiceResult {
  invoiceId: number;
  invoiceNumber: string;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Append only the accepted charges that are locked and represented by this
 * reconciliation pass. Invoice totals, line items, and the exact claim ids are
 * committed together; a concurrently-added claim remains unbilled for the next
 * pass instead of being stamped without a matching invoice line.
 */
export async function reconcileAcceptedChargesIntoInvoice(
  db: Db,
  input: { rentalId: number; invoiceId: number },
): Promise<{ claimedIds: number[]; totalAmount?: string }> {
  return db.transaction(async (tx) => {
    const [rental] = await tx
      .select({
        taxProvince: schema.rentalRequests.taxProvince,
        deliveryProvince: schema.rentalRequests.deliveryProvince,
      })
      .from(schema.rentalRequests)
      .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
      .limit(1);
    if (!rental) throw new Error(`Rental #${input.rentalId} not found`);

    const [invoice] = await tx
      .select({
        subtotal: schema.invoices.subtotal,
        taxAmount: schema.invoices.taxAmount,
        amountPaid: schema.invoices.amountPaid,
      })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, input.invoiceId), isNull(schema.invoices.deletedAt)))
      .limit(1)
      .for("update");
    if (!invoice) throw new Error(`Invoice #${input.invoiceId} not found`);

    const claims = await tx
      .select({
        id: schema.damageClaims.id,
        chargeType: schema.damageClaims.chargeType,
        description: schema.damageClaims.description,
        approvedAmount: schema.damageClaims.approvedAmount,
        amount: schema.damageClaims.amount,
        repairEstimate: schema.damageClaims.repairEstimate,
      })
      .from(schema.damageClaims)
      .where(and(
        eq(schema.damageClaims.rentalId, input.rentalId),
        eq(schema.damageClaims.status, "accepted"),
        isNull(schema.damageClaims.invoiceId),
        isNull(schema.damageClaims.deletedAt),
      ))
      .for("update");

    const preview = planExtraChargeReconciliation({
      claims,
      currentSubtotal: invoice.subtotal,
      currentTaxAmount: invoice.taxAmount,
      extraTaxAmount: 0,
    });
    if (!preview) return { claimedIds: [] };

    let extraTaxAmount = 0;
    try {
      extraTaxAmount = (await calculateTax({
        rentalAmount: Number.parseFloat(preview.extraSubtotal),
        shippingAmount: 0,
        ldwAmount: 0,
        depositAmount: 0,
        province: rental.taxProvince || rental.deliveryProvince || "ON",
      })).totalTax;
    } catch (error) {
      logger.warn("[InvoiceGenerator] Extra charge tax calculation failed", {
        rentalId: input.rentalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const plan = planExtraChargeReconciliation({
      claims,
      currentSubtotal: invoice.subtotal,
      currentTaxAmount: invoice.taxAmount,
      extraTaxAmount,
    });
    if (!plan) return { claimedIds: [] };

    await tx.insert(schema.invoiceLineItems).values(plan.lines.map((line) => ({
      ...line,
      invoiceId: input.invoiceId,
    })));

    const balanceDue = Math.max(0, Number.parseFloat(plan.newTotalAmount) - Number.parseFloat(invoice.amountPaid || "0"));
    await tx.update(schema.invoices).set({
      subtotal: plan.newSubtotal,
      taxAmount: plan.newTaxAmount,
      totalAmount: plan.newTotalAmount,
      balanceDue: balanceDue.toFixed(2),
      updatedAt: new Date(),
    }).where(eq(schema.invoices.id, input.invoiceId));

    await tx.update(schema.damageClaims).set({
      invoiceId: input.invoiceId,
      status: "invoiced",
      updatedAt: new Date(),
    }).where(and(
      inArray(schema.damageClaims.id, plan.claimIds),
      eq(schema.damageClaims.status, "accepted"),
      isNull(schema.damageClaims.invoiceId),
      isNull(schema.damageClaims.deletedAt),
    ));

    return { claimedIds: plan.claimIds, totalAmount: plan.newTotalAmount };
  });
}

/**
 * Generate next invoice number: INV-{YYYY}-{seq 4 digits}
 */
export async function getNextInvoiceNumber(): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const year = calendarPartsInTimeZone(new Date()).year;
  const prefix = `INV-${year}-`;

  const [last] = await db
    .select({ invoiceNumber: schema.invoices.invoiceNumber })
    .from(schema.invoices)
    .where(sql`${schema.invoices.invoiceNumber} LIKE ${prefix + '%'}`)
    .orderBy(desc(schema.invoices.invoiceNumber))
    .limit(1);

  let seq = 1;
  if (last?.invoiceNumber) {
    const parts = last.invoiceNumber.split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(4, "0")}`;
}

/**
 * Generate an invoice from a rental request.
 * Breaks down rental fee, freight, insurance, and tax into line items.
 */
export async function generateInvoiceFromRental(input: GenerateInvoiceInput): Promise<InvoiceResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Check for an existing RENTAL invoice to prevent duplicates. Must filter by
  // type: a rental can also carry fuel_surcharge / damage / delivery invoices,
  // and without this filter the first such invoice would satisfy the dedup and
  // the actual rental invoice (rent + freight + insurance + tax) would never be
  // generated — silently under-billing the customer.
  const [existing] = await db
    .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
    .from(schema.invoices)
    .where(and(
      eq(schema.invoices.rentalId, input.rentalId),
      eq(schema.invoices.type, "rental"),
      isNull(schema.invoices.deletedAt),
    ))
    .limit(1);

  if (existing) {
    logger.info("[InvoiceGenerator] Invoice already exists for rental", {
      rentalId: input.rentalId,
      invoiceId: existing.id,
    });
    await reconcileAcceptedChargesIntoInvoice(db, { rentalId: input.rentalId, invoiceId: existing.id });
    await recalculateInvoicesForRental(input.rentalId);
    return { invoiceId: existing.id, invoiceNumber: existing.invoiceNumber };
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

  // Per-equipment line items (multi-unit orders) so the invoice itemizes each
  // unit with its own dates + subtotal, like a proper invoice.
  const lineRows = await db
    .select({
      quantity: schema.rentalLineItems.quantity,
      lineSubtotal: schema.rentalLineItems.lineSubtotal,
      startDate: schema.rentalLineItems.startDate,
      endDate: schema.rentalLineItems.endDate,
      fbrand: schema.rentalFleet.brand,
      fmodel: schema.rentalFleet.model,
      mbrand: schema.equipmentModels.brand,
      mmodel: schema.equipmentModels.model,
    })
    .from(schema.rentalLineItems)
    .leftJoin(schema.rentalFleet, eq(schema.rentalLineItems.rentalFleetId, schema.rentalFleet.id))
    .leftJoin(schema.equipmentModels, eq(schema.rentalLineItems.equipmentModelId, schema.equipmentModels.id))
    .where(and(eq(schema.rentalLineItems.rentalRequestId, rental.id), isNull(schema.rentalLineItems.deletedAt)))
    .orderBy(schema.rentalLineItems.id);

  const invoiceNumber = await getNextInvoiceNumber();

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
  // Tracks the post-late-fee total so the closing log line and any future
  // consumer of this scope sees the same value the DB row holds.
  let finalTotalAmount = totalAmount;

  // Fetch GST/HST number from site settings if not provided
  let gstHstNumber = input.gstHstNumber;
  if (!gstHstNumber) {
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
  }

  const dueDate = zonedTodayPlusDaysUtc(input.dueInDays ?? 30);

  // Insert invoice
  const [invoice] = await db.insert(schema.invoices).values({
    invoiceNumber,
    sourceKey: rentalInvoiceSourceKey(rental.id),
    rentalId: rental.id,
    customerId: rental.customerId,
    projectId: rental.projectId ?? null,
    type: "rental",
    status: "draft",
    subtotal: subtotal.toFixed(2),
    taxAmount: taxAmount.toFixed(2),
    taxBreakdown: rental.taxBreakdown,
    totalAmount: totalAmount.toFixed(2),
    amountPaid: "0",
    balanceDue: totalAmount.toFixed(2),
    gstHstNumber,
    taxProvince: rental.taxProvince,
    issueDate: new Date(),
    dueDate,
    createdBy: input.createdBy,
  }).onConflictDoNothing({ target: schema.invoices.sourceKey }).returning();

  if (!invoice) {
    const [winner] = await db
      .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
      .from(schema.invoices)
      .where(eq(schema.invoices.sourceKey, rentalInvoiceSourceKey(rental.id)))
      .limit(1);
    if (!winner) throw new Error(`Concurrent invoice creation for rental #${rental.id} did not produce a readable invoice`);
    await reconcileAcceptedChargesIntoInvoice(db, { rentalId: rental.id, invoiceId: winner.id });
    await recalculateInvoicesForRental(rental.id);
    return { invoiceId: winner.id, invoiceNumber: winner.invoiceNumber };
  }

  // Build line items
  const lineItems: Array<{
    invoiceId: number;
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    lineType: string;
    sortOrder: number;
  }> = [];

  let sortOrder = 1;
  const discountPct = parseFloat(rental.customerDiscountPercent || "0");
  const discNote = discountPct > 0 ? ` (incl. ${discountPct}% customer discount)` : "";
  const fmtD = (d: Date) => {
    const p = calendarPartsInTimeZone(d);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  };
  // Itemize per equipment line when this is a real multi-unit order with stored
  // per-line subtotals. Skip when price-matched (the manual order total wouldn't
  // equal the sum of quote-based line subtotals).
  const itemizable = lineRows.filter((l) => l.lineSubtotal != null && parseFloat(l.lineSubtotal || "0") > 0);

  if (rentalFee > 0 && !rental.priceMatchEnabled && itemizable.length >= 2) {
    for (const l of itemizable) {
      const name = (l.mbrand && l.mmodel) ? `${l.mbrand} ${l.mmodel}`
        : (l.fbrand && l.fmodel) ? `${l.fbrand} ${l.fmodel}` : "Equipment";
      const ls = l.startDate ?? rental.startDate;
      const le = l.endDate ?? rental.endDate;
      const hasLineDates = !!(l.startDate && l.endDate);
      // Display only. Must use the same DST-safe calendar-day count as the
      // billed amount (calculateDaysBetween), or a rental crossing the November
      // fall-back prints "27 days" against a 26-day price.
      const days = calculateDaysBetween(ls, le);
      const period = hasLineDates ? `${fmtD(ls)}–${fmtD(le)}` : `${days} days`;
      const qty = l.quantity || 1;
      const amt = parseFloat(l.lineSubtotal!);
      lineItems.push({
        invoiceId: invoice.id,
        description: `Rental: ${name} (${period})${discNote}`,
        quantity: String(qty),
        unitPrice: (amt / qty).toFixed(2),
        amount: amt.toFixed(2),
        lineType: "rental",
        sortOrder: sortOrder++,
      });
    }
  } else if (rentalFee > 0) {
    const equipDesc = fleet ? `${fleet.brand} ${fleet.model}` : "Equipment";
    // Display only — DST-safe so the printed day count matches the billed one.
    const days = calculateDaysBetween(rental.startDate, rental.endDate);
    lineItems.push({
      invoiceId: invoice.id,
      description: `Rental: ${equipDesc} (${days} days)${discNote}`,
      quantity: "1",
      unitPrice: rentalFee.toFixed(2),
      amount: rentalFee.toFixed(2),
      lineType: "rental",
      sortOrder: sortOrder++,
    });
  }

  if (freightCost > 0) {
    lineItems.push({
      invoiceId: invoice.id,
      description: `Delivery/Shipping`,
      quantity: "1",
      unitPrice: freightCost.toFixed(2),
      amount: freightCost.toFixed(2),
      lineType: "shipping",
      sortOrder: sortOrder++,
    });
  }

  if (insuranceCost > 0) {
    const insType = rental.insuranceType === "full" ? "Full Coverage" : "Basic Coverage";
    lineItems.push({
      invoiceId: invoice.id,
      description: `Insurance: ${insType}`,
      quantity: "1",
      unitPrice: insuranceCost.toFixed(2),
      amount: insuranceCost.toFixed(2),
      lineType: "insurance",
      sortOrder: sortOrder++,
    });
  }

  // ── Late fee line item (feature-gated, additive) ──────────────────────
  if (await isFeatureEnabled("late_fee_auto")) {
    try {
      // Load late fee settings from rental_settings key-value table
      const settingsRows = await db
        .select()
        .from(schema.rentalSettings)
        .where(
          sql`${schema.rentalSettings.key} IN ('late_fee_daily_rate_pct', 'late_fee_grace_hours')`,
        );

      const settingsMap = Object.fromEntries(
        settingsRows.map((r) => [r.key, r.value]),
      );

      const lateSettings = {
        lateFeeDailyRatePct: parseFloat(
          settingsMap["late_fee_daily_rate_pct"] ?? "150",
        ),
        lateFeeGraceHours: parseInt(
          settingsMap["late_fee_grace_hours"] ?? "24",
          10,
        ),
      };

      const dailyBaseRate = dailyBaseRateFromRental({
        rentalFee: rental.rentalFee,
        startDate: rental.startDate,
        endDate: rental.endDate,
      });

      const { lateDays, lateFeeAmount } = computeLateFee({
        endDate: rental.endDate,
        // Use the real return date when known so the fee reflects the actual
        // overdue-return period and freezes at return — never "grows against now"
        // (which inflated invoices generated days/weeks after close).
        actualReturnDate: input.actualReturnDate ?? null,
        dailyBaseRate,
        settings: lateSettings,
      });

      if (lateFeeAmount > 0) {
        lineItems.push({
          invoiceId: invoice.id,
          description: `Late fee (${lateDays} day${lateDays !== 1 ? "s" : ""} overdue)`,
          quantity: "1",
          unitPrice: lateFeeAmount.toFixed(2),
          amount: lateFeeAmount.toFixed(2),
          lineType: "late_fee",
          sortOrder: 10,
        });

        // Update invoice totals to include late fee
        const newSubtotal = subtotal + lateFeeAmount;
        const newTotal = newSubtotal + taxAmount;
        await db.update(schema.invoices).set({
          subtotal: newSubtotal.toFixed(2),
          totalAmount: newTotal.toFixed(2),
          balanceDue: newTotal.toFixed(2),
          updatedAt: new Date(),
        }).where(eq(schema.invoices.id, invoice.id));

        // Reflect the new total in the closing log line so ops doesn't see
        // a misleading "totalAmount: 742.41" when the DB row is actually 14,602.41.
        finalTotalAmount = newTotal;

        logger.info("[InvoiceGenerator] Late fee line item added", {
          invoiceId: invoice.id,
          lateDays,
          lateFeeAmount,
          newTotal,
        });
      }
    } catch (err) {
      // Non-critical — log and continue
      logger.warn("[InvoiceGenerator] Late fee computation failed (non-critical)", {
        rentalId: input.rentalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // ── End late fee ───────────────────────────────────────────────────────

  if (lineItems.length > 0) {
    await db.insert(schema.invoiceLineItems).values(lineItems);
  }

  const reconciled = await reconcileAcceptedChargesIntoInvoice(db, { rentalId: rental.id, invoiceId: invoice.id });
  if (reconciled.totalAmount) finalTotalAmount = Number.parseFloat(reconciled.totalAmount);
  if (reconciled.claimedIds.length > 0) {
    logger.info("[InvoiceGenerator] Extra charges merged into invoice", {
      invoiceId: invoice.id,
      claimIds: reconciled.claimedIds,
    });
  }

  logger.info("[InvoiceGenerator] Invoice created", {
    invoiceId: invoice.id,
    invoiceNumber,
    rentalId: rental.id,
    totalAmount: finalTotalAmount,
  });

  // Absorb any prepayments already collected against this order (deposits taken
  // before the invoice existed) so the fresh invoice immediately reflects
  // 已付/部分 instead of being stuck at unpaid. The order's prepayment ledger is
  // the single source of truth; this allocates it across the order's invoices.
  await recalculateInvoicesForRental(rental.id);

  return { invoiceId: invoice.id, invoiceNumber };
}

/**
 * Generate a renewal supplement invoice.
 *
 * Unlike generateInvoiceFromRental (one-invoice-per-rental), this creates a
 * second invoice on the same rentalId representing the price delta when a
 * rental is extended. The original invoice is left untouched so already-paid
 * portions remain accurate.
 *
 * The supplement carries the new tax breakdown so closing reports can sum
 * across all invoices for a single rental and arrive at the correct total.
 */
interface RenewalSupplementInput {
  rentalId: number;
  sourceKey?: string;
  oldEndDate: Date;
  newEndDate: Date;
  oldRentalFee: number;
  newRentalFee: number;
  oldInsuranceCost: number;
  newInsuranceCost: number;
  oldTaxAmount: number;
  newTaxAmount: number;
  newTaxBreakdown: string | null;
  createdBy?: number;
  dueInDays?: number;
}

export async function generateRenewalSupplementInvoice(
  input: RenewalSupplementInput,
): Promise<InvoiceResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [rentalRow] = await db
    .select()
    .from(schema.rentalRequests)
    .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
    .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);

  if (!rentalRow) throw new Error(`Rental #${input.rentalId} not found`);

  const rental = rentalRow.rental_requests;
  const fleet = rentalRow.rental_fleet;

  const rentalFeeDelta = +(input.newRentalFee - input.oldRentalFee).toFixed(2);
  const insuranceDelta = +(input.newInsuranceCost - input.oldInsuranceCost).toFixed(2);
  const taxDelta = +(input.newTaxAmount - input.oldTaxAmount).toFixed(2);
  const subtotalDelta = +(rentalFeeDelta + insuranceDelta).toFixed(2);
  const totalDelta = +(subtotalDelta + taxDelta).toFixed(2);

  if (totalDelta <= 0) {
    throw new Error(
      `Renewal supplement is non-positive (${totalDelta}); refusing to create zero/credit invoice via this path`,
    );
  }

  // Display/log only — the money deltas are passed in already computed. DST-safe
  // so the "+N days" text agrees with the billed term.
  const extensionDays = calculateDaysBetween(input.oldEndDate, input.newEndDate);

  const invoiceNumber = await getNextInvoiceNumber();

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

  const dueDate = zonedTodayPlusDaysUtc(input.dueInDays ?? 30);

  const invoiceValues: typeof schema.invoices.$inferInsert = {
    invoiceNumber,
    sourceKey: input.sourceKey,
    rentalId: rental.id,
    customerId: rental.customerId,
    projectId: rental.projectId ?? null,
    type: "rental",
    status: "sent",
    subtotal: subtotalDelta.toFixed(2),
    taxAmount: taxDelta.toFixed(2),
    taxBreakdown: input.newTaxBreakdown,
    totalAmount: totalDelta.toFixed(2),
    amountPaid: "0",
    balanceDue: totalDelta.toFixed(2),
    gstHstNumber,
    taxProvince: rental.taxProvince,
    issueDate: new Date(),
    dueDate,
    notes: `Renewal supplement: extended ${extensionDays} day${extensionDays !== 1 ? "s" : ""} (${input.oldEndDate.toISOString().split("T")[0]} → ${input.newEndDate.toISOString().split("T")[0]})`,
    createdBy: input.createdBy,
  };
  const [invoice] = input.sourceKey
    ? await db.insert(schema.invoices).values(invoiceValues).onConflictDoNothing({ target: schema.invoices.sourceKey }).returning()
    : await db.insert(schema.invoices).values(invoiceValues).returning();

  if (!invoice && input.sourceKey) {
    const [winner] = await db
      .select({ id: schema.invoices.id, invoiceNumber: schema.invoices.invoiceNumber })
      .from(schema.invoices)
      .where(eq(schema.invoices.sourceKey, input.sourceKey))
      .limit(1);
    if (!winner) throw new Error(`Concurrent supplement creation for rental #${input.rentalId} did not produce a readable invoice`);
    await recalculateInvoicesForRental(input.rentalId);
    return { invoiceId: winner.id, invoiceNumber: winner.invoiceNumber };
  }

  const lineItems: Array<{
    invoiceId: number;
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    lineType: string;
    sortOrder: number;
  }> = [];

  const equipDesc = fleet ? `${fleet.brand} ${fleet.model}` : "Equipment";

  if (rentalFeeDelta > 0) {
    lineItems.push({
      invoiceId: invoice.id,
      description: `Renewal: ${equipDesc} (+${extensionDays} day${extensionDays !== 1 ? "s" : ""})`,
      quantity: "1",
      unitPrice: rentalFeeDelta.toFixed(2),
      amount: rentalFeeDelta.toFixed(2),
      lineType: "rental",
      sortOrder: 1,
    });
  }

  if (insuranceDelta > 0) {
    const insType = rental.insuranceType === "full" ? "Full Coverage" : "Basic Coverage";
    lineItems.push({
      invoiceId: invoice.id,
      description: `Insurance supplement: ${insType} (+${extensionDays} day${extensionDays !== 1 ? "s" : ""})`,
      quantity: "1",
      unitPrice: insuranceDelta.toFixed(2),
      amount: insuranceDelta.toFixed(2),
      lineType: "insurance",
      sortOrder: 2,
    });
  }

  if (lineItems.length > 0) {
    await db.insert(schema.invoiceLineItems).values(lineItems);
  }

  logger.info("[InvoiceGenerator] Renewal supplement invoice created", {
    invoiceId: invoice.id,
    invoiceNumber,
    rentalId: rental.id,
    extensionDays,
    totalDelta,
  });

  // Re-allocate the order's prepayment ledger across all its invoices so any
  // surplus already collected flows onto this new supplement automatically.
  await recalculateInvoicesForRental(rental.id);

  return { invoiceId: invoice.id, invoiceNumber };
}

/**
 * Recalculate an invoice's paid/balance/status.
 *
 * Single source of truth = the ORDER's prepayment ledger (rental_prepayments),
 * which is what 订单管理 reads and what the office actually records against. This
 * keeps the invoice's 已付/部分/已发送 always consistent with order management —
 * previously the invoice tracked the separate `payments` table, which the office
 * never used, so every invoice was stuck at "sent". For a standalone invoice with
 * no linked order (none today, but possible for credit/ad-hoc invoices) we fall
 * back to the invoice-level `payments` table.
 *
 * Statuses draft / cancelled / credited are lifecycle states owned elsewhere and
 * are left untouched. "overdue" is NOT stored here — it's derived at read time
 * from dueDate + balance (a payment-reminder, not a charge).
 */
/**
 * Write one invoice's paid/balance/status from a known applied-payment amount.
 *
 * Only payment-driven statuses are managed; lifecycle states (cancelled/credited)
 * are left alone. A DRAFT that has collected money is promoted (you don't take
 * payment on an un-issued draft). "overdue" is derived at read time, not stored.
 */
async function writeInvoicePaid(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  invoice: typeof schema.invoices.$inferSelect,
  totalPaid: number,
): Promise<void> {
  const totalAmount = parseFloat(invoice.totalAmount);
  const balanceDue = Math.max(0, totalAmount - totalPaid);

  const PAYMENT_DRIVEN = new Set(["sent", "partial", "paid", "overdue"]);
  const derived = derivePaymentState(totalAmount, totalPaid);
  let newStatus = invoice.status;
  if (PAYMENT_DRIVEN.has(invoice.status)) {
    newStatus = derived === "paid" ? "paid" : derived === "partial" ? "partial" : "sent";
  } else if (invoice.status === "draft" && totalPaid > 0.005) {
    newStatus = derived === "paid" ? "paid" : "partial";
  }

  await db.update(schema.invoices).set({
    amountPaid: totalPaid.toFixed(2),
    balanceDue: balanceDue.toFixed(2),
    status: newStatus,
    paidDate: newStatus === "paid" ? (invoice.paidDate ?? new Date()) : null,
    updatedAt: new Date(),
  }).where(eq(schema.invoices.id, invoice.id));

}

export async function recalculateInvoicePayments(invoiceId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
    .limit(1);

  if (!invoice) return;

  // Order-linked → the order ledger may back SEVERAL invoices (credit monthly
  // billing, renewal supplements). Recompute the whole order so the shared ledger
  // is allocated across them instead of double-counted onto each.
  if (invoice.rentalId) {
    await recalculateInvoicesForRental(invoice.rentalId);
    return;
  }

  // Standalone invoice → invoice-level payments table. Unreached in production
  // so far (every invoice has a rentalId), which is why that table is empty —
  // see the warning on `payments` in drizzle/schema.ts.
  const [row] = await db
    .select({ paid: sql<string>`coalesce(sum(${schema.payments.amount}::numeric), 0)` })
    .from(schema.payments)
    .where(eq(schema.payments.invoiceId, invoiceId));
  await writeInvoicePaid(db, invoice, parseFloat(row?.paid || "0"));
}

/**
 * Recompute every (non-deleted) invoice attached to an order, ALLOCATING the
 * order's single prepayment ledger across them (oldest-first, tagged payments
 * honoured) so a payment for one invoice never marks the others paid. Call this
 * whenever the order's prepayment ledger changes so the invoice view stays in
 * lock-step with 订单管理.
 */
export async function recalculateInvoicesForRental(rentalId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Oldest-first so FIFO allocation is deterministic (matches issue order).
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.rentalId, rentalId), isNull(schema.invoices.deletedAt)))
    .orderBy(asc(schema.invoices.createdAt), asc(schema.invoices.id));
  if (invoices.length === 0) return;

  // Only APPLIED (转租金) prepayments settle invoices. A held prepayment is money
  // received but not yet converted to rent, so it must not reduce the balance due
  // until staff explicitly convert it. (migration 132)
  const prepays = await db
    .select({ amount: schema.rentalPrepayments.amount, invoiceId: schema.rentalPrepayments.invoiceId })
    .from(schema.rentalPrepayments)
    .where(and(
      eq(schema.rentalPrepayments.rentalRequestId, rentalId),
      isNull(schema.rentalPrepayments.deletedAt),
      isNotNull(schema.rentalPrepayments.appliedAt),
    ));

  const { allocations, leftover } = allocatePrepayments(
    invoices.map((i) => ({ id: i.id, total: parseFloat(i.totalAmount) })),
    prepays.map((p) => ({ amount: parseFloat(p.amount), invoiceId: p.invoiceId })),
  );

  for (const inv of invoices) {
    await writeInvoicePaid(db, inv, allocations.get(inv.id) ?? 0);
  }

  // Anything the invoices could not absorb is the customer's money, not the
  // newest invoice's. Recomputed on every pass rather than appended, so running
  // this twice does not double the balance — see setRecomputedCreditEntry.
  const customerId = invoices.find((i) => i.customerId != null)?.customerId;
  if (customerId != null) {
    await setRecomputedCreditEntry(db, {
      sourceKey: overpaymentSourceKey(rentalId),
      customerId,
      amount: leftover,
      entryType: "overpayment",
      rentalRequestId: rentalId,
      notes: "Paid beyond this order's invoices",
    });
  }
}

const CHARGE_LABELS: Record<(typeof CHARGE_TYPES)[number], string> = {
  swap: "Equipment exchange",
  final: "Final settlement",
  adjustment: "Adjustment",
};

/**
 * Generate an invoice from a credit (挂账) order's unbilled charges.
 *
 * Sums every not-yet-billed, non-deleted rental_charges row for the rental into
 * one draft invoice (type 'rental'), one line item per non-zero charge, and
 * stamps invoiceId onto ALL fetched rows in the same transaction (zero-fee swap
 * rows get no line item but are still marked settled). Tax follows the rental's
 * province; the deposit NEVER enters here (project billing rule).
 *
 * Unlike generateInvoiceFromRental this does NOT dedupe by rental — a credit
 * order legitimately produces multiple rental-type invoices over its life
 * (precedent: generateRenewalSupplementInvoice).
 *
 * Throws PRECONDITION_FAILED when there is nothing billable (no unbilled rows,
 * or the unbilled total is ≤ 0).
 */
export async function generateInvoiceFromCharges(input: GenerateInvoiceInput): Promise<InvoiceResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [rental] = await db
    .select()
    .from(schema.rentalRequests)
    .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);
  if (!rental) throw new Error(`Rental #${input.rentalId} not found`);

  const charges = await db
    .select()
    .from(schema.rentalCharges)
    .where(and(
      eq(schema.rentalCharges.rentalRequestId, input.rentalId),
      isNull(schema.rentalCharges.invoiceId),
      isNull(schema.rentalCharges.deletedAt),
    ))
    .orderBy(schema.rentalCharges.chargeDate);

  if (charges.length === 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No unbilled charges to invoice" });
  }

  const subtotal = Math.round(charges.reduce((s, c) => s + parseFloat(c.amount || "0"), 0) * 100) / 100;
  if (subtotal <= 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Unbilled charge total is zero — nothing to invoice" });
  }

  // Tax follows the rental's province (deposit excluded, like createManual).
  let taxAmount = 0;
  let taxBreakdown: string | null = null;
  if (rental.taxProvince) {
    try {
      const taxResult = await calculateTax({
        rentalAmount: subtotal,
        shippingAmount: 0,
        ldwAmount: 0,
        depositAmount: 0,
        province: rental.taxProvince,
      });
      taxAmount = taxResult.totalTax;
      taxBreakdown = taxResult.taxBreakdown;
    } catch (err) {
      logger.warn("[InvoiceGenerator] Charge tax calc failed, using 0", { rentalId: input.rentalId, error: err });
    }
  }
  const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

  let gstHstNumber: string | undefined;
  try {
    const [setting] = await db
      .select()
      .from(schema.siteSettings)
      .where(eq(schema.siteSettings.key, "gstHstNumber"))
      .limit(1);
    gstHstNumber = setting?.value || undefined;
  } catch { /* ignore */ }

  const invoiceNumber = await getNextInvoiceNumber();
  const dueDate = zonedTodayPlusDaysUtc(input.dueInDays ?? 30);

  const result = await db.transaction(async (tx) => {
    const [invoice] = await tx.insert(schema.invoices).values({
      invoiceNumber,
      rentalId: rental.id,
      customerId: rental.customerId,
      projectId: rental.projectId ?? null,
      type: "rental",
      status: "draft",
      subtotal: subtotal.toFixed(2),
      taxAmount: taxAmount.toFixed(2),
      taxBreakdown,
      totalAmount: totalAmount.toFixed(2),
      amountPaid: "0",
      balanceDue: totalAmount.toFixed(2),
      gstHstNumber,
      taxProvince: rental.taxProvince,
      issueDate: new Date(),
      dueDate,
      createdBy: input.createdBy,
    }).returning();

    const lineItems = charges
      .filter((c) => parseFloat(c.amount || "0") !== 0)
      .map((c, idx) => {
        const amount = parseFloat(c.amount || "0");
        const label = CHARGE_LABELS[c.chargeType as (typeof CHARGE_TYPES)[number]] ?? "Charge";
        return {
          invoiceId: invoice.id,
          description: c.description ? `${label}: ${c.description}` : label,
          quantity: "1",
          unitPrice: amount.toFixed(2),
          amount: amount.toFixed(2),
          lineType: "rental",
          sortOrder: idx + 1,
        };
      });
    if (lineItems.length > 0) {
      await tx.insert(schema.invoiceLineItems).values(lineItems);
    }

    // Stamp ALL fetched charges as billed (incl. zero-fee swap rows).
    await tx
      .update(schema.rentalCharges)
      .set({ invoiceId: invoice.id, updatedAt: new Date() })
      .where(and(
        eq(schema.rentalCharges.rentalRequestId, rental.id),
        isNull(schema.rentalCharges.invoiceId),
        isNull(schema.rentalCharges.deletedAt),
      ));

    return invoice;
  });

  logger.info("[InvoiceGenerator] Charge invoice created", {
    invoiceId: result.id,
    invoiceNumber,
    rentalId: rental.id,
    subtotal,
    totalAmount,
    chargeCount: charges.length,
  });

  // After the invoice is committed, re-allocate the order's prepayment ledger
  // across all its invoices so any surplus already collected applies here too.
  await recalculateInvoicesForRental(rental.id);

  return { invoiceId: result.id, invoiceNumber };
}
