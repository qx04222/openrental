/**
 * Google Maps API Integration
 * Direct Google Maps API calls using GOOGLE_MAPS_API_KEY
 */

import { logger } from "./logger";

type MapsConfig = {
  baseUrl: string;
  apiKey: string;
};

function getMapsConfig(): MapsConfig {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error("Google Maps API key not configured: set GOOGLE_MAPS_API_KEY in .env");
  }

  return {
    baseUrl: "https://maps.googleapis.com",
    apiKey,
  };
}

export async function makeRequest<T = unknown>(
  endpoint: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const { baseUrl, apiKey } = getMapsConfig();

  const url = new URL(`${baseUrl}${endpoint}`);
  url.searchParams.append("key", apiKey);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  });

  logger.info("[Maps] Making request", { url: url.toString().replace(apiKey, "***") });

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Maps API request failed (${response.status}): ${errorText}`);
  }

  return (await response.json()) as T;
}
