/**
 * Rental reminder cron — runs daily at 09:00 the configured timezone.
 *
 * Three reminder windows:
 *
 *   Day −1 of endDate, status=active   → "Your rental ends tomorrow"
 *   Day +1 after endDate, still active → "Your rental was due yesterday"
 *   Invoice 7 days unpaid              → "Invoice is 7 days overdue"
 *
 * Each reminder kind fires at most once per rental/invoice. The guard is the
 * `reminder_deliveries` table, which is written ONLY when the provider actually
 * accepted the message.
 *
 * This used to be an audit_logs row written straight after the send call —
 * but sendBusinessSMS returns silently when the SMS channel is globally
 * disabled, so the marker was stamped for messages that never left the
 * building, and the reminder was then suppressed for that rental forever.
 * 95 reminders were burned that way between 2026-07-02 and 08-09. Never
 * record intent; record delivery.
 */
import { getDb, eq, and, isNull, sql } from "../db";
import { gte, lte } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { zonedDayRangeUtc } from "../_core/dateUtils";

type ReminderEntity = "rental" | "invoice";

async function alreadyDelivered(entityType: ReminderEntity, entityId: number, kind: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return true;
  const [row] = await db
    .select({ id: schema.reminderDeliveries.id })
    .from(schema.reminderDeliveries)
    .where(and(
      eq(schema.reminderDeliveries.entityType, entityType),
      eq(schema.reminderDeliveries.entityId, entityId),
      eq(schema.reminderDeliveries.kind, kind),
    ))
    .limit(1);
  return !!row;
}

/**
 * Called only on a confirmed delivery. The unique index makes a concurrent
 * second cron run a no-op rather than a duplicate message.
 */
async function recordDelivered(
  entityType: ReminderEntity,
  entityId: number,
  kind: string,
  recipient: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(schema.reminderDeliveries)
    .values({ entityType, entityId, kind, channel: "sms", recipient })
    .onConflictDoNothing();
}

export async function runRentalReminderCron(now: Date = new Date()): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Day windows are Toronto calendar days (not the UTC container's), so a
  // 09:00-Toronto run always targets the right local "tomorrow"/"yesterday".
  const { startUtc: startOfTomorrow, endUtc: endOfTomorrow } = zonedDayRangeUtc(now, 1);
  const { startUtc: startOfYesterday, endUtc: endOfYesterday } = zonedDayRangeUtc(now, -1);

  let endingNotified = 0;
  let overdueNotified = 0;
  // Messages the channel refused (globally disabled) or the provider dropped.
  // Counted, logged, and deliberately NOT marked as reminded — those customers
  // stay on the collections list for a human to call.
  let skipped = 0;
  let invoiceNotified = 0;

  // ── 1. "Your rental ends tomorrow" ────────────────────────────
  try {
    const dueTomorrow = await db
      .select()
      .from(schema.rentalRequests)
      .where(and(
        isNull(schema.rentalRequests.deletedAt),
        eq(schema.rentalRequests.status, "active"),
        gte(schema.rentalRequests.endDate, startOfTomorrow),
        lte(schema.rentalRequests.endDate, endOfTomorrow),
      ));

    const { sendBusinessSMS } = await import("../services/smsNotify");
    for (const r of dueTomorrow) {
      if (!r.customerPhone) continue;
      if (await alreadyDelivered("rental", r.id, "reminder_ending_soon")) continue;
      const ref = r.rentalNumber || `#${r.id}`;
      try {
        const result = await sendBusinessSMS(r.customerPhone, `OpenRental: Reminder — your rental ${ref} ends tomorrow. Reply or call us to extend.`);
        if (!result.delivered) { skipped++; continue; }
        await recordDelivered("rental", r.id, "reminder_ending_soon", r.customerPhone);
        endingNotified++;
      } catch { /* swallow per-row */ }
    }
  } catch (err) {
    logger.warn("[ReminderCron] ending-soon block failed", { error: err instanceof Error ? err.message : String(err) });
  }

  // ── 2. "You're 1 day late" ────────────────────────────────────
  try {
    const overdue = await db
      .select()
      .from(schema.rentalRequests)
      .where(and(
        isNull(schema.rentalRequests.deletedAt),
        eq(schema.rentalRequests.status, "active"),
        gte(schema.rentalRequests.endDate, startOfYesterday),
        lte(schema.rentalRequests.endDate, endOfYesterday),
      ));

    const { sendBusinessSMS } = await import("../services/smsNotify");
    for (const r of overdue) {
      if (!r.customerPhone) continue;
      if (await alreadyDelivered("rental", r.id, "reminder_first_overdue")) continue;
      const ref = r.rentalNumber || `#${r.id}`;
      try {
        const result = await sendBusinessSMS(r.customerPhone, `OpenRental: Your rental ${ref} was due yesterday. Late fees may apply — please return ASAP or call to extend.`);
        if (!result.delivered) { skipped++; continue; }
        await recordDelivered("rental", r.id, "reminder_first_overdue", r.customerPhone);
        overdueNotified++;
      } catch { /* swallow */ }
    }
  } catch (err) {
    logger.warn("[ReminderCron] overdue block failed", { error: err instanceof Error ? err.message : String(err) });
  }

  // ── 3. Invoice 7 days unpaid ──────────────────────────────────
  try {
    // The Toronto calendar day 7 days ago (issueDate is a Toronto calendar date).
    const { startUtc: startOf7, endUtc: endOf7 } = zonedDayRangeUtc(now, -7);

    const overdueInvoices = await db
      .select({
        invoice: schema.invoices,
        customerPhone: schema.customers.phone,
      })
      .from(schema.invoices)
      .leftJoin(schema.customers, and(eq(schema.invoices.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
      .where(and(
        isNull(schema.invoices.deletedAt),
        sql`${schema.invoices.status} IN ('sent', 'overdue', 'partial')`,
        gte(schema.invoices.issueDate, startOf7),
        lte(schema.invoices.issueDate, endOf7),
      ));

    const { sendBusinessSMS } = await import("../services/smsNotify");
    for (const row of overdueInvoices) {
      const inv = row.invoice;
      if (!row.customerPhone || !inv.id) continue;
      // The old guard called alreadySent(inv.id) which hard-coded
      // entityType='rental' while the write used 'invoice' — the read could
      // never see its own write, so this reminder would have re-fired every
      // single day once SMS was on. entityType is now explicit on both sides.
      if (await alreadyDelivered("invoice", inv.id, "reminder_invoice_overdue_7d")) continue;
      try {
        const result = await sendBusinessSMS(row.customerPhone, `OpenRental: Invoice ${inv.invoiceNumber || `#${inv.id}`} is 7 days past due ($${inv.balanceDue}). Please contact us.`);
        if (!result.delivered) { skipped++; continue; }
        await recordDelivered("invoice", inv.id, "reminder_invoice_overdue_7d", row.customerPhone);
        invoiceNotified++;
      } catch { /* swallow */ }
    }
  } catch (err) {
    logger.warn("[ReminderCron] invoice block failed", { error: err instanceof Error ? err.message : String(err) });
  }

  logger.info("[ReminderCron] complete", { endingNotified, overdueNotified, invoiceNotified, skipped });
}
