/**
 * Rental Pricing Calculation
 * DP-based optimal pricing: tries all month/week/day combos to find lowest price
 */

import { calendarPartsInTimeZone } from "../_core/dateUtils";

export interface PriceBreakdown {
  total: number;
  breakdown: string;
}

export function calculateRentalPrice(
  days: number,
  dailyRate: number,
  weeklyRate: number,
  monthlyRate: number
): PriceBreakdown {
  if (days <= 0) return { total: 0, breakdown: "" };

  // Only rates that are actually configured (> 0) may participate. A null/0
  // rate arrives here as 0 — without these guards the DP would "cover" days
  // with a free week/month tier (or free remaining days) and emit a $0 quote
  // as the authoritative price. A 0-rate tier is unavailable, not free.
  const hasDaily = dailyRate > 0;
  const hasWeekly = weeklyRate > 0;
  const hasMonthly = monthlyRate > 0;

  // No positive rate at all → genuinely unpriceable; caller must handle the 0.
  if (!hasDaily && !hasWeekly && !hasMonthly) {
    return { total: 0, breakdown: "" };
  }

  let bestPrice = Infinity;
  let bestBreakdown = "";

  const maxMonths = hasMonthly ? Math.ceil(days / 30) : 0;
  const maxWeeks = hasWeekly ? Math.ceil(days / 7) : 0;

  for (let months = 0; months <= maxMonths; months++) {
    for (let weeks = 0; weeks <= maxWeeks; weeks++) {
      const coveredDays = months * 30 + weeks * 7;

      if (coveredDays < days) {
        // Remaining days can only be covered if a daily rate exists; otherwise
        // this combination is invalid (don't let unset daily = free days).
        if (!hasDaily) continue;
        const remainingDays = days - coveredDays;
        const total = months * monthlyRate + weeks * weeklyRate + remainingDays * dailyRate;
        if (total < bestPrice) {
          bestPrice = total;
          bestBreakdown = formatBreakdown(months, weeks, remainingDays, monthlyRate, weeklyRate, dailyRate);
        }
      } else {
        const total = months * monthlyRate + weeks * weeklyRate;
        if (total < bestPrice) {
          bestPrice = total;
          bestBreakdown = formatBreakdown(months, weeks, 0, monthlyRate, weeklyRate, dailyRate);
        }
      }
    }
  }

  // No valid combination found (e.g. only a daily rate but the loops never hit
  // the remaining-days branch) — never silently emit $0.
  if (!isFinite(bestPrice)) {
    return { total: 0, breakdown: "" };
  }

  return {
    total: Math.round(bestPrice * 100) / 100,
    breakdown: bestBreakdown || `${days} days × $${dailyRate}`,
  };
}

function formatBreakdown(
  months: number,
  weeks: number,
  days: number,
  monthlyRate: number,
  weeklyRate: number,
  dailyRate: number
): string {
  const parts: string[] = [];
  if (months > 0) parts.push(`${months} month${months > 1 ? "s" : ""} × $${monthlyRate.toLocaleString()}`);
  if (weeks > 0) parts.push(`${weeks} week${weeks > 1 ? "s" : ""} × $${weeklyRate.toLocaleString()}`);
  if (days > 0) parts.push(`${days} day${days > 1 ? "s" : ""} × $${dailyRate.toLocaleString()}`);
  return parts.join(" + ");
}

export function calculateDaysBetween(startDate: Date, endDate: Date): number {
  // Count whole CALENDAR days in the configured timezone, not raw elapsed time. A range
  // that crosses a DST boundary spans 23h or 25h on the changeover day, so the
  // old `ceil(elapsedMs / 24h)` over-counted by a day across the November
  // fall-back (e.g. 49h → ceil(2.04) = 3, should be 2) — over-billing rent +
  // insurance + tax. Anchoring to UTC-midnight of each Toronto calendar date
  // makes the arithmetic DST-immune.
  const s = calendarPartsInTimeZone(startDate);
  const e = calendarPartsInTimeZone(endDate);
  const sUtc = Date.UTC(s.year, s.month - 1, s.day);
  const eUtc = Date.UTC(e.year, e.month - 1, e.day);
  const diffDays = Math.round((eUtc - sUtc) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 1; // Guard: start after end should not silently flip
  return Math.max(1, diffDays);
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(amount);
}
