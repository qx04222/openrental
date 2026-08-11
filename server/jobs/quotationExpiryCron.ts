/**
 * Quotation Expiry Cron Job
 *
 * Marks quotations whose validUntil has passed as `expired`, so a stale price
 * can't silently be treated as live. Only non-terminal quotes are touched
 * (draft / sent) — accepted / rejected / expired / cancelled are left alone.
 *
 * This is purely a status update: it does NOT block ordering off an expired
 * quote (that would be a behavior change on the booking path). It just keeps
 * the quote list / funnel honest.
 *
 * Runs daily (scheduled in server/_core/index.ts).
 */

import { getDb, and, isNull, inArray, isNotNull } from "../db";
import { lt } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { zonedTodayPlusDaysUtc } from "../_core/dateUtils";

export interface RunQuotationExpiryCronOptions {
  now?: Date;
}

export async function runQuotationExpiryCron(_options: RunQuotationExpiryCronOptions = {}): Promise<{ expired: number }> {
  const db = await getDb();
  if (!db) {
    logger.warn("[QuotationExpiryCron] DB unavailable — skipping");
    return { expired: 0 };
  }

  // Today's Toronto midnight as a UTC instant. A quote is expired once its
  // validUntil day is strictly before today (i.e. yesterday or earlier).
  const todayTorontoMidnight = zonedTodayPlusDaysUtc(0);

  const rows = await db
    .update(schema.quotations)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(
      inArray(schema.quotations.status, ["draft", "sent"]),
      isNotNull(schema.quotations.validUntil),
      lt(schema.quotations.validUntil, todayTorontoMidnight),
      isNull(schema.quotations.deletedAt),
    ))
    .returning({ id: schema.quotations.id });

  if (rows.length > 0) {
    logger.info(`[QuotationExpiryCron] Marked ${rows.length} quotation(s) expired`);
  }
  return { expired: rows.length };
}
