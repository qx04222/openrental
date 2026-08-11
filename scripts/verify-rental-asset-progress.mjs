#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";

const repo = new URL("..", import.meta.url).pathname;
const dbName = `mr_bin_progress_${process.pid}_${randomBytes(3).toString("hex")}`;
const protectedTables = [
  "rental_requests",
  "rental_line_items",
  "rental_fleet",
  "inspections",
  "invoices",
  "invoice_line_items",
  "rental_charges",
  "rental_prepayments",
];
const migrations = [
  "sql/139_category_equipment_type.sql",
  "sql/140_mid_rental_swap_flag.sql",
  "sql/141_work_order_customer_labor.sql",
  "sql/142_create_workshop_outbox.sql",
  "sql/143_rental_lifecycle_safety.sql",
];

function command(bin, args, options = {}) {
  return execFileSync(bin, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function psql(sql) {
  return command("psql", ["-d", dbName, "-v", "ON_ERROR_STOP=1", "-tAc", sql]);
}

function psqlFile(file) {
  command("psql", ["-d", dbName, "-v", "ON_ERROR_STOP=1", "-q", "-f", file]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fingerprint(table) {
  return psql(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) FROM ${table} t`);
}

function protectedFingerprints() {
  return Object.fromEntries(protectedTables.map((table) => [table, fingerprint(table)]));
}

function dispatchImmutableFingerprint() {
  return psql(`
    SELECT md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), ''))
    FROM (
      SELECT id, "orderType", "rentalRequestId", "rentalFleetId", "customerId",
             "assignedDriverId", "scheduledDate", "pickupAddress", "deliveryAddress",
             "shippingCost", notes, "driverNotes", "createdAt", "deletedAt", "confirmationToken"
      FROM dispatch_orders
    ) t
  `);
}

function snapshot() {
  return {
    protected: protectedFingerprints(),
    dispatchCount: Number(psql("SELECT count(*) FROM dispatch_orders")),
    dispatchImmutable: dispatchImmutableFingerprint(),
    dispatchMutable: fingerprint("dispatch_orders"),
    eventCount: Number(psql("SELECT count(*) FROM rental_asset_progress_events")),
  };
}

let failure;
try {
  command("createdb", [dbName]);
  psqlFile("e2e/schema.sql");
  for (const migration of migrations) psqlFile(migration);

  psql(`
    DO $$
    DECLARE fleet_id integer; rental_id integer; invoice_id integer;
    BEGIN
      INSERT INTO rental_fleet (brand, model, category, "serialNumber", "assetNumber")
      VALUES ('QA', 'Protected Unit', 'QA', 'QA-PROTECTED-1', 'QA-001') RETURNING id INTO fleet_id;

      INSERT INTO rental_requests (
        "rentalFleetId", "customerName", "customerPhone", "startDate", "endDate", status,
        "deliveryMethod", "insuranceType", "rentalFee", "freightCost", "insuranceCost",
        "taxAmount", "depositAmount", "totalAmount", "rentalNumber"
      ) VALUES (
        fleet_id, 'Migration Protected Customer', '4165550100', '2026-07-15', '2026-07-20', 'active',
        'delivery_and_return', 'basic', 500, 100, 50, 84.50, 0, 734.50, 'QA-MIG-001'
      ) RETURNING id INTO rental_id;

      INSERT INTO rental_line_items ("rentalRequestId", "rentalFleetId", quantity, "dailyRate", "lineSubtotal")
      VALUES (rental_id, fleet_id, 1, 100, 500);
      INSERT INTO inspections (type, "rentalId", "rentalFleetId", "overallCondition")
      VALUES ('dispatch', rental_id, fleet_id, 'good');

      INSERT INTO invoices ("invoiceNumber", "rentalId", subtotal, "taxAmount", "totalAmount", "balanceDue")
      VALUES ('QA-INV-001', rental_id, 650, 84.50, 734.50, 734.50) RETURNING id INTO invoice_id;
      INSERT INTO invoice_line_items ("invoiceId", description, quantity, "unitPrice", amount)
      VALUES (invoice_id, 'Protected rental', 1, 650, 650);
      INSERT INTO rental_charges ("rentalRequestId", "chargeType", amount, description)
      VALUES (rental_id, 'adjustment', 25, 'Protected charge');
      INSERT INTO rental_prepayments ("rentalRequestId", amount, "paymentMethod")
      VALUES (rental_id, 100, 'cash');

      INSERT INTO dispatch_orders ("orderType", "rentalRequestId", "rentalFleetId", status, "confirmationToken") VALUES
        ('delivery', rental_id, fleet_id, 'pending', 'qa-dispatch-pending'),
        ('pickup', rental_id, fleet_id, 'cancelled', 'qa-dispatch-cancelled'),
        ('delivery', rental_id, fleet_id, 'completed', 'qa-dispatch-completed'),
        ('pickup', rental_id, fleet_id, 'assigned', 'qa-dispatch-deleted');
      UPDATE dispatch_orders SET "deletedAt" = now() WHERE "confirmationToken" = 'qa-dispatch-deleted';
    END $$
  `);

  const before = {
    protected: protectedFingerprints(),
    dispatchCount: Number(psql("SELECT count(*) FROM dispatch_orders")),
    dispatchImmutable: dispatchImmutableFingerprint(),
  };

  psqlFile("sql/144_rental_asset_progress.sql");
  const afterFirst = snapshot();

  assert(JSON.stringify(afterFirst.protected) === JSON.stringify(before.protected), "protected table fingerprint changed");
  assert(afterFirst.dispatchCount === before.dispatchCount, "dispatch row count changed");
  assert(afterFirst.dispatchImmutable === before.dispatchImmutable, "dispatch immutable columns changed");
  assert(Number(psql("SELECT count(*) FROM dispatch_orders WHERE \"deletedAt\" IS NULL AND status <> 'completed'")) === 0, "non-deleted dispatch rows were not normalized");
  assert(psql("SELECT status FROM dispatch_orders WHERE \"confirmationToken\"='qa-dispatch-deleted'") === "assigned", "soft-deleted dispatch row changed");
  assert(Number(psql("SELECT count(*) FROM rental_asset_progress_events WHERE \"eventType\"='historical_dispatch_completed' AND metadata->>'previousStatus' IN ('pending','cancelled')")) === 2, "previous dispatch statuses were not preserved");
  assert(psql("SELECT string_agg(key||'='||enabled, ',' ORDER BY key) FROM feature_flags WHERE key IN ('dispatch_workflow','dispatch_inspection_required','return_inspection_required')") === "dispatch_inspection_required=false,dispatch_workflow=false,return_inspection_required=true", "policy defaults are incorrect");

  psqlFile("sql/144_rental_asset_progress.sql");
  const afterSecond = snapshot();
  assert(JSON.stringify(afterSecond) === JSON.stringify(afterFirst), "migration rerun was not idempotent");

  console.log(JSON.stringify({
    ok: true,
    database: dbName,
    protectedFingerprints: afterFirst.protected,
    dispatchCount: afterFirst.dispatchCount,
    progressEventCount: afterFirst.eventCount,
    policyDefaults: "false/false/true",
    rerunIdempotent: true,
  }, null, 2));
} catch (error) {
  failure = error;
} finally {
  try { command("dropdb", ["--if-exists", dbName]); } catch (error) { failure ??= error; }
  try {
    const remaining = command("psql", ["-d", "postgres", "-tAc", `SELECT count(*) FROM pg_database WHERE datname='${dbName}'`]);
    if (remaining !== "0") failure ??= new Error(`disposable database still exists: ${dbName}`);
  } catch (error) { failure ??= error; }
}

if (failure) {
  console.error(failure instanceof Error ? failure.message : String(failure));
  process.exit(1);
}
