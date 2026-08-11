import { isNull } from "drizzle-orm";
import type { getDb } from "../db";
import * as schema from "../../drizzle/schema";

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type FinancialReadDb = Pick<AppDb, "select">;

type RentalMoneyRow = { status: string; rentalFee: string | number | null };
type InvoiceMoneyRow = {
  status: string;
  type: string;
  totalAmount: string | number | null;
  balanceDue: string | number | null;
};
type PrepaymentMoneyRow = { amount: string | number; appliedAt: Date | null };

const issuedInvoiceStatuses = new Set(["sent", "paid", "partial", "overdue"]);
const rentStatuses = new Set(["active", "overdue", "completed"]);

function money(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cents(value: number) {
  return Math.round(value * 100) / 100;
}

function signedInvoiceAmount(type: string, value: string | number | null) {
  const amount = Math.abs(money(value));
  return type === "credit_note" ? -amount : amount;
}

export function deriveDashboardFinancials(input: {
  rentals: RentalMoneyRow[];
  invoices: InvoiceMoneyRow[];
  prepayments: PrepaymentMoneyRow[];
}) {
  const issuedInvoices = input.invoices.filter((invoice) => issuedInvoiceStatuses.has(invoice.status));
  return {
    orderRent: cents(input.rentals.reduce((sum, rental) => (
      rentStatuses.has(rental.status) ? sum + money(rental.rentalFee) : sum
    ), 0)),
    cumulativeReceivable: cents(issuedInvoices.reduce((sum, invoice) => (
      sum + signedInvoiceAmount(invoice.type, invoice.totalAmount)
    ), 0)),
    outstandingBalance: cents(issuedInvoices.reduce((sum, invoice) => (
      sum + signedInvoiceAmount(invoice.type, invoice.balanceDue)
    ), 0)),
    cashReceived: cents(input.prepayments.reduce((sum, payment) => sum + money(payment.amount), 0)),
    heldCash: cents(input.prepayments.reduce((sum, payment) => (
      payment.appliedAt == null ? sum + money(payment.amount) : sum
    ), 0)),
  };
}

export function deriveInvoiceAllocation(
  totalAmount: string | number | null,
  amountPaid: string | number | null,
) {
  const total = Math.max(0, money(totalAmount));
  const paid = Math.max(0, money(amountPaid));
  return {
    invoiceAllocated: cents(Math.min(total, paid)),
    orderCreditBalance: cents(Math.max(paid - total, 0)),
  };
}

export async function getDashboardFinancials(db: FinancialReadDb) {
  const [rentals, invoices, prepayments] = await Promise.all([
    db.select({
      status: schema.rentalRequests.status,
      rentalFee: schema.rentalRequests.rentalFee,
    }).from(schema.rentalRequests).where(isNull(schema.rentalRequests.deletedAt)),
    db.select({
      status: schema.invoices.status,
      type: schema.invoices.type,
      totalAmount: schema.invoices.totalAmount,
      balanceDue: schema.invoices.balanceDue,
    }).from(schema.invoices).where(isNull(schema.invoices.deletedAt)),
    db.select({
      amount: schema.rentalPrepayments.amount,
      appliedAt: schema.rentalPrepayments.appliedAt,
    }).from(schema.rentalPrepayments).where(isNull(schema.rentalPrepayments.deletedAt)),
  ]);
  return deriveDashboardFinancials({ rentals, invoices, prepayments });
}
