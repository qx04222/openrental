/**
 * Seed Canadian Tax Rates
 * Run: npx tsx server/db/seedTaxRates.ts
 */

import { getDb, sql } from "../db";

/* eslint-disable no-console -- seed/CLI script */

const TAX_RATES = [
  { province: "AB", provinceName: "Alberta", gstRate: 0.05, pstRate: 0, hstRate: 0 },
  { province: "BC", provinceName: "British Columbia", gstRate: 0.05, pstRate: 0.07, hstRate: 0 },
  { province: "MB", provinceName: "Manitoba", gstRate: 0.05, pstRate: 0.07, hstRate: 0 },
  { province: "NB", provinceName: "New Brunswick", gstRate: 0, pstRate: 0, hstRate: 0.15 },
  { province: "NL", provinceName: "Newfoundland and Labrador", gstRate: 0, pstRate: 0, hstRate: 0.15 },
  { province: "NS", provinceName: "Nova Scotia", gstRate: 0, pstRate: 0, hstRate: 0.15 },
  { province: "NT", provinceName: "Northwest Territories", gstRate: 0.05, pstRate: 0, hstRate: 0 },
  { province: "NU", provinceName: "Nunavut", gstRate: 0.05, pstRate: 0, hstRate: 0 },
  { province: "ON", provinceName: "Ontario", gstRate: 0, pstRate: 0, hstRate: 0.13 },
  { province: "PE", provinceName: "Prince Edward Island", gstRate: 0, pstRate: 0, hstRate: 0.15 },
  { province: "QC", provinceName: "Quebec", gstRate: 0.05, pstRate: 0.09975, hstRate: 0 },
  { province: "SK", provinceName: "Saskatchewan", gstRate: 0.05, pstRate: 0.06, hstRate: 0 },
  { province: "YT", provinceName: "Yukon", gstRate: 0.05, pstRate: 0, hstRate: 0 },
];

async function seedTaxRates() {
  const db = await getDb();
  if (!db) {
    console.error("Database not available");
    process.exit(1);
  }

  console.log("Seeding tax rates...");

  for (const rate of TAX_RATES) {
    await db.execute(sql`
      INSERT INTO tax_rates (province, "provinceName", "gstRate", "pstRate", "hstRate", "isActive")
      VALUES (${rate.province}, ${rate.provinceName}, ${rate.gstRate}, ${rate.pstRate}, ${rate.hstRate}, true)
      ON CONFLICT (province) DO UPDATE SET
        "provinceName" = EXCLUDED."provinceName",
        "gstRate" = EXCLUDED."gstRate",
        "pstRate" = EXCLUDED."pstRate",
        "hstRate" = EXCLUDED."hstRate"
    `);
    console.log(`  ${rate.province}: ${rate.provinceName}`);
  }

  console.log("Tax rates seeded successfully!");
  process.exit(0);
}

seedTaxRates().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
