#!/usr/bin/env node
/**
 * One-shot migration runner for sql/078..083.
 *
 * Usage:
 *   node scripts/run-migrations.mjs           # dry-run, prints per-file SQL
 *   node scripts/run-migrations.mjs --apply   # actually execute against $DATABASE_URL
 *
 * Reads each file, splits on top-level semicolons (simple heuristic — these
 * migrations have no DO blocks or CREATE FUNCTION bodies, so semicolons are
 * safe statement separators), and runs each statement with `postgres`.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const FILES = [
  "sql/078_feature_flags.sql",
  "sql/079_rental_renewal.sql",
  "sql/080_late_fee_settings.sql",
  "sql/081_customer_credit.sql",
  "sql/082_customer_greetings.sql",
  "sql/083_signature_evidence.sql",
];

const APPLY = process.argv.includes("--apply");

function splitStatements(sql) {
  // Strip line comments; keep block comments intact (none in our files).
  const stripped = sql.replace(/^\s*--.*$/gm, "").trim();
  return stripped
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set. Create .env with DATABASE_URL=postgres://...");
    process.exit(1);
  }

  console.log(APPLY ? "APPLY mode — will execute against DB" : "DRY RUN — use --apply to execute");
  console.log(`DB: ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);
  console.log("");

  for (const rel of FILES) {
    const full = resolve(ROOT, rel);
    if (!existsSync(full)) {
      console.log(`SKIP ${rel} — file not found`);
      continue;
    }
    const sql = readFileSync(full, "utf8");
    const statements = splitStatements(sql);
    console.log(`── ${rel} — ${statements.length} statement(s)`);
    for (const s of statements) {
      const preview = s.replace(/\s+/g, " ").slice(0, 100);
      console.log(`   · ${preview}${s.length > 100 ? "…" : ""}`);
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("Dry run complete. Re-run with --apply to execute.");
    return;
  }

  const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    prepare: false,
    idle_timeout: 10,
    connect_timeout: 30,
  });

  try {
    for (const rel of FILES) {
      const full = resolve(ROOT, rel);
      if (!existsSync(full)) continue;
      const content = readFileSync(full, "utf8");
      const statements = splitStatements(content);
      console.log(`▶ ${rel} (${statements.length} statements)`);
      for (const stmt of statements) {
        try {
          await sql.unsafe(stmt);
          process.stdout.write(".");
        } catch (err) {
          console.error(`\n✗ Statement failed: ${stmt.slice(0, 200)}…`);
          console.error(`  ${err.message}`);
          throw err;
        }
      }
      console.log(` ✓`);
    }
    console.log("\nAll migrations applied.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
