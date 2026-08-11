import { z } from "zod";
import { router, publicProcedure } from "../_core/trpc";
import { getDb, and, gte, lte, isNull, inArray } from "../db";
import * as schema from "../../drizzle/schema";
import { calendarDateStringInTimeZone } from "../_core/dateUtils";
import { BOOKING_OCCUPYING_STATUSES } from "../services/rentalStatusSync";

export const availabilityRouter = router({
  getCalendar: publicProcedure
    .input(
      z.object({
        // Single fleet (legacy callers).
        fleetId: z.number().optional(),
        // Whole-group view: pool of fleet IDs of the same model. A day is
        // "available" as long as at least one unit in the pool is free.
        // When provided, fleetId is ignored.
        fleetIds: z.array(z.number()).optional(),
        year: z.number(),
        month: z.number().min(1).max(12),
      }).refine(
        (v) => !!v.fleetId || (v.fleetIds && v.fleetIds.length > 0),
        { message: "Either fleetId or fleetIds is required" },
      )
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const { year, month } = input;
      const ids = input.fleetIds && input.fleetIds.length > 0
        ? input.fleetIds
        : (input.fleetId ? [input.fleetId] : []);
      if (ids.length === 0) return [];

      // Generous UTC pre-filter window (month ± 2 days). The precise per-day
      // membership test below runs on Toronto calendar dates, so this SQL
      // bound only needs to be a superset — being loose avoids dropping any
      // rental whose Toronto-midnight instant sits a few hours off the UTC edge.
      const firstDay = new Date(Date.UTC(year, month - 1, 1) - 2 * 86_400_000);
      const lastDay = new Date(Date.UTC(year, month, 0) + 2 * 86_400_000);

      // Pull statuses for all fleet units in the pool
      const fleets = await db
        .select({ id: schema.rentalFleet.id, currentStatus: schema.rentalFleet.currentStatus })
        .from(schema.rentalFleet)
        .where(and(inArray(schema.rentalFleet.id, ids), isNull(schema.rentalFleet.deletedAt)));

      if (fleets.length === 0) return [];

      // A unit is "out" for the whole month if maintenance or retired
      const permanentlyOut = new Set(
        fleets
          .filter(f => f.currentStatus === "maintenance" || f.currentStatus === "retired")
          .map(f => f.id),
      );
      const liveIds = fleets.filter(f => !permanentlyOut.has(f.id)).map(f => f.id);
      const totalUnits = fleets.length;

      // Overlapping rental requests for any unit in the pool, in this month
      const overlapping = liveIds.length === 0 ? [] : await db
        .select({
          rentalFleetId: schema.rentalRequests.rentalFleetId,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
        })
        .from(schema.rentalRequests)
        .where(
          and(
            inArray(schema.rentalRequests.rentalFleetId, liveIds),
            isNull(schema.rentalRequests.deletedAt),
            inArray(schema.rentalRequests.status, BOOKING_OCCUPYING_STATUSES),
            lte(schema.rentalRequests.startDate, lastDay),
            gte(schema.rentalRequests.endDate, firstDay)
          )
        );

      // Days in the target month — pure calendar arithmetic, TZ-independent.
      const daysInMonth = new Date(year, month, 0).getDate();
      const result: Array<{ date: string; status: "available" | "booked" | "maintenance" }> = [];

      // Each overlapping rental's span as Toronto calendar dates, computed once.
      const spans = overlapping
        .filter((r) => r.rentalFleetId !== null)
        .map((r) => ({
          fleetId: r.rentalFleetId as number,
          startStr: calendarDateStringInTimeZone(new Date(r.startDate)),
          endStr: calendarDateStringInTimeZone(new Date(r.endDate)),
        }));

      for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

        // A unit is booked on this day if the day falls within its Toronto span.
        // ISO date strings compare lexicographically, so no Date math needed.
        const bookedIds = new Set<number>();
        for (const s of spans) {
          if (dateStr >= s.startStr && dateStr <= s.endStr) {
            bookedIds.add(s.fleetId);
          }
        }

        const unavailable = bookedIds.size + permanentlyOut.size;
        if (unavailable >= totalUnits) {
          // All units gone — distinguish whole-fleet maintenance from "all booked"
          result.push({
            date: dateStr,
            status: permanentlyOut.size === totalUnits ? "maintenance" : "booked",
          });
        } else {
          result.push({ date: dateStr, status: "available" });
        }
      }

      return result;
    }),
});
