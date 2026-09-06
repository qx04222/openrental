import { describe, expect, it } from "vitest";
import { prioritizeOperations } from "../shared/operationalIntelligence";
import { isPlanningWindowAvailable } from "../shared/planning";
import { readPlanningFilters } from "../client/src/lib/planningViews";
const bucket = (kind: string, age: number, slaDays = 3) => ({ kind, slaDays, items: [{ id: 42, ref: "R42", ageDays: age, overdue: age >= slaDays }] });
describe("explainable operational suggestions", () => {
 it("ranks overdue work before fresh work and retains the evidence", () => {
  const items = prioritizeOperations({ buckets: [bucket("extension_request",0,1),bucket("draft_invoice",30)] });
  expect(items[0]).toMatchObject({kind:"draft_invoice",ageDays:30,slaDays:3,overdueBy:27,urgency:"urgent",href:"/admin/invoices?invoiceId=42"});
 });
 it("uses business impact as a deterministic tie breaker", () => {
  expect(prioritizeOperations({buckets:[bucket("draft_invoice",5),bucket("work_order",5)]})[0].kind).toBe("work_order");
 });
 it("never invents suggestions on empty data or unknown categories", () => {
  expect(prioritizeOperations({buckets:[]})).toEqual([]);
  expect(prioritizeOperations({buckets:[bucket("untrusted_kind",500)]})).toEqual([]);
 });
 it("deduplicates and respects the bounded suggestion list", () => {
  const b=bucket("held_deposit",15);expect(prioritizeOperations({buckets:[b,b]},3)).toHaveLength(1);
  expect(prioritizeOperations({buckets:[b]},0)).toEqual([]);
 });
 it("requires every actual day to be available for a continuous rental", () => {
  expect(isPlanningWindowAvailable([])).toBe(false);
  expect(isPlanningWindowAvailable([{state:"available"},{state:"available"}])).toBe(true);
  for(const state of ["reserved","maintenance","return","work_order","custody","conflict"] as const) expect(isPlanningWindowAvailable([{state:"available"},{state}])).toBe(false);
  expect(readPlanningFilters({status:"available_window"}).status).toBe("available_window");
 });
});
