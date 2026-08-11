#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";

const repo = new URL("..", import.meta.url).pathname;
const dbName = `mr_bin_rolling_${process.pid}_${randomBytes(3).toString("hex")}`;
const protectedTables = [
  "rental_requests",
  "rental_line_items",
  "rental_fleet",
  "invoices",
  "invoice_line_items",
  "inspections",
  "payments",
  "rental_charges",
  "rental_prepayments",
  "rental_asset_progress_events",
];
const prerequisiteMigrations = [
  "sql/139_category_equipment_type.sql",
  "sql/140_mid_rental_swap_flag.sql",
  "sql/141_work_order_customer_labor.sql",
  "sql/142_create_workshop_outbox.sql",
  "sql/143_rental_lifecycle_safety.sql",
  "sql/144_rental_asset_progress.sql",
];

function command(bin, args, options = {}) {
  return execFileSync(bin, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function psql(statement) {
  return command("psql", ["-d", dbName, "-v", "ON_ERROR_STOP=1", "-tAc", statement]);
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

function migrationSnapshot() {
  return {
    protected: protectedFingerprints(),
    rollingTerms: Number(psql("SELECT count(*) FROM rental_rolling_terms")),
    returnOperations: Number(psql("SELECT count(*) FROM rental_asset_return_operations")),
    flag: psql("SELECT key||'='||enabled FROM feature_flags WHERE key='rolling_renewal_operations'"),
    schema: psql(`
      SELECT md5(string_agg(obj, '|' ORDER BY obj)) FROM (
        SELECT pg_get_constraintdef(oid) AS obj FROM pg_constraint
          WHERE conrelid IN ('rental_rolling_terms'::regclass, 'rental_asset_return_operations'::regclass)
        UNION ALL
        SELECT indexdef FROM pg_indexes
          WHERE tablename IN ('rental_rolling_terms', 'rental_asset_return_operations')
      ) definitions
    `),
  };
}

let failure;
try {
  command("createdb", [dbName]);
  psqlFile("e2e/schema.sql");
  for (const migration of prerequisiteMigrations) psqlFile(migration);

  psql(`
    DO $$
    DECLARE fleet_id integer; rental_id integer; invoice_id integer; user_id integer;
    BEGIN
      SELECT id INTO user_id FROM users ORDER BY id LIMIT 1;
      INSERT INTO rental_fleet (brand, model, category, "serialNumber", "assetNumber", "currentStatus")
      VALUES ('QA', 'Protected Rolling Unit', 'QA', 'ROLL-PROTECTED-1', 'ROLL-001', 'rented')
      RETURNING id INTO fleet_id;

      INSERT INTO rental_requests (
        "rentalFleetId", "customerName", "customerPhone", "startDate", "endDate", status,
        "deliveryMethod", "insuranceType", "rentalFee", "freightCost", "insuranceCost",
        "taxAmount", "depositAmount", "totalAmount", "rentalNumber"
      ) VALUES (
        fleet_id, 'Protected Rolling Customer', '4165550122', '2026-07-01', '2026-07-29', 'active',
        'pickup', 'basic', 2800, 0, 420, 418.60, 0, 3638.60, 'QA-ROLL-MIG-001'
      ) RETURNING id INTO rental_id;

      INSERT INTO rental_line_items ("rentalRequestId", "rentalFleetId", quantity, "dailyRate", "lineSubtotal")
      VALUES (rental_id, fleet_id, 1, 100, 2800);
      INSERT INTO inspections (type, "rentalId", "rentalFleetId", "overallCondition")
      VALUES ('dispatch', rental_id, fleet_id, 'good');
      INSERT INTO invoices ("invoiceNumber", "rentalId", subtotal, "taxAmount", "totalAmount", "balanceDue")
      VALUES ('QA-ROLL-INV-001', rental_id, 3220, 418.60, 3638.60, 3638.60)
      RETURNING id INTO invoice_id;
      INSERT INTO invoice_line_items ("invoiceId", description, quantity, "unitPrice", amount)
      VALUES (invoice_id, 'Protected rolling base', 1, 3220, 3220);
      INSERT INTO rental_charges ("rentalRequestId", "chargeType", amount, description)
      VALUES (rental_id, 'adjustment', 25, 'Protected charge');
      INSERT INTO rental_prepayments ("rentalRequestId", amount, "paymentMethod")
      VALUES (rental_id, 100, 'cash');
      INSERT INTO rental_asset_progress_events (
        "eventKey", "rentalRequestId", "rentalFleetId", "eventType", source, "actorUserId"
      ) VALUES ('protected:rolling:migration', rental_id, fleet_id, 'entry_pending', 'admin_web', user_id);
    END $$
  `);

  const flagsBefore = fingerprint("feature_flags");
  const before = protectedFingerprints();
  psqlFile("sql/145_open_ended_renewal.sql");
  const afterFirst = migrationSnapshot();

  assert(JSON.stringify(afterFirst.protected) === JSON.stringify(before), "protected business-table fingerprint changed");
  assert(afterFirst.rollingTerms === 0, "migration created rolling terms for historical rentals");
  assert(afterFirst.returnOperations === 0, "migration created return operations for historical rentals");
  assert(afterFirst.flag === "rolling_renewal_operations=false", "feature flag was not seeded disabled");
  assert(fingerprint("feature_flags") !== flagsBefore, "rolling feature flag was not inserted");

  psqlFile("sql/145_open_ended_renewal.sql");
  const afterSecond = migrationSnapshot();
  assert(JSON.stringify(afterSecond) === JSON.stringify(afterFirst), "migration rerun was not idempotent");

  console.log(JSON.stringify({
    ok: true,
    database: dbName,
    protectedFingerprints: afterFirst.protected,
    newTablesEmpty: true,
    featureFlag: afterFirst.flag,
    schemaFingerprint: afterFirst.schema,
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
