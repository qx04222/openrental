import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { isFeatureEnabled } from "../services/featureFlags";
import { rollingSettlementDueWhere, settleRollingBoundary } from "../services/rollingSettlement";

export async function runRollingSettlementCron(options: { now?: Date } = {}) {
  if (!await isFeatureEnabled("rolling_renewal_operations")) {
    return { due: 0, settled: 0, failed: 0 };
  }
  const db = await getDb();
  if (!db) {
    logger.warn("[RollingSettlementCron] Database not available");
    return { due: 0, settled: 0, failed: 0 };
  }
  const now = options.now ?? new Date();
  const dueTerms = await db
    .select({ id: schema.rentalRollingTerms.id })
    .from(schema.rentalRollingTerms)
    .where(rollingSettlementDueWhere(now))
    .orderBy(schema.rentalRollingTerms.nextSettlementDate)
    .limit(500);

  let settled = 0;
  let failed = 0;
  for (const term of dueTerms) {
    try {
      const result = await settleRollingBoundary(db, { termId: term.id, now });
      if (result.settled) settled++;
    } catch (error) {
      failed++;
      logger.warn("[RollingSettlementCron] Term settlement failed", {
        termId: term.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info("[RollingSettlementCron] Complete", { due: dueTerms.length, settled, failed });
  return { due: dueTerms.length, settled, failed };
}
