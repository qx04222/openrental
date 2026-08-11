import "dotenv/config";
import { getDb } from "./core";
import * as schema from "../../drizzle/schema";
import { eq } from "drizzle-orm";

/* eslint-disable no-console -- seed/CLI script */

/**
 * Demo dataset — entirely fictional.
 *
 * Every company, person, phone number and address below is invented. Phone
 * numbers use the 555-01xx range that North American telecoms reserve for
 * fiction, and addresses point at "Example Ave". Nothing here corresponds to a
 * real customer of any business.
 *
 * The point is that `npm run seed:demo` gives you a system with something in
 * it: a fleet with a mix of statuses, customers across the industry
 * classifications, and orders at different stages of the lifecycle — so the
 * dashboards, the availability calendar and the collections list all have
 * something to show on first run.
 *
 * Safe to re-run: every insert is guarded on a natural key.
 */

const CATEGORIES = [
  { name: "Mini Excavator", equipmentType: "machine" as const, displayOrder: 1 },
  { name: "Skid Steer", equipmentType: "machine" as const, displayOrder: 2 },
  { name: "Scissor Lift", equipmentType: "machine" as const, displayOrder: 3 },
  { name: "Compact Track Loader", equipmentType: "machine" as const, displayOrder: 4 },
  { name: "Auger", equipmentType: "attachment" as const, displayOrder: 5 },
  { name: "Hydraulic Breaker", equipmentType: "attachment" as const, displayOrder: 6 },
];

const FLEET = [
  { assetNumber: "EX-101", brand: "Northline", model: "NX-25", category: "Mini Excavator", year: 2024, dailyRate: "320.00", weeklyRate: "1150.00", monthlyRate: "3400.00", purchaseCost: "62000.00", currentStatus: "available" as const, engineHours: 412 },
  { assetNumber: "EX-102", brand: "Northline", model: "NX-25", category: "Mini Excavator", year: 2024, dailyRate: "320.00", weeklyRate: "1150.00", monthlyRate: "3400.00", purchaseCost: "62000.00", currentStatus: "rented" as const, engineHours: 688 },
  { assetNumber: "EX-103", brand: "Northline", model: "NX-38", category: "Mini Excavator", year: 2023, dailyRate: "395.00", weeklyRate: "1420.00", monthlyRate: "4200.00", purchaseCost: "81000.00", currentStatus: "rented" as const, engineHours: 1204 },
  { assetNumber: "SS-201", brand: "Cedarworks", model: "CW-70", category: "Skid Steer", year: 2024, dailyRate: "285.00", weeklyRate: "1020.00", monthlyRate: "3050.00", purchaseCost: "55000.00", currentStatus: "available" as const, engineHours: 233 },
  { assetNumber: "SS-202", brand: "Cedarworks", model: "CW-70", category: "Skid Steer", year: 2022, dailyRate: "265.00", weeklyRate: "950.00", monthlyRate: "2850.00", purchaseCost: "48000.00", currentStatus: "maintenance" as const, engineHours: 2941 },
  { assetNumber: "SL-301", brand: "Highreach", model: "HR-1930", category: "Scissor Lift", year: 2023, dailyRate: "175.00", weeklyRate: "620.00", monthlyRate: "1850.00", purchaseCost: "28000.00", currentStatus: "available" as const, engineHours: 501 },
  { assetNumber: "SL-302", brand: "Highreach", model: "HR-2632", category: "Scissor Lift", year: 2024, dailyRate: "225.00", weeklyRate: "810.00", monthlyRate: "2400.00", purchaseCost: "37000.00", currentStatus: "rented" as const, engineHours: 189 },
  { assetNumber: "CT-401", brand: "Cedarworks", model: "CT-95", category: "Compact Track Loader", year: 2025, dailyRate: "410.00", weeklyRate: "1470.00", monthlyRate: "4400.00", purchaseCost: "94000.00", currentStatus: "available" as const, engineHours: 76 },
  { assetNumber: "AU-501", brand: "Groundworks", model: "GA-12", category: "Auger", year: 2023, dailyRate: "95.00", weeklyRate: "340.00", monthlyRate: "980.00", purchaseCost: "6800.00", currentStatus: "available" as const, engineHours: null },
  { assetNumber: "HB-601", brand: "Groundworks", model: "GB-750", category: "Hydraulic Breaker", year: 2022, dailyRate: "140.00", weeklyRate: "500.00", monthlyRate: "1450.00", purchaseCost: "11500.00", currentStatus: "available" as const, engineHours: null },
];

const CUSTOMERS = [
  { name: "Ana Ferreira", company: "Birchwood Landscaping", phone: "555-010-1001", email: "ana@birchwood.example", city: "Toronto", province: "ON", industry: "landscaping", preferredLanguage: "en" },
  { name: "Daniel Okoye", company: "Okoye General Contracting", phone: "555-010-1002", email: "d.okoye@okoyegc.example", city: "Mississauga", province: "ON", industry: "general_contractor", preferredLanguage: "en" },
  { name: "Mei Lin", company: "Lin Home Renovations", phone: "555-010-1003", email: null, city: "Markham", province: "ON", industry: "renovation", preferredLanguage: "zh" },
  { name: "Robert Shaw", company: "Shaw Property Services", phone: "555-010-1004", email: "rshaw@shawprop.example", city: "Hamilton", province: "ON", industry: "property", preferredLanguage: "en" },
  { name: "Priya Nair", company: "Nair Excavation Ltd.", phone: "555-010-1005", email: null, city: "Brampton", province: "ON", industry: "excavation", preferredLanguage: "en" },
  { name: "Tomás Rivera", company: null, phone: "555-010-1006", email: "t.rivera@example.com", city: "Toronto", province: "ON", industry: "individual", preferredLanguage: "en" },
];

async function seedDemo() {
  const db = await getDb();
  if (!db) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  console.log("Seeding demo data (all fictional)...");

  for (const c of CATEGORIES) {
    await db.insert(schema.equipmentCategories).values(c).onConflictDoNothing();
  }
  console.log(`  categories: ${CATEGORIES.length}`);

  const [warehouse] = await db.select().from(schema.warehouses).limit(1);

  for (const f of FLEET) {
    await db.insert(schema.rentalFleet).values({
      ...f,
      serialNumber: `DEMO-${f.assetNumber}`,
      locationId: warehouse?.id ?? null,
      condition: "good",
      purchaseDate: new Date(`${f.year}-03-15`),
    }).onConflictDoNothing();
  }
  console.log(`  fleet assets: ${FLEET.length}`);

  for (const c of CUSTOMERS) {
    const existing = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.phone, c.phone))
      .limit(1);
    if (existing.length) continue;
    await db.insert(schema.customers).values({
      ...c,
      address: "100 Example Ave",
      postalCode: "M5V 0A1",
      source: "admin",
      notes: "Demo record — fictional.",
    });
  }
  console.log(`  customers: ${CUSTOMERS.length}`);

  console.log("Demo seed complete. Sign in with admin / admin123 and change the password.");
  process.exit(0);
}

seedDemo().catch((err) => {
  console.error("Demo seed failed:", err);
  process.exit(1);
});
