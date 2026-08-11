import "dotenv/config";
import { getDb, eq, and, isNull, sql } from "../server/db";
import * as schema from "../drizzle/schema";

/**
 * One-off: recompute totalRentals / totalRevenue / lastRentalDate for every non-deleted customer.
 *
 * Context: a bug in refreshCustomerCounters (fixed in rentalRequests.router.ts) caused
 * `value.toISOString is not a function` when writing lastRentalDate from a raw SQL max().
 * Customers whose counters were last touched during the bug window have stale values.
 *
 * Usage: tsx scripts/refresh-customer-counters.ts
 */

async function main() {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable — check DATABASE_URL");

  const customers = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(isNull(schema.customers.deletedAt));

  console.log(`Refreshing counters for ${customers.length} customers...`);

  let ok = 0;
  let failed = 0;

  for (const { id } of customers) {
    try {
      const [stats] = await db
        .select({
          cnt: sql<number>`count(*)::int`,
          rev: sql<string>`coalesce(sum(${schema.rentalRequests.totalAmount}::numeric), 0)`,
          lastDate: sql<Date | null>`max(${schema.rentalRequests.createdAt})`,
        })
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.customerId, id),
          isNull(schema.rentalRequests.deletedAt),
        ));

      if (!stats) continue;

      const lastDate = stats.lastDate ? new Date(stats.lastDate as unknown as string) : null;
      await db.update(schema.customers).set({
        totalRentals: stats.cnt,
        totalRevenue: stats.rev,
        lastRentalDate: lastDate,
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, id));

      ok++;
    } catch (err) {
      failed++;
      console.error(`  customer ${id}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Done. ${ok} refreshed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
