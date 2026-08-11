import { sql, type SQL } from "drizzle-orm";
import { deriveRentalRollingListState } from "../../shared/rentalRollingListState";

export type DashboardRentalBucket =
  | "normal"
  | "rolling"
  | "renewal_review"
  | "awaiting_pickup"
  | "awaiting_inspection"
  | "customer_overdue";

export function deriveDashboardRentalBucket(input: {
  rentalStatus: string;
  rollingStatus: string | null;
  isCreditOrder?: boolean;
  endDate: Date;
  now?: Date;
  returnOperations: Array<{
    pickedUpAt: Date | null;
    responsibility: "none" | "company" | "customer";
  }>;
}): DashboardRentalBucket | null {
  if (input.rentalStatus !== "active" && input.rentalStatus !== "overdue") return null;
  if (input.rentalStatus === "overdue" && input.returnOperations.some((operation) => (
    !operation.pickedUpAt && operation.responsibility === "customer"
  ))) return "customer_overdue";
  if (input.returnOperations.some((operation) => !operation.pickedUpAt)) return "awaiting_pickup";
  if (input.returnOperations.length > 0) return "awaiting_inspection";
  if (input.rollingStatus === "active" || input.rollingStatus === "ending") return "rolling";
  if (deriveRentalRollingListState(input) === "candidate") return "renewal_review";
  return "normal";
}

/** SQL equivalent of deriveDashboardRentalBucket for aggregate dashboard counts. */
export function dashboardRentalBucketSql(
  rentalId: SQL,
  rentalStatus: SQL,
  endDate: SQL,
  isCreditOrder: SQL,
): SQL {
  return sql`
    CASE
      WHEN ${rentalStatus} NOT IN ('active', 'overdue') THEN NULL
      WHEN ${rentalStatus} = 'overdue' AND EXISTS (
        SELECT 1 FROM rental_asset_return_operations AS dashboard_customer_delay
        WHERE dashboard_customer_delay."rentalRequestId" = ${rentalId}
          AND dashboard_customer_delay."pickedUpAt" IS NULL
          AND dashboard_customer_delay."delayResponsibility" = 'customer'
      ) THEN 'customer_overdue'
      WHEN EXISTS (
        SELECT 1 FROM rental_asset_return_operations AS dashboard_unpicked
        WHERE dashboard_unpicked."rentalRequestId" = ${rentalId}
          AND dashboard_unpicked."pickedUpAt" IS NULL
      ) THEN 'awaiting_pickup'
      WHEN EXISTS (
        SELECT 1 FROM rental_asset_return_operations AS dashboard_return
        WHERE dashboard_return."rentalRequestId" = ${rentalId}
      ) THEN 'awaiting_inspection'
      WHEN EXISTS (
        SELECT 1 FROM rental_rolling_terms AS dashboard_rolling
        WHERE dashboard_rolling."rentalRequestId" = ${rentalId}
          AND dashboard_rolling.status IN ('active', 'ending')
      ) THEN 'rolling'
      WHEN ${endDate} < now()
        AND NOT coalesce(${isCreditOrder}, false)
        AND NOT EXISTS (
        SELECT 1 FROM rental_rolling_terms AS dashboard_any_rolling
        WHERE dashboard_any_rolling."rentalRequestId" = ${rentalId}
      ) THEN 'renewal_review'
      ELSE 'normal'
    END
  `;
}
