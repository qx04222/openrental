import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure, publicProcedure } from "../_core/trpc";
import { getDrivingDistanceKm, getWarehouseAddress, formatAddress, type Address } from "../services/shipping";
import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { calculateBracketFreight, type FreightMethod } from "../../shared/freight";
import { loadFreightConfig } from "../services/pricingConfig";

export const shippingRouter = router({
  /**
   * Smart shipping calculation: uses the Google Maps driving distance to pick the
   * distance bracket (≤30/45/60/75 km). When the distance can't be determined
   * (Maps failure / ungeocodable address), charges the lowest (≤30 km) bracket
   * and flags `assumedMinTier`. Looks up the equipment's warehouse as origin.
   */
  calculateCostSmart: adminProcedure
    .input(
      z.object({
        rentalFleetId: z.number(),
        deliveryAddress: z.string().min(1),
        deliveryMethod: z.string(),
      })
    )
    .query(async ({ input }) => {
      const trips = input.deliveryMethod === "delivery_and_return" ? 2 : 1;

      // Get equipment's warehouse location
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [fleet] = await db
        .select({ locationId: schema.rentalFleet.locationId })
        .from(schema.rentalFleet)
        .where(and(eq(schema.rentalFleet.id, input.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
        .limit(1);

      let origin: Address;
      if (fleet?.locationId) {
        const wh = await getWarehouseAddress(fleet.locationId);
        if (wh && wh.addressLine1 && wh.city) {
          origin = wh;
        } else {
          origin = { addressLine1: "100 Example Ave", city: "Toronto", province: "ON", postalCode: "M5V 0A1" };
        }
      } else {
        origin = { addressLine1: "100 Example Ave", city: "Toronto", province: "ON", postalCode: "M5V 0A1" };
      }

      const originStr = formatAddress({ ...origin, country: "Canada" });
      logger.info("[Shipping Smart] Calculating", {
        rentalFleetId: input.rentalFleetId,
        origin: originStr,
        deliveryAddress: input.deliveryAddress,
        deliveryMethod: input.deliveryMethod,
      });

      // Distance ONLY (no legacy per-equipment pricing). getDrivingDistanceKm
      // returns null on any Maps failure instead of throwing — so a missing key
      // or ungeocodable address degrades gracefully to the ≤30km floor rather
      // than coupling distance to the retired shipping_pricing_* tier system.
      const destination: Address = { addressLine1: input.deliveryAddress, city: "", province: "", postalCode: "" };
      const distanceKm = await getDrivingDistanceKm({ ...origin, country: "Canada" }, { ...destination, country: "Canada" });

      const freightCfg = await loadFreightConfig(db);
      const fr = calculateBracketFreight(distanceKm, input.deliveryMethod as FreightMethod, freightCfg);

      if (distanceKm == null) {
        logger.warn("[Shipping] Distance unavailable, charging lowest (≤30km) freight bracket", {
          rentalFleetId: input.rentalFleetId,
          deliveryAddress: input.deliveryAddress,
        });
      }

      return {
        costPerTrip: fr.roundTripTier ?? 0,
        totalCost: fr.cost,
        trips,
        distanceKm,
        durationMin: null as number | null,
        originAddress: originStr,
        destinationAddress: input.deliveryAddress,
        needsManual: fr.needsManual,
        assumedMinTier: fr.assumedMinTier ?? false,
        source: distanceKm == null ? ("min_tier_fallback" as const) : ("distance_calculated" as const),
        error: null as string | null,
      };
    }),

  /**
   * Fallback shipping cost when there's no delivery address yet (so no distance
   * can be computed). Charges the lowest (≤30 km) freight bracket — the same
   * floor used when a Maps lookup fails — so the order still has a sane freight
   * figure. Staff confirm the real distance once an address is entered.
   */
  calculateCostFallback: publicProcedure
    .input(
      z.object({
        rentalFleetId: z.number(),
        deliveryMethod: z.string(),
      })
    )
    .query(async ({ input }) => {
      const trips = input.deliveryMethod === "delivery_and_return" ? 2 : 1;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const freightCfg = await loadFreightConfig(db);
      const fr = calculateBracketFreight(null, input.deliveryMethod as FreightMethod, freightCfg);
      return {
        costPerTrip: fr.roundTripTier ?? 0,
        totalCost: fr.cost,
        trips,
        tierName: "≤30km",
        assumedMinTier: fr.assumedMinTier ?? false,
        source: "min_tier_fallback" as const,
      };
    }),
});
