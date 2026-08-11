/**
 * Late Fee Estimation Cron Job
 *
 * Scans rentals that are past their endDate and not yet returned,
 * then refreshes estimatedLateFee and lateFeeLastComputedAt.
 *
 * Runs daily at 03:30 the configured timezone (scheduled in server/_core/index.ts).
 * Gated by the `late_fee_auto` feature flag.
 */

import { getDb, eq, and, isNull, inArray, sql } from "../db";
import { lt } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { isFeatureEnabled } from "../services/featureFlags";
import { computeLateFee, dailyBaseRateFromRental } from "../services/lateFee";

export interface RunLateFeeCronOptions {
  now?: Date;
}

export async function runLateFeeCron(options: RunLateFeeCronOptions = {}): Promise<void> {
  // Feature-flag guard
  if (!(await isFeatureEnabled("late_fee_auto"))) {
    logger.info("[LateFeeCron] Feature flag off — skipping");
    return;
  }

  const now = options.now ?? new Date();
  logger.info("[LateFeeCron] Starting late fee estimation", { now: now.toISOString() });

  const db = await getDb();
  if (!db) {
    logger.warn("[LateFeeCron] Database not available");
    return;
  }

  // Load settings
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
    lateFeeDailyRatePct: parseFloat(settingsMap["late_fee_daily_rate_pct"] ?? "150"),
    lateFeeGraceHours: parseInt(settingsMap["late_fee_grace_hours"] ?? "24", 10),
  };

  // Select overdue, open, non-deleted rentals not yet returned
  const overdueRentals = await db
    .select()
    .from(schema.rentalRequests)
    .where(
      and(
        lt(schema.rentalRequests.endDate, now),
        eq(schema.rentalRequests.returnInspectionCompleted, false),
        inArray(schema.rentalRequests.status, ["active", "approved"]),
        isNull(schema.rentalRequests.deletedAt),
      ),
    );

  logger.info(`[LateFeeCron] Found ${overdueRentals.length} overdue rental(s)`);

  let updated = 0;
  for (const rental of overdueRentals) {
    try {
      const dailyBaseRate = dailyBaseRateFromRental({
        rentalFee: rental.rentalFee,
        startDate: rental.startDate,
        endDate: rental.endDate,
      });

      const { lateFeeAmount } = computeLateFee({
        endDate: rental.endDate,
        actualReturnDate: null, // compute vs now
        dailyBaseRate,
        settings: lateSettings,
        now,
      });

      await db
        .update(schema.rentalRequests)
        .set({
          estimatedLateFee: lateFeeAmount.toFixed(2),
          lateFeeLastComputedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.rentalRequests.id, rental.id));

      updated++;
    } catch (err) {
      logger.warn("[LateFeeCron] Failed to update rental", {
        rentalId: rental.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(`[LateFeeCron] Complete — updated ${updated}/${overdueRentals.length} rental(s)`);
}
