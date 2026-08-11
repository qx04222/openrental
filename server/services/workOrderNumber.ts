import { getDb, desc, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { calendarPartsInTimeZone } from "../_core/dateUtils";

/** Next WO-YYYY-NNNN number (Toronto calendar year, per-year sequence). */
export async function getNextWorkOrderNumber(): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const year = calendarPartsInTimeZone(new Date()).year;
  const prefix = `WO-${year}-`;
  const [last] = await db
    .select({ workOrderNumber: schema.workOrders.workOrderNumber })
    .from(schema.workOrders)
    .where(sql`${schema.workOrders.workOrderNumber} LIKE ${prefix + '%'}`)
    .orderBy(desc(schema.workOrders.workOrderNumber))
    .limit(1);
  let seq = 1;
  if (last?.workOrderNumber) {
    const parts = last.workOrderNumber.split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
