/**
 * Repricing helpers behind recalculateRentalPricing.
 *
 * Regression anchor: rental #20260626TE (2 line items, header rentalFleetId
 * NULL). Renewal +7d fell into the pro-rata fallback which scaled the TAX by
 * the day ratio — but the tax base includes freight, which does not grow with
 * the term, so the freight tax got doubled (353.66 instead of 316.62).
 */
import { describe, expect, it } from "vitest";
import { repriceLineItems, scaleTaxByBase, carryNegotiatedRate, priceLineItems } from "../server/services/priceRecalculation";

// Noon Toronto — safely inside the calendar day for calculateDaysBetween.
const d = (iso: string) => new Date(`${iso}T12:00:00-04:00`);

describe("scaleTaxByBase (pro-rata fallback tax)", () => {
  it("reproduces the #20260626TE fix: scales by base, not by day ratio", () => {
    // old: rent 935 + ins 140.25 + freight 285 → tax 176.83 (13%)
    // new: rent 1870 + ins 280.50 + freight 285 (freight unchanged)
    const oldBase = 935 + 140.25 + 285;
    const newBase = 1870 + 280.5 + 285;
    // 316.61 — within 1¢ of the exact 13% recomputation (316.62); the penny
    // comes from the already-rounded old tax. The buggy day-ratio scaling
    // produced 176.83 × 2 = 353.66, over-counting the freight tax by $37.
    expect(scaleTaxByBase(176.83, oldBase, newBase)).toBe(316.61);
    expect(scaleTaxByBase(176.83, oldBase, newBase)).not.toBe(353.66);
  });

  it("keeps the old tax when the old base is zero or negative", () => {
    expect(scaleTaxByBase(50, 0, 1000)).toBe(50);
    expect(scaleTaxByBase(50, -1, 1000)).toBe(50);
  });
});

describe("repriceLineItems", () => {
  const window = { oldStart: d("2026-07-01"), oldEnd: d("2026-07-08") };

  it("lines tracking the order window follow the new end date", () => {
    const { rentalFee, perLine } = repriceLineItems(
      [
        { startDate: d("2026-07-01"), endDate: d("2026-07-08"), dailyRate: 100, weeklyRate: 0, monthlyRate: 0, quantity: 1 },
        { startDate: d("2026-07-01"), endDate: d("2026-07-08"), dailyRate: 50, weeklyRate: 0, monthlyRate: 0, quantity: 2 },
      ],
      window.oldStart, window.oldEnd,
      d("2026-07-01"), d("2026-07-15"),
    );
    expect(perLine.map((l) => l.days)).toEqual([14, 14]);
    expect(perLine.map((l) => l.subtotal)).toEqual([1400, 1400]);
    expect(rentalFee).toBe(2800);
  });

  it("null line dates fall back to the (new) order window", () => {
    const { perLine } = repriceLineItems(
      [{ startDate: null, endDate: null, dailyRate: 100, weeklyRate: 0, monthlyRate: 0, quantity: 1 }],
      window.oldStart, window.oldEnd,
      d("2026-07-01"), d("2026-07-15"),
    );
    expect(perLine[0].days).toBe(14);
  });

  it("a line already ending beyond the old order end keeps its own end date", () => {
    const { perLine } = repriceLineItems(
      [{ startDate: null, endDate: d("2026-07-20"), dailyRate: 100, weeklyRate: 0, monthlyRate: 0, quantity: 1 }],
      window.oldStart, window.oldEnd,
      d("2026-07-01"), d("2026-07-15"),
    );
    expect(perLine[0].days).toBe(19); // 7/1 → 7/20, untouched by the +7d renewal
  });

  it("a line with a custom later start keeps it", () => {
    const { perLine } = repriceLineItems(
      [{ startDate: d("2026-07-05"), endDate: d("2026-07-08"), dailyRate: 100, weeklyRate: 0, monthlyRate: 0, quantity: 1 }],
      window.oldStart, window.oldEnd,
      d("2026-07-01"), d("2026-07-15"),
    );
    expect(perLine[0].days).toBe(10); // 7/5 → 7/15
  });
});

describe("carryNegotiatedRate (谈判价延续)", () => {
  it("scales the new list fee by the booked discount ratio", () => {
    // #20260626TE: booked 935 vs list 1000 (7d) → 14d list 2000 carries to 1870
    expect(carryNegotiatedRate(935, 1000, 2000)).toBe(1870);
  });

  it("keeps the list fee when the old fee matched list", () => {
    expect(carryNegotiatedRate(1000, 1000, 2000)).toBe(2000);
  });

  it("carries a negotiated markup too, not just discounts", () => {
    expect(carryNegotiatedRate(1200, 1000, 2000)).toBe(2400);
  });

  it("falls back to list when old data is missing or zero", () => {
    expect(carryNegotiatedRate(0, 1000, 2000)).toBe(2000);
    expect(carryNegotiatedRate(935, 0, 2000)).toBe(2000);
  });
});

describe("priceLineItems (as-is old-window list price)", () => {
  it("prices lines at their own dates without boundary remapping", () => {
    const d2 = (iso: string) => new Date(`${iso}T12:00:00-04:00`);
    const { rentalFee, perLine } = priceLineItems(
      [
        { startDate: null, endDate: null, dailyRate: 100, weeklyRate: 0, monthlyRate: 0, quantity: 1 },
        // custom line ending BEFORE the order end must keep its 3 days
        { startDate: d2("2026-07-01"), endDate: d2("2026-07-04"), dailyRate: 50, weeklyRate: 0, monthlyRate: 0, quantity: 1 },
      ],
      d2("2026-07-01"), d2("2026-07-08"),
    );
    expect(perLine.map((l) => l.days)).toEqual([7, 3]);
    expect(rentalFee).toBe(850);
  });
});
