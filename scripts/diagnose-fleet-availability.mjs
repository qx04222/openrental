#!/usr/bin/env node
/**
 * Read-only diagnostic — figures out why "3 units 2 rented" might display as
 * "all booked" on the customer-facing rent-equipment page. No writes.
 */
import postgres from "postgres";
import "dotenv/config";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1 });

const today = new Date().toISOString().slice(0, 10);

console.log(`\n=== Diagnosis @ ${today} ===\n`);

console.log("─── 1. Active fleet (non-retired, non-deleted) by group key ───");
const fleetByGroup = await sql`
  SELECT
    COALESCE(NULLIF(LOWER(TRIM(brand)), '') || '|' || NULLIF(LOWER(TRIM(model)), ''), '(blank)') AS bm_key,
    "equipmentModelId" AS model_id,
    "catalogCacheId"   AS catalog_id,
    COUNT(*)           AS unit_count,
    array_agg(id ORDER BY id) AS fleet_ids,
    array_agg(DISTINCT "currentStatus") AS statuses
  FROM rental_fleet
  WHERE "deletedAt" IS NULL AND "currentStatus" <> 'retired'
  GROUP BY 1, 2, 3
  ORDER BY unit_count DESC, bm_key;
`;
console.table(fleetByGroup);

console.log("\n─── 2. Active fleet detail (one row per unit) ───");
const fleetDetail = await sql`
  SELECT
    id,
    "assetNumber" AS asset,
    brand, model, category,
    "currentStatus" AS status,
    "equipmentModelId" AS model_id,
    "catalogCacheId"   AS catalog_id,
    division
  FROM rental_fleet
  WHERE "deletedAt" IS NULL AND "currentStatus" <> 'retired'
  ORDER BY brand, model, id;
`;
console.table(fleetDetail);

console.log("\n─── 3. Rental requests currently blocking fleet (status pending/approved/active) ───");
const blocking = await sql`
  SELECT
    rr.id,
    rr."rentalNumber" AS num,
    rr.status,
    rr."rentalFleetId" AS fleet_id,
    rr."customerName"  AS customer,
    rr."startDate"::date AS start,
    rr."endDate"::date   AS end_,
    f.brand || ' ' || f.model AS equipment
  FROM rental_requests rr
  LEFT JOIN rental_fleet f ON f.id = rr."rentalFleetId"
  WHERE rr."deletedAt" IS NULL
    AND rr.status IN ('pending', 'approved', 'active')
    AND rr."rentalFleetId" IS NOT NULL
  ORDER BY rr."startDate";
`;
console.table(blocking);

console.log("\n─── 4. Fleet IDs blocked TODAY (mimics customer-facing query for today's date) ───");
const blockedToday = await sql`
  SELECT DISTINCT "rentalFleetId" AS blocked_fleet_id
  FROM rental_requests
  WHERE "deletedAt" IS NULL
    AND status IN ('pending', 'approved', 'active')
    AND "rentalFleetId" IS NOT NULL
    AND "startDate" <= ${today}::date
    AND "endDate"   >= ${today}::date
  ORDER BY blocked_fleet_id;
`;
console.table(blockedToday);

console.log("\n─── 5. Maintenance fleet (also unavailable to customer) ───");
const maint = await sql`
  SELECT id, "assetNumber", brand, model, "currentStatus"
  FROM rental_fleet
  WHERE "deletedAt" IS NULL AND "currentStatus" = 'maintenance';
`;
console.table(maint);

console.log("\nSummary heuristics:");
console.log(`  Total active units:        ${fleetDetail.length}`);
console.log(`  Distinct group keys (bm):  ${new Set(fleetByGroup.map(r => r.bm_key)).size}`);
console.log(`  Fleet IDs blocked today:   ${blockedToday.length}`);
console.log(`  Units in maintenance:      ${maint.length}`);

await sql.end();
