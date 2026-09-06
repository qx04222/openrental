import type { QueryClient } from "@tanstack/react-query";
const writers = new Set(["rentals", "rentalFleet", "rentalPrepayments", "payments", "rentalCharges", "inspections", "dispatch", "invoices", "workOrders", "damageClaims", "extensionRequests", "rentalAssetProgress", "rollingRentals", "collections", "customerCredit", "recycleBin", "equipmentModels", "customers"]);
const readers = new Set(["dashboard.stats", "dashboard.todaySchedule", "reports.internalWorkQueue", "reports.operationalHealth", "planning.timeline", "operations.status"]);
export function procedureFromKey(key: readonly unknown[] | undefined): string {
  return Array.isArray(key?.[0]) ? key[0].filter(v => typeof v === "string").join(".") : "";
}
export function shouldRefreshOperations(key: readonly unknown[] | undefined): boolean {
  return writers.has(procedureFromKey(key).split(".")[0]);
}
export function createOperationalRefresh(client: QueryClient, delayMs = 150) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    // Coalesce a batch of successful writes into one refresh of active views.
    timer = setTimeout(() => { void client.invalidateQueries({ predicate: query => readers.has(procedureFromKey(query.queryKey)) }); }, delayMs);
  };
}
