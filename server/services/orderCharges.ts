/**
 * Order-level "amount owed" — the single source of truth for what a customer
 * actually owes on a rental order, INCLUDING extra charges.
 *
 * Why this exists: `rental_requests.totalAmount` is fixed at order creation as
 * rent + freight + insurance + tax and is NEVER updated when an extra charge
 * (fuel/damage/cleaning/…) is added. Extra charges live in `damage_claims` and
 * are only folded into the customer's bill at invoice time (invoiceGenerator
 * merges accepted charges into the invoice + taxes them by province). So any
 * order-level money math that reads `totalAmount` alone (balance, refund) was
 * silently dropping accepted/invoiced extra charges — e.g. refunding the full
 * prepayment minus only the base rent, over-refunding by the gas fee.
 *
 * This helper recomputes the extras (and their tax, matching invoiceGenerator's
 * calculateTax call exactly) from the source tables, so balance/refund tie out
 * to what was actually billed. We compute from `damage_claims` primitives (not
 * from invoices) so it's correct whether or not an invoice exists yet, and it
 * can never double-count: base `totalAmount` never contains extras.
 */
import { getDb, eq, and, inArray, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { calculateTax } from "./taxCalculation";

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface OrderExtraCharges {
  /** Pre-tax sum of this order's real extra charges. */
  subtotal: number;
  /** Tax on the extras (same province calc as the invoice). */
  tax: number;
  /** subtotal + tax — what the extras add to the customer's bill. */
  total: number;
}

/**
 * Sum the order's "real" extra charges (status accepted = billed-pending, or
 * invoiced = already on an invoice) and their tax. Mirrors the amount selection
 * and tax treatment in invoiceGenerator's extra-charge merge so the numbers tie.
 */
export async function getOrderExtraCharges(rentalId: number): Promise<OrderExtraCharges> {
  const db = await getDb();
  if (!db) return { subtotal: 0, tax: 0, total: 0 };

  const [order] = await db
    .select({
      taxProvince: schema.rentalRequests.taxProvince,
      deliveryProvince: schema.rentalRequests.deliveryProvince,
    })
    .from(schema.rentalRequests)
    .where(eq(schema.rentalRequests.id, rentalId))
    .limit(1);

  const rows = await db
    .select({
      approvedAmount: schema.damageClaims.approvedAmount,
      amount: schema.damageClaims.amount,
      repairEstimate: schema.damageClaims.repairEstimate,
    })
    .from(schema.damageClaims)
    .where(and(
      eq(schema.damageClaims.rentalId, rentalId),
      // accepted = approved & ready/awaiting invoice; invoiced = already billed.
      // pending/estimated/disputed are NOT yet owed and are excluded.
      inArray(schema.damageClaims.status, ["accepted", "invoiced"]),
      // A deleted charge must stop being money — without this the order would
      // still show it as owed after the user removed it.
      isNull(schema.damageClaims.deletedAt),
    ));

  const subtotal = round2(
    rows.reduce((s, r) => {
      const amt = parseFloat(r.approvedAmount || r.amount || r.repairEstimate || "0");
      return amt > 0 ? s + amt : s;
    }, 0),
  );

  // Tax the extras at the order's province. taxProvince was historically left
  // null on many orders (the base tax was frozen separately), which silently
  // zeroed the extra-charge tax here, under-deducting refunds. Fall back to the
  // delivery province, else ON — never silently drop the tax.
  const province = order?.taxProvince || order?.deliveryProvince || "ON";
  let tax = 0;
  if (subtotal > 0) {
    try {
      tax = (await calculateTax({
        rentalAmount: subtotal,
        shippingAmount: 0,
        ldwAmount: 0,
        depositAmount: 0,
        province,
      })).totalTax;
    } catch {
      /* tax best-effort — mirrors invoiceGenerator */
    }
  }

  return { subtotal, tax, total: round2(subtotal + tax) };
}

/**
 * The authoritative amount the customer owes on this order:
 * base totalAmount (rent + freight + insurance + tax) + extra charges (+ their
 * tax). Use this — never bare `totalAmount` — for balance and refund math.
 */
export async function getOrderAmountOwed(rentalId: number, baseTotalAmount: number): Promise<number> {
  const extras = await getOrderExtraCharges(rentalId);
  return round2(baseTotalAmount + extras.total);
}
