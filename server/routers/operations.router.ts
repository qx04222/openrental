import { TRPCError } from "@trpc/server";
import { router, superAdminProcedure } from "../_core/trpc";
import { getDb, sql } from "../db";
import { getScheduledJobStates } from "../services/scheduledJobs";
import { APP_TIMEZONE } from "../_core/dateUtils";
import pkg from "../../package.json";
const startedAt = new Date().toISOString();
export const operationsRouter = router({
  status: superAdminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Operations data unavailable" });
    const counts = await db.execute(sql`SELECT e.status, count(*)::int AS count FROM rental_lifecycle_effects e JOIN rental_requests r ON r.id = e."rentalRequestId" WHERE r."deletedAt" IS NULL GROUP BY e.status`);
    const pending = await db.execute(sql`
      SELECT e.id, e."rentalRequestId", e."effectType", e.status, e.attempts, e."nextAttemptAt", e."updatedAt",
        COALESCE(r."rentalNumber", '#' || r.id) AS reference
      FROM rental_lifecycle_effects e JOIN rental_requests r ON r.id = e."rentalRequestId"
      WHERE e.status IN ('pending', 'failed', 'manual_review', 'processing') AND r."deletedAt" IS NULL
      ORDER BY CASE WHEN e.status = 'manual_review' THEN 0 WHEN e.status = 'failed' THEN 1 ELSE 2 END, e."updatedAt" ASC LIMIT 100
    `);
    return { version: pkg.version, revision: process.env.APP_REVISION || process.env.RAILWAY_GIT_COMMIT_SHA || "local", startedAt, timezone: APP_TIMEZONE, generatedAt: new Date().toISOString(), jobs: getScheduledJobStates(), counts: counts.map(r => ({ status: String(r.status), count: Number(r.count) })), effects: pending.map(r => ({ id: Number(r.id), rentalId: Number(r.rentalRequestId), reference: String(r.reference), effectType: String(r.effectType), status: String(r.status), attempts: Number(r.attempts), nextAttemptAt: r.nextAttemptAt ? String(r.nextAttemptAt) : null, updatedAt: String(r.updatedAt) })) };
  }),
});
