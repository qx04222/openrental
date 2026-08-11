/**
 * Price version promotion cron.
 *
 * Runs daily. Promotes any equipment-model price version whose effective_from
 * has arrived into the equipment_models "currently effective" cache, so a
 * future-scheduled price change goes live on its effective date. Idempotent.
 */

import { getDb } from "../db";
import { promoteEffectiveRates } from "../services/priceVersions";
import { logger } from "../_core/logger";

export async function runPromotePricesCron(): Promise<{ changed: number }> {
  const db = await getDb();
  if (!db) return { changed: 0 };

  const changed = await promoteEffectiveRates(db, new Date());
  if (changed > 0) {
    logger.info(`[Cron] Promoted ${changed} equipment model rate(s) to newly-effective price version`);
  }
  return { changed };
}
