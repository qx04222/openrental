export type PlanningState = "available" | "reserved" | "conflict" | "maintenance" | "work_order" | "return" | "custody";
export interface PlanningBooking { rentalId: number; reference: string; fleetId: number; start: string; end: string; status: string }
export interface PlanningAsset { id: number; name: string; assetNumber: string; category: string; location: string; currentStatus: string; block?: "rental" | "return" | "work_order"; blockRefs: string[] }
export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
export function shiftPlanningDate(value: string, days: number): string {
  if (!isCalendarDate(value)) throw new Error("Invalid calendar date");
  const d = new Date(value + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function planningDays(start: string, count: number): string[] {
  if (![7, 14, 28].includes(count)) throw new Error("Invalid planning window");
  return Array.from({ length: count }, (_, i) => shiftPlanningDate(start, i));
}
export function buildPlanningRows(assets: PlanningAsset[], bookings: PlanningBooking[], days: string[], today: string) {
  const byFleet = new Map<number, PlanningBooking[]>();
  for (const b of bookings) byFleet.set(b.fleetId, [...(byFleet.get(b.fleetId) ?? []), b]);
  return assets.map(asset => {
    const assigned = byFleet.get(asset.id) ?? [];
    return { ...asset, days: days.map(date => {
      const matching = assigned.filter(b => b.start <= date && (b.end >= date || (["active", "overdue"].includes(b.status) && b.end < today && date >= today)));
      const rentals = [...new Map(matching.map(b => [b.rentalId, b])).values()];
      const overdue = rentals.some(b => ["active", "overdue"].includes(b.status) && b.end < today);
      let state: PlanningState = rentals.length > 1 ? "conflict" : rentals.length ? "reserved" : "available";
      if (asset.currentStatus === "maintenance") state = "maintenance";
      else if (asset.block === "work_order" || asset.block === "return") state = asset.block;
      else if ((asset.currentStatus === "rented" || asset.block === "rental") && !assigned.some(b => ["active", "overdue"].includes(b.status))) state = "custody";
      return { date, state, overdue, conflict: rentals.length > 1, rentals };
    }) };
  });
}
