/**
 * One-time backfill of rental_requests.deliveryDistanceKm for existing delivery
 * orders, using the SAME engine order creation uses (quoteMultiItem → Google Maps
 * one-way warehouse→address distance). Needs GOOGLE_MAPS_API_KEY + DATABASE_URL.
 *
 *   Dry run:  GOOGLE_MAPS_API_KEY=... npx tsx scripts/backfill-delivery-distance.ts
 *   Commit:   GOOGLE_MAPS_API_KEY=... npx tsx scripts/backfill-delivery-distance.ts --commit
 */
import { getDb, eq, and, isNull, sql } from "../server/db";
import * as schema from "../drizzle/schema";

async function main() {
  const commit = process.argv.includes("--commit");
  const db = await getDb();
  if (!db) throw new Error("no db");
  const { quoteMultiItem } = await import("../server/services/multiItemPricing");

  // Delivery orders with an address but no distance yet.
  const orders = await db.execute(sql`
    SELECT id, "rentalFleetId", "deliveryMethod", "deliveryAddress",
           "taxProvince", "deliveryProvince", "startDate", "endDate"
    FROM rental_requests
    WHERE "deletedAt" IS NULL
      AND "deliveryMethod" IN ('delivery', 'delivery_and_return')
      AND COALESCE("deliveryAddress", '') <> ''
      AND "deliveryDistanceKm" IS NULL
    ORDER BY id
  `) as unknown as Record<string, unknown>[];

  console.log(`候选送货单(有地址、缺距离): ${orders.length}`);
  let ok = 0, skip = 0, fail = 0;

  for (const o of orders) {
    const id = Number(o.id);
    // Resolve a fleet id (single order → rentalFleetId; multi → first line item).
    let fleetIds: number[] = o.rentalFleetId ? [Number(o.rentalFleetId)] : [];
    if (fleetIds.length === 0) {
      const lines = await db.select({ fleetId: schema.rentalLineItems.rentalFleetId })
        .from(schema.rentalLineItems)
        .where(and(eq(schema.rentalLineItems.rentalRequestId, id), isNull(schema.rentalLineItems.deletedAt)));
      fleetIds = lines.map((l) => l.fleetId).filter((x): x is number => x != null);
    }
    if (fleetIds.length === 0) { console.log(`  #${id}: 无可用 fleet,跳过`); skip++; continue; }

    try {
      const quote = await quoteMultiItem(db, {
        startDate: new Date(o.startDate as string).toISOString().slice(0, 10),
        endDate: new Date(o.endDate as string).toISOString().slice(0, 10),
        deliveryMethod: o.deliveryMethod as "delivery" | "delivery_and_return",
        deliveryAddress: String(o.deliveryAddress),
        taxProvince: (o.taxProvince || o.deliveryProvince || "ON") as string,
        insuranceType: "none",
        items: [{ equipmentModelId: null, fleetIds: [fleetIds[0]], itemType: "machine", quantity: 1 }],
      });
      const km = quote.deliveryDistanceKm;
      if (km == null) { console.log(`  #${id}: 距离算不出(地址无法解析),跳过`); skip++; continue; }
      console.log(`  #${id}: ${km} km${commit ? " → 写入" : " (dry-run)"}`);
      if (commit) {
        await db.update(schema.rentalRequests)
          .set({ deliveryDistanceKm: km.toFixed(2), updatedAt: new Date() })
          .where(eq(schema.rentalRequests.id, id));
      }
      ok++;
    } catch (e) {
      console.log(`  #${id}: 失败 ${e instanceof Error ? e.message : e}`);
      fail++;
    }
  }

  console.log(`\n结果: 成功 ${ok} / 跳过 ${skip} / 失败 ${fail}${commit ? "" : "  (dry-run,加 --commit 才写库)"}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
