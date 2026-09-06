import { describe, expect, it } from "vitest";
import { buildPlanningRows, isCalendarDate, planningDays, type PlanningAsset, type PlanningBooking } from "../shared/planning";
import { decodePlanningViews, planningStorageKey } from "../client/src/lib/planningViews";
const asset: PlanningAsset = { id: 1, name: "Excavator", assetNumber: "EX-1", category: "", location: "", currentStatus: "available", blockRefs: [] };
const booking: PlanningBooking = { rentalId: 8, reference: "R8", fleetId: 1, start: "2026-09-05", end: "2026-09-06", status: "approved" };
const days = planningDays("2026-09-06", 7);
describe("equipment planning rules", () => {
 it("rejects calendar overflow and crosses DST using calendar days", () => {
  expect(isCalendarDate("2026-02-30")).toBe(false);
  expect(planningDays("2026-03-07",7).slice(0,3)).toEqual(["2026-03-07","2026-03-08","2026-03-09"]);
 });
 it("includes the last rental day and frees a future day after an ordinary reservation", () => {
  const [row] = buildPlanningRows([asset], [booking], days, "2026-09-06");
  expect(row.days.slice(0,2).map(d => d.state)).toEqual(["reserved","available"]);
 });
 it("extends overdue custody until an actual return, beyond the promised end", () => {
  const [row] = buildPlanningRows([asset], [{...booking,status:"active",end:"2026-09-05"}], days, "2026-09-06");
  expect(row.days.every(d => d.state === "reserved" && d.overdue)).toBe(true);
 });
 it("deduplicates parent/line references but detects distinct overlapping orders", () => {
  expect(buildPlanningRows([asset], [booking,booking], days,"2026-09-06")[0].days[0].conflict).toBe(false);
  expect(buildPlanningRows([asset], [booking,{...booking,rentalId:9}], days,"2026-09-06")[0].days[0].conflict).toBe(true);
 });
 it("retains maintenance and return holds even when dates appear free", () => {
  for(const blocked of [{...asset,currentStatus:"maintenance"},{...asset,block:"return" as const},{...asset,block:"work_order" as const}]) expect(buildPlanningRows([blocked],[],days,"2026-09-06")[0].days.every(d => d.state !== "available")).toBe(true);
 });
 it("does not label unknown rented custody as available", () => {
  expect(buildPlanningRows([{...asset,currentStatus:"rented"}],[],days,"2026-09-06")[0].days[0].state).toBe("custody");
 });
 it("isolates browser views by user and tolerates corrupt/invalid stored values", () => {
  expect(planningStorageKey("a@example.com")).not.toBe(planningStorageKey("b@example.com"));
  expect(decodePlanningViews("invalid")).toEqual([]);
  expect(decodePlanningViews('[{"id":"1","name":"Yard","filters":{"days":999,"status":"unsafe"}}]')[0].filters).toMatchObject({days:14,status:"all"});
 });
});
