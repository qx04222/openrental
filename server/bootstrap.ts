import "dotenv/config";
import { DEFAULT_FEATURE_FLAGS } from "../shared/defaultFeatureFlags";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import bcrypt from "bcrypt";
import { logger } from "./_core/logger";

/** Only bootstrap an empty database. An existing business database is never seeded. */
export async function bootstrap() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: "prefer", connect_timeout: 15 });
  try {
    await sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(741092001)`;
      const [exists] = await tx`SELECT to_regclass('public.users') AS users`;
      if (exists.users) {
        logger.info("bootstrap.existing_database", { action: "preserved" });
        return;
      }
      const [tables] = await tx`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'`;
      if (tables.count) throw new Error("Refusing bootstrap: database is not empty and users table is absent");
      const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
      if (!password || password.length < 20) throw new Error("Empty database requires BOOTSTRAP_ADMIN_PASSWORD with at least 20 characters");
      const username = process.env.BOOTSTRAP_ADMIN_USERNAME || "admin";
      const hash = await bcrypt.hash(password, 12);
      await tx.unsafe(readFileSync(new URL("../sql/000_baseline.sql", import.meta.url), "utf8"));
      await tx`INSERT INTO users (username, name, "passwordHash", role) VALUES (${username}, 'OpenRental Admin', ${hash}, 'super_admin')`;
      await tx`INSERT INTO site_settings (key, value) VALUES ('company_name', 'OpenRental'), ('tagline', 'Equipment rental, run properly') ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO feature_flags ${tx(DEFAULT_FEATURE_FLAGS)} ON CONFLICT (key) DO NOTHING`;
      logger.info("bootstrap.initialized", { demoAccounts: false });
    });
  } finally { await sql.end(); }
}

bootstrap().catch(() => {
  logger.error("bootstrap.failed", { message: "Database unavailable, non-empty schema, or bootstrap password missing. Check deployment configuration." });
  process.exitCode = 1;
});
