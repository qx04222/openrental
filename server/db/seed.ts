import "dotenv/config";
import { getDb } from "./core";
import * as schema from "../../drizzle/schema";
import bcrypt from "bcrypt";

/* eslint-disable no-console -- seed/CLI script */

async function seed() {
  const db = await getDb();
  if (!db) {
    console.error("DATABASE_URL not configured");
    process.exit(1);
  }

  console.log("Seeding OpenRental database...");

  // 1. Create super admin user
  const passwordHash = await bcrypt.hash("admin123", 10);
  await db.insert(schema.users).values({
    username: "admin",
    email: "rentals@openrental.example",
    name: "OpenRental Admin",
    passwordHash,
    role: "super_admin",
  }).onConflictDoNothing();

  // 2. Create field staff user
  const fieldHash = await bcrypt.hash("field123", 10);
  await db.insert(schema.users).values({
    username: "inspector",
    email: "inspector@openrental.example",
    name: "Field Inspector",
    passwordHash: fieldHash,
    role: "field_staff",
  }).onConflictDoNothing();

  // 2b. Create read-only accountant user
  const accountantHash = await bcrypt.hash("accountant123", 10);
  await db.insert(schema.users).values({
    username: "accountant",
    email: "accountant@openrental.example",
    name: "OpenRental Accountant",
    passwordHash: accountantHash,
    role: "accountant",
  }).onConflictDoNothing();

  // 3. Create default warehouse
  await db.insert(schema.warehouses).values({
    name: "Main Yard",
    address: "100 Example Ave",
    city: "Toronto",
    province: "ON",
    postalCode: "M5V 0A1",
    phone: "+1 555-010-0100",
  }).onConflictDoNothing();

  // 4. Seed site settings
  const settings = [
    { key: "company_name", value: "OpenRental" },
    { key: "tagline", value: "Equipment rental, run properly" },
    { key: "logo_url", value: "/logo.png" },
    { key: "primary_color", value: "#1F2937" },
    { key: "accent_color", value: "#2563EB" },
    { key: "contact_email", value: "rentals@openrental.example" },
    { key: "contact_phone", value: "+1 555-010-0100" },
    { key: "sales_email", value: "sales@openrental.example" },
    { key: "sales_phone", value: "+1 555-010-0200" },
    { key: "address", value: "100 Example Ave, Toronto, ON M5V 0A1" },
    { key: "domain", value: "openrental.example" },
  ];

  for (const s of settings) {
    await db.insert(schema.siteSettings).values(s).onConflictDoNothing();
  }

  console.log("Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
