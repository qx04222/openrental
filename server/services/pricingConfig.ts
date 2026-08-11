/**
 * Loads admin-editable freight & deposit configuration from rental_settings,
 * so the settings page and the pricing engine never diverge. Falls back to the
 * published defaults when a key is missing.
 */
import * as schema from "../../drizzle/schema";
import { DEFAULT_FREIGHT_CONFIG, type FreightConfig } from "../../shared/freight";
import { DEFAULT_DEPOSIT_CONFIG, type DepositConfig } from "../../shared/deposit";

type Db = NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;

const num = (map: Map<string, string>, key: string, fallback: number): number => {
  const v = parseFloat(map.get(key) ?? "");
  return isNaN(v) ? fallback : v;
};

async function settingsMap(db: Db): Promise<Map<string, string>> {
  const rows = await db.select().from(schema.rentalSettings);
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function loadFreightConfig(db: Db): Promise<FreightConfig> {
  try {
    const m = await settingsMap(db);
    return {
      tier30: num(m, "freight_tier_30km", DEFAULT_FREIGHT_CONFIG.tier30),
      tier45: num(m, "freight_tier_45km", DEFAULT_FREIGHT_CONFIG.tier45),
      tier60: num(m, "freight_tier_60km", DEFAULT_FREIGHT_CONFIG.tier60),
      tier75: num(m, "freight_tier_75km", DEFAULT_FREIGHT_CONFIG.tier75),
      onewayFactor: num(m, "freight_oneway_factor", DEFAULT_FREIGHT_CONFIG.onewayFactor),
      maxKm: num(m, "freight_max_km", DEFAULT_FREIGHT_CONFIG.maxKm),
    };
  } catch {
    return DEFAULT_FREIGHT_CONFIG;
  }
}

export async function loadDepositConfig(db: Db): Promise<DepositConfig> {
  try {
    const m = await settingsMap(db);
    return {
      multiplier: num(m, "deposit_multiplier", DEFAULT_DEPOSIT_CONFIG.multiplier),
      roundTo: num(m, "deposit_round_to", DEFAULT_DEPOSIT_CONFIG.roundTo),
    };
  } catch {
    return DEFAULT_DEPOSIT_CONFIG;
  }
}
