/**
 * Seed Default Rental Settings
 * Run: npx tsx server/db/seedRentalSettings.ts
 */

import { getDb, sql } from "../db";

/* eslint-disable no-console -- seed/CLI script */

const SETTINGS = [
  // Insurance
  { key: "insurance_basic_rate", value: "0.15", description: "Basic insurance rate (% of rental)", category: "insurance" },
  { key: "insurance_full_rate", value: "0.25", description: "Full insurance rate (% of rental)", category: "insurance" },
  { key: "insurance_basic_deductible", value: "1000", description: "Basic insurance deductible ($)", category: "insurance" },
  { key: "insurance_full_deductible", value: "0", description: "Full insurance deductible ($)", category: "insurance" },
  // Deposits — deposit = multiplier × after-tax (rent+insurance+freight), rounded up; account customers (creditLimit>0) waived.
  { key: "deposit_multiplier", value: "1.5", description: "Deposit = this × after-tax (rent+insurance+freight)", category: "deposits" },
  { key: "deposit_round_to", value: "50", description: "Round deposit UP to nearest $", category: "deposits" },
  // Freight — distance-bracket round-trip prices; one-way = tier × oneway_factor (nearest $10); beyond max_km = manual.
  { key: "freight_tier_30km", value: "285", description: "Round-trip freight ≤30 km ($)", category: "shipping" },
  { key: "freight_tier_45km", value: "335", description: "Round-trip freight ≤45 km ($)", category: "shipping" },
  { key: "freight_tier_60km", value: "385", description: "Round-trip freight ≤60 km ($)", category: "shipping" },
  { key: "freight_tier_75km", value: "435", description: "Round-trip freight ≤75 km ($)", category: "shipping" },
  { key: "freight_oneway_factor", value: "0.575", description: "One-way = round-trip × this (0.5×1.15)", category: "shipping" },
  { key: "freight_max_km", value: "75", description: "Beyond this distance → manual freight quote", category: "shipping" },
  // Pricing
  { key: "min_daily_rate_override", value: "0", description: "Minimum daily rate override ($)", category: "pricing" },
  // Rental Rules
  { key: "min_rental_days", value: "1", description: "Minimum rental period (days)", category: "rental_rules" },
  { key: "max_rental_days", value: "365", description: "Maximum rental period (days)", category: "rental_rules" },
  { key: "advance_booking_days", value: "1", description: "Minimum advance booking (days)", category: "rental_rules" },
  { key: "cancellation_policy", value: "Free cancellation up to 48 hours before start date. 50% charge for late cancellations.", description: "Cancellation policy text", category: "rental_rules" },
  // Business Hours
  { key: "business_hours_start", value: "08:00", description: "Business hours start", category: "rental_rules" },
  { key: "business_hours_end", value: "17:00", description: "Business hours end", category: "rental_rules" },
  { key: "business_days", value: "Mon,Tue,Wed,Thu,Fri", description: "Business days", category: "rental_rules" },
];

async function seedRentalSettings() {
  const db = await getDb();
  if (!db) {
    console.error("Database not available");
    process.exit(1);
  }

  console.log("Seeding rental settings...");

  for (const s of SETTINGS) {
    await db.execute(sql`
      INSERT INTO rental_settings (key, value, description, category)
      VALUES (${s.key}, ${s.value}, ${s.description}, ${s.category})
      ON CONFLICT (key) DO UPDATE SET
        value = EXCLUDED.value,
        description = EXCLUDED.description,
        category = EXCLUDED.category
    `);
    console.log(`  ${s.key}: ${s.value}`);
  }

  console.log("Rental settings seeded successfully!");
  process.exit(0);
}

seedRentalSettings().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
