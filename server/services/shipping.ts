/**
 * Shipping Cost Calculation Service
 * Uses Google Maps Distance Matrix API to calculate distances and shipping costs
 */

import { makeRequest } from "../_core/map";
import { logger } from "../_core/logger";

export interface Address {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  province: string;
  postalCode: string;
  country?: string;
}

interface DistanceMatrixElement {
  status: string;
  distance: { value: number; text: string };
  duration: { value: number; text: string };
}

interface DistanceMatrixResponse {
  status: string;
  rows: Array<{ elements: DistanceMatrixElement[] }>;
  error_message?: string;
}

export function formatAddress(address: Address): string {
  const parts = [address.addressLine1, address.addressLine2, address.city, address.province, address.postalCode, address.country || "Canada"].filter(Boolean);
  return parts.join(", ");
}

/**
 * One-way driving distance (km) only — no pricing. The bracket-freight model
 * (shared/freight.ts) and delivery-distance reporting need the distance alone.
 * Returns null on any Maps failure so callers degrade gracefully instead of
 * throwing. (The legacy per-equipment pricing tier system has been retired.)
 */
export async function getDrivingDistanceKm(origin: Address, destination: Address): Promise<number | null> {
  try {
    const response = await makeRequest<DistanceMatrixResponse>("/maps/api/distancematrix/json", {
      origins: formatAddress(origin),
      destinations: formatAddress(destination),
      units: "metric",
      mode: "driving",
    });
    const element = response.status === "OK" ? response.rows[0]?.elements[0] : undefined;
    if (!element || element.status !== "OK") {
      // Surface the real cause so a production failure isn't invisible:
      //   REQUEST_DENIED → key missing/restricted/billing; OVER_QUERY_LIMIT → quota;
      //   ZERO_RESULTS / NOT_FOUND → ungeocodable address.
      logger.warn("[Maps] distance lookup failed — freight will fall back to the lowest bracket", {
        topStatus: response.status,
        elementStatus: element?.status ?? "MISSING",
        errorMessage: response.error_message,
        origin: formatAddress(origin),
        destination: formatAddress(destination),
      });
      return null;
    }
    return Math.round((element.distance.value / 1000) * 100) / 100;
  } catch (err) {
    logger.warn("[Maps] distance lookup threw — freight will fall back to the lowest bracket", {
      error: err instanceof Error ? err.message : String(err),
      origin: formatAddress(origin),
      destination: formatAddress(destination),
    });
    return null;
  }
}

export async function getWarehouseAddress(warehouseId: number): Promise<Address | null> {
  const { getDb, eq, and, isNull } = await import("../db");
  const { warehouses } = await import("../../drizzle/schema");

  const db = await getDb();
  if (!db) throw new Error("Database connection not available");

  const [warehouse] = await db.select().from(warehouses).where(and(eq(warehouses.id, warehouseId), isNull(warehouses.deletedAt))).limit(1);
  if (!warehouse) return null;

  return {
    addressLine1: warehouse.address || "",
    city: warehouse.city || "",
    province: warehouse.province || "",
    postalCode: warehouse.postalCode || "",
  };
}
