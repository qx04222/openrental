/**
 * DataTable column ordering rules.
 *
 * The money columns matter most here: postgres.js returns every NUMERIC column
 * as a string, so "balanceDue" arrives as "8435.43". Before the numeric-string
 * branch these fell through to localeCompare's numeric collation, which walks
 * digit runs segment by segment and therefore reads "100.5" as smaller than
 * "100.45" (5 < 45). The invoices list now defaults to sorting by balance, so a
 * wrong order would silently put the wrong customer at the top of the chase
 * list every day.
 */
import { describe, it, expect } from "vitest";
import { compareCellValues } from "../client/src/lib/tableSort";

const sortDesc = (vals: unknown[]) => [...vals].sort((a, b) => compareCellValues(a, b, "desc"));
const sortAsc = (vals: unknown[]) => [...vals].sort((a, b) => compareCellValues(a, b, "asc"));

describe("compareCellValues", () => {
  it("orders decimal money strings by value, not by digit run", () => {
    expect(sortAsc(["100.45", "100.5", "99.99"])).toEqual(["99.99", "100.45", "100.5"]);
  });

  it("puts the largest balance first when sorting desc", () => {
    const balances = ["324.87", "8435.43", "0.00", "1299.50"];
    expect(sortDesc(balances)).toEqual(["8435.43", "1299.50", "324.87", "0.00"]);
  });

  it("keeps document numbers on human string ordering", () => {
    // "INV-2026-0189" is not a plain number, so it must stay on localeCompare
    // (numeric-aware), which orders the trailing sequence the way people read it.
    const docs = ["INV-2026-0189", "INV-2026-0021", "INV-2026-0110"];
    expect(sortAsc(docs)).toEqual(["INV-2026-0021", "INV-2026-0110", "INV-2026-0189"]);
  });

  it("sorts nulls last in both directions", () => {
    expect(sortAsc(["5", null, "1"])).toEqual(["1", "5", null]);
    expect(sortDesc(["5", null, "1"])).toEqual(["5", "1", null]);
  });

  it("compares dates chronologically, not by weekday name", () => {
    const may12 = new Date("2026-05-12T00:00:00Z"); // Tuesday
    const may15 = new Date("2026-05-15T00:00:00Z"); // Friday
    expect(sortAsc([may15, may12])).toEqual([may12, may15]);
  });

  it("still handles real numbers", () => {
    expect(sortDesc([3, 10, 2])).toEqual([10, 3, 2]);
  });
});
