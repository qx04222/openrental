import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, sql, isNull, isNotNull, desc, lte, and, gte, inArray, eq } from "../db";
import * as schema from "../../drizzle/schema";
import { zonedDayRangeUtc, APP_TIMEZONE_SQL } from "../_core/dateUtils";
import { fleetOperationalAvailabilityWhere } from "../services/fleetAvailability";
import { dashboardRentalBucketSql } from "../services/dashboardOperations";
import { getDashboardFinancials } from "../services/dashboardFinancials";

/** UTC instant bounds of "today" in Toronto. Thin wrapper over the shared helper. */
function torontoTodayRange(): { startUtc: Date; endUtc: Date; dateStr: string } {
  return zonedDayRangeUtc();
}

export const dashboardRouter = router({
  todaySchedule: protectedProcedure.use(moduleGuard('reports', 'read')).query(async () => {
    const db = await getDb();
    if (!db) {
      return {
        deliveriesDue: [],
        returnsDue: [],
        startingToday: [],
        endingToday: [],
      };
    }

    const { startUtc, endUtc } = torontoTodayRange();

    const [deliveriesDue, returnsDue, startingToday, endingToday] = await Promise.all([
      // Deliveries due today: startDate falls today, status approved or active
      db.select({
        id: schema.rentalRequests.id,
        rentalNumber: schema.rentalRequests.rentalNumber,
        customerName: schema.rentalRequests.customerName,
        deliveryAddress: schema.rentalRequests.deliveryAddress,
        scheduledDeliveryTime: schema.rentalRequests.scheduledDeliveryTime,
      })
        .from(schema.rentalRequests)
        .where(
          and(
            isNull(schema.rentalRequests.deletedAt),
            inArray(schema.rentalRequests.status, ["approved", "active"]),
            gte(schema.rentalRequests.startDate, startUtc),
            lte(schema.rentalRequests.startDate, endUtc),
          ),
        )
        .limit(20),

      // Returns due today: endDate falls today, status active
      db.select({
        id: schema.rentalRequests.id,
        rentalNumber: schema.rentalRequests.rentalNumber,
        customerName: schema.rentalRequests.customerName,
        endDate: schema.rentalRequests.endDate,
        fleetBrand: schema.rentalFleet.brand,
        fleetModel: schema.rentalFleet.model,
      })
        .from(schema.rentalRequests)
        .leftJoin(
          schema.rentalFleet,
          and(
            eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id),
            isNull(schema.rentalFleet.deletedAt),
          ),
        )
        .where(
          and(
            isNull(schema.rentalRequests.deletedAt),
            inArray(schema.rentalRequests.status, ["active"]),
            gte(schema.rentalRequests.endDate, startUtc),
            lte(schema.rentalRequests.endDate, endUtc),
          ),
        )
        .limit(20),

      // Starting today: open work only; terminal rentals stay in history/activity.
      db.select({
        id: schema.rentalRequests.id,
        rentalNumber: schema.rentalRequests.rentalNumber,
        customerName: schema.rentalRequests.customerName,
        startDate: schema.rentalRequests.startDate,
      })
        .from(schema.rentalRequests)
        .where(
          and(
            isNull(schema.rentalRequests.deletedAt),
            inArray(schema.rentalRequests.status, ["pending", "approved", "active", "overdue"]),
            gte(schema.rentalRequests.startDate, startUtc),
            lte(schema.rentalRequests.startDate, endUtc),
          ),
        )
        .limit(20),

      // Ending today: open work only; completed/cancelled/rejected need no action.
      db.select({
        id: schema.rentalRequests.id,
        rentalNumber: schema.rentalRequests.rentalNumber,
        customerName: schema.rentalRequests.customerName,
        endDate: schema.rentalRequests.endDate,
      })
        .from(schema.rentalRequests)
        .where(
          and(
            isNull(schema.rentalRequests.deletedAt),
            inArray(schema.rentalRequests.status, ["pending", "approved", "active", "overdue"]),
            gte(schema.rentalRequests.endDate, startUtc),
            lte(schema.rentalRequests.endDate, endUtc),
          ),
        )
        .limit(20),
    ]);

    return { deliveriesDue, returnsDue, startingToday, endingToday };
  }),

  stats: protectedProcedure.use(moduleGuard('reports', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return null;
    const fleetAvailable = fleetOperationalAvailabilityWhere();
    const rentalBucket = dashboardRentalBucketSql(
      sql`${schema.rentalRequests.id}`,
      sql`${schema.rentalRequests.status}`,
      sql`${schema.rentalRequests.endDate}`,
      sql`${schema.rentalRequests.isCreditOrder}`,
    );

    // Run all count queries in parallel
    const [fleetStats, rentalStats, inspectionCount, dispatchCount, recentRentals, recentDispatches, financials] = await Promise.all([
      // Fleet counts (+ `missingCost` for the ROI-tracking banner)
      db.select({
        total: sql<number>`count(*)::int`,
        available: sql<number>`count(*) filter (where ${fleetAvailable})::int`,
        statusMismatch: sql<number>`count(*) filter (where ${schema.rentalFleet.currentStatus} = 'available' AND NOT (${fleetAvailable}))::int`,
        missingCost: sql<number>`count(*) filter (where ${schema.rentalFleet.purchaseCost} IS NULL OR ${schema.rentalFleet.purchaseCost}::numeric = 0)::int`,
      }).from(schema.rentalFleet).where(isNull(schema.rentalFleet.deletedAt)),

      // Rental counts + revenue. `revenue` is the pure net rental income
      // (rentalFee only) — insurance, freight, tax and deposit are all
      // surfaced separately as their own lines, not folded into net revenue.
      db.select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) filter (where ${schema.rentalRequests.status} = 'pending')::int`,
        active: sql<number>`count(*) filter (where ${schema.rentalRequests.status} = 'active')::int`,
        ongoing: sql<number>`count(*) filter (where ${schema.rentalRequests.status} IN ('active', 'overdue'))::int`,
        normal: sql<number>`count(*) filter (where (${rentalBucket}) = 'normal')::int`,
        rolling: sql<number>`count(*) filter (where (${rentalBucket}) = 'rolling')::int`,
        renewalReview: sql<number>`count(*) filter (where (${rentalBucket}) = 'renewal_review')::int`,
        awaitingPickup: sql<number>`count(*) filter (where (${rentalBucket}) = 'awaiting_pickup')::int`,
        awaitingInspection: sql<number>`count(*) filter (where (${rentalBucket}) = 'awaiting_inspection')::int`,
        customerOverdue: sql<number>`count(*) filter (where (${rentalBucket}) = 'customer_overdue')::int`,
        revenue: sql<number>`coalesce(sum(case when ${schema.rentalRequests.status} in ('completed', 'active') then coalesce(${schema.rentalRequests.rentalFee}::numeric, 0) else 0 end), 0)`,
        freight: sql<number>`coalesce(sum(case when ${schema.rentalRequests.status} in ('completed', 'active') then coalesce(${schema.rentalRequests.freightCost}::numeric, 0) else 0 end), 0)`,
        insurance: sql<number>`coalesce(sum(case when ${schema.rentalRequests.status} in ('completed', 'active') then coalesce(${schema.rentalRequests.insuranceCost}::numeric, 0) else 0 end), 0)`,
        // Pipeline figures — orders accepted but not yet active/completed
        // (pending + approved). Dead states (rejected/cancelled) excluded.
        // Net rental income, insurance and freight are each surfaced
        // separately, mirroring the realized lines above.
        pendingRevenue: sql<number>`coalesce(sum(case when ${schema.rentalRequests.status} in ('pending', 'approved') then coalesce(${schema.rentalRequests.rentalFee}::numeric, 0) else 0 end), 0)`,
        pendingInsurance: sql<number>`coalesce(sum(case when ${schema.rentalRequests.status} in ('pending', 'approved') then coalesce(${schema.rentalRequests.insuranceCost}::numeric, 0) else 0 end), 0)`,
        pendingFreight: sql<number>`coalesce(sum(case when ${schema.rentalRequests.status} in ('pending', 'approved') then coalesce(${schema.rentalRequests.freightCost}::numeric, 0) else 0 end), 0)`,
      }).from(schema.rentalRequests).where(isNull(schema.rentalRequests.deletedAt)),

      // Inspection count
      db.select({
        total: sql<number>`count(*)::int`,
      }).from(schema.inspections).where(isNull(schema.inspections.deletedAt)),

      // Dispatch count
      db.select({
        total: sql<number>`count(*)::int`,
      }).from(schema.dispatchOrders).where(isNull(schema.dispatchOrders.deletedAt)),

      // Recent rentals (top 5)
      db.select({
        id: schema.rentalRequests.id,
        rentalNumber: schema.rentalRequests.rentalNumber,
        customerName: schema.rentalRequests.customerName,
        status: schema.rentalRequests.status,
        createdAt: schema.rentalRequests.createdAt,
      }).from(schema.rentalRequests)
        .where(isNull(schema.rentalRequests.deletedAt))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(5),

      // Recent dispatches (top 5)
      db.select({
        id: schema.dispatchOrders.id,
        orderType: schema.dispatchOrders.orderType,
        status: schema.dispatchOrders.status,
        createdAt: schema.dispatchOrders.createdAt,
      }).from(schema.dispatchOrders)
        .where(isNull(schema.dispatchOrders.deletedAt))
        .orderBy(desc(schema.dispatchOrders.createdAt))
        .limit(5),

      getDashboardFinancials(db),
    ]);

    // CRM stats — run in parallel with rest
    const [customerStats, followUps] = await Promise.all([
      // Customer CRM stats
      db.select({
        totalCustomers: sql<number>`count(*)::int`,
        returningCustomers: sql<number>`count(*) filter (where ${schema.customers.totalRentals} > 1)::int`,
        newThisMonth: sql<number>`count(*) filter (where ((${schema.customers.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}) >= date_trunc('month', now() AT TIME ZONE ${APP_TIMEZONE_SQL}))::int`,
      }).from(schema.customers).where(isNull(schema.customers.deletedAt)),

      // Overdue follow-ups (top 5)
      db.select({
        id: schema.customers.id,
        name: schema.customers.name,
        nextFollowUp: schema.customers.nextFollowUp,
        followUpNotes: schema.customers.followUpNotes,
        totalRentals: schema.customers.totalRentals,
      }).from(schema.customers)
        .where(and(
          isNull(schema.customers.deletedAt),
          isNotNull(schema.customers.nextFollowUp),
          lte(schema.customers.nextFollowUp, new Date()),
        ))
        .orderBy(schema.customers.nextFollowUp)
        .limit(5),
    ]);

    return {
      fleet: {
        total: fleetStats[0]?.total ?? 0,
        available: fleetStats[0]?.available ?? 0,
        statusMismatch: fleetStats[0]?.statusMismatch ?? 0,
        missingCost: fleetStats[0]?.missingCost ?? 0,
      },
      rentals: {
        total: rentalStats[0]?.total ?? 0,
        pending: rentalStats[0]?.pending ?? 0,
        active: rentalStats[0]?.active ?? 0,
        ongoing: rentalStats[0]?.ongoing ?? 0,
        normal: rentalStats[0]?.normal ?? 0,
        rolling: rentalStats[0]?.rolling ?? 0,
        renewalReview: rentalStats[0]?.renewalReview ?? 0,
        awaitingPickup: rentalStats[0]?.awaitingPickup ?? 0,
        awaitingInspection: rentalStats[0]?.awaitingInspection ?? 0,
        customerOverdue: rentalStats[0]?.customerOverdue ?? 0,
        revenue: Number(rentalStats[0]?.revenue ?? 0),
        freight: Number(rentalStats[0]?.freight ?? 0),
        insurance: Number(rentalStats[0]?.insurance ?? 0),
        pendingRevenue: Number(rentalStats[0]?.pendingRevenue ?? 0),
        pendingInsurance: Number(rentalStats[0]?.pendingInsurance ?? 0),
        pendingFreight: Number(rentalStats[0]?.pendingFreight ?? 0),
      },
      financials,
      inspections: inspectionCount[0]?.total ?? 0,
      dispatches: dispatchCount[0]?.total ?? 0,
      recentRentals,
      recentDispatches,
      crm: {
        totalCustomers: customerStats[0]?.totalCustomers ?? 0,
        returningCustomers: customerStats[0]?.returningCustomers ?? 0,
        newThisMonth: customerStats[0]?.newThisMonth ?? 0,
        returningRate: customerStats[0]?.totalCustomers
          ? Math.round(((customerStats[0]?.returningCustomers ?? 0) / customerStats[0].totalCustomers) * 100)
          : 0,
        overdueFollowUps: followUps,
      },
    };
  }),
});
