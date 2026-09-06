import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, sql } from "../db";
import { APP_TIMEZONE, calendarDateStringInTimeZone, parseCalendarDate } from "../_core/dateUtils";
import { buildPlanningRows, isCalendarDate, planningDays, shiftPlanningDate, type PlanningBooking } from "../../shared/planning";

export const planningRouter = router({
  timeline: protectedProcedure.use(moduleGuard("fleet", "read")).use(moduleGuard("rentals", "read"))
    .input(z.object({ start: z.string().refine(isCalendarDate, "Invalid date"), days: z.union([z.literal(7), z.literal(14), z.literal(28)]) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Planning data unavailable" });
      const days = planningDays(input.start, input.days);
      const start = parseCalendarDate(input.start), until = parseCalendarDate(shiftPlanningDate(input.start, input.days));
      const fleet = await db.execute(sql`
        SELECT f.id, f.brand || ' ' || f.model AS name, COALESCE(f."assetNumber", '#' || f.id) AS "assetNumber",
          COALESCE(f.category, '') AS category, COALESCE(w.name, '') AS location, f."currentStatus"
        FROM rental_fleet f LEFT JOIN warehouses w ON w.id = f."locationId" AND w."deletedAt" IS NULL
        WHERE f."deletedAt" IS NULL AND f."currentStatus" <> 'retired' ORDER BY f.brand, f.model, f.id LIMIT 1001
      `);
      if (fleet.length > 1000) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Planning supports up to 1000 active assets" });
      const assigned = await db.execute(sql`
        WITH assignments AS (
          SELECT r.id AS "rentalId", COALESCE(r."rentalNumber", '#' || r.id) AS reference,
            r."rentalFleetId" AS "fleetId", r."startDate" AS start, r."endDate" AS "end", r.status
          FROM rental_requests r WHERE r."deletedAt" IS NULL AND r."rentalFleetId" IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM rental_line_items li WHERE li."rentalRequestId" = r.id AND li."rentalFleetId" = r."rentalFleetId" AND li."deletedAt" IS NULL)
          UNION ALL
          SELECT r.id, COALESCE(r."rentalNumber", '#' || r.id), li."rentalFleetId",
            COALESCE(li."startDate", r."startDate"), COALESCE(li."endDate", r."endDate"), r.status
          FROM rental_line_items li JOIN rental_requests r ON r.id = li."rentalRequestId"
          WHERE li."deletedAt" IS NULL AND r."deletedAt" IS NULL AND li."rentalFleetId" IS NOT NULL
        ) SELECT "rentalId", reference, "fleetId", status,
          to_char(start AT TIME ZONE 'UTC' AT TIME ZONE ${APP_TIMEZONE}, 'YYYY-MM-DD') AS start,
          to_char("end" AT TIME ZONE 'UTC' AT TIME ZONE ${APP_TIMEZONE}, 'YYYY-MM-DD') AS "end"
          FROM assignments WHERE status IN ('pending', 'approved', 'active', 'overdue')
          AND ((start < ${until.toISOString()}::timestamp AND "end" >= ${start.toISOString()}::timestamp) OR status IN ('active', 'overdue'))
      `);
      // A dated rental must never hide an undated operational hold in a forecast.
      const holds = await db.execute(sql`
        SELECT o."rentalFleetId" AS "fleetId", 'return' AS reason, COALESCE(r."rentalNumber", '#' || r.id) AS ref
        FROM rental_asset_return_operations o JOIN rental_requests r ON r.id = o."rentalRequestId"
        WHERE r."deletedAt" IS NULL AND r.status NOT IN ('completed', 'cancelled', 'rejected')
        UNION ALL
        SELECT "rentalFleetId", 'work_order', "workOrderNumber" FROM work_orders
        WHERE "deletedAt" IS NULL AND status NOT IN ('completed', 'cancelled')
      `);
      const blocks = new Map<number, { reason: "return" | "work_order"; refs: string[] }>();
      for (const hold of holds) {
        if (!hold.fleetId) continue;
        const id = Number(hold.fleetId), reason = hold.reason === "return" ? "return" : "work_order";
        const previous = blocks.get(id);
        blocks.set(id, { reason: previous?.reason === "return" ? "return" : reason, refs: [...new Set([...(previous?.refs ?? []), String(hold.ref)])] });
      }
      const assets = fleet.map(f => ({ id: Number(f.id), name: String(f.name), assetNumber: String(f.assetNumber), category: String(f.category), location: String(f.location), currentStatus: String(f.currentStatus), block: blocks.get(Number(f.id))?.reason, blockRefs: blocks.get(Number(f.id))?.refs ?? [] }));
      const bookings: PlanningBooking[] = assigned.map(b => ({ rentalId: Number(b.rentalId), reference: String(b.reference), fleetId: Number(b.fleetId), start: String(b.start), end: String(b.end), status: String(b.status) }));
      const today = calendarDateStringInTimeZone(new Date());
      return { today, timezone: APP_TIMEZONE, days, rows: buildPlanningRows(assets, bookings, days, today), generatedAt: new Date().toISOString() };
    }),
});
