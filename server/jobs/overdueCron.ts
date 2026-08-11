/**
 * Overdue Status Cron Job
 *
 * Flips rentals to/from the "overdue" status based on the due date + a grace
 * period. This is the missing piece: the `overdue` status existed but nothing
 * ever set it. Late fees are intentionally NOT applied here — overdue is just a
 * visible flag (the late-fee estimation lives in its own flag-gated cron).
 *
 *   active  + past (endDate + grace) + not returned + not credit → overdue
 *   overdue + back within (endDate + grace) (e.g. renewed)        → active
 *
 * Runs daily (scheduled in server/_core/index.ts). Credit (挂账) orders are
 * open-ended (2099 sentinel endDate) and never overdue.
 */
import { getDb, eq, and, isNull, lt, gte, or, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { rollingOverdueProtectionSql } from "../services/rollingOverduePolicy";

export interface RunOverdueCronOptions {
  now?: Date;
}

export async function runOverdueCron(options: RunOverdueCronOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const db = await getDb();
  if (!db) {
    logger.warn("[OverdueCron] Database not available");
    return;
  }

  // Grace period (hours) — reuse the late-fee grace setting; default 24h.
  const [graceRow] = await db
    .select({ value: schema.rentalSettings.value })
    .from(schema.rentalSettings)
    .where(eq(schema.rentalSettings.key, "late_fee_grace_hours"))
    .limit(1);
  const graceHours = parseInt(graceRow?.value ?? "24", 10) || 24;
  const cutoff = new Date(now.getTime() - graceHours * 3600 * 1000);

  // active + past due (beyond grace) + not returned + not credit → overdue
  const toOverdue = await db
    .select({ id: schema.rentalRequests.id, status: schema.rentalRequests.status, customerName: schema.rentalRequests.customerName })
    .from(schema.rentalRequests)
    .where(and(
      eq(schema.rentalRequests.status, "active"),
      eq(schema.rentalRequests.isCreditOrder, false),
      eq(schema.rentalRequests.returnInspectionCompleted, false),
      lt(schema.rentalRequests.endDate, cutoff),
      sql`NOT (${rollingOverdueProtectionSql(sql`${schema.rentalRequests.id}`)})`,
      isNull(schema.rentalRequests.deletedAt),
    ));

  // overdue but no longer past due (e.g. renewed/extended) → back to active
  const toActive = await db
    .select({ id: schema.rentalRequests.id, status: schema.rentalRequests.status, customerName: schema.rentalRequests.customerName })
    .from(schema.rentalRequests)
    .where(and(
      eq(schema.rentalRequests.status, "overdue"),
      or(
        gte(schema.rentalRequests.endDate, cutoff),
        rollingOverdueProtectionSql(sql`${schema.rentalRequests.id}`),
      ),
      isNull(schema.rentalRequests.deletedAt),
    ));

  const { transitionRentalStatus } = await import("../routers/rentalRequests.router");
  for (const r of toOverdue) {
    try {
      await transitionRentalStatus(db, {
        rentalId: r.id,
        targetStatus: "overdue",
        transitionedAt: now,
        auditAction: "overdue_auto",
        auditMetadata: { graceHours, source: "overdue_cron" },
      });
    } catch (error) {
      logger.warn("[OverdueCron] Could not mark rental overdue", {
        rentalId: r.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const r of toActive) {
    try {
      await transitionRentalStatus(db, {
        rentalId: r.id,
        targetStatus: "active",
        transitionedAt: now,
        auditAction: "overdue_cleared",
        auditMetadata: { source: "overdue_cron" },
      });
    } catch (error) {
      logger.warn("[OverdueCron] Could not clear rental overdue status", {
        rentalId: r.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info(`[OverdueCron] → overdue: ${toOverdue.length}, → active: ${toActive.length} (grace ${graceHours}h)`);
}
