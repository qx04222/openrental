/**
 * Shift-based pricing, 28-day cycle, and overtime calculation.
 * Canadian heavy equipment rental standard:
 * - Single shift: 8h/day, 40h/week, 160h/28-day
 * - Double shift: 1.5× base rate
 * - Triple shift: 2.0× base rate
 * - Overtime: hours beyond (days × standardHoursPerDay) × (dailyRate / standardHoursPerDay)
 */

export interface ShiftPricingInput {
  days: number;
  dailyRate: number;
  weeklyRate: number;
  monthlyRate: number;
  twentyEightDayRate?: number;
  billingCycleType: "calendar" | "28day";
  shiftType: "single" | "double" | "triple";
  standardHoursPerDay?: number;
}

export interface OvertimeInput {
  engineHoursUsed: number;
  rentalDays: number;
  standardHoursPerDay: number;
  dailyRate: number;
}

export interface ShiftPricingResult {
  baseRentalFee: number;
  shiftMultiplier: number;
  adjustedRentalFee: number;
  breakdown: string;
}

export interface OvertimeResult {
  standardHours: number;
  actualHours: number;
  overtimeHours: number;
  hourlyRate: number;
  overtimeCost: number;
}

const SHIFT_MULTIPLIERS: Record<string, number> = {
  single: 1.0,
  double: 1.5,
  triple: 2.0,
};

/**
 * Calculate 28-day cycle pricing.
 * 28 days = 1 period. Tries all combos of periods + weeks + days.
 */
export function calculate28DayPrice(
  days: number,
  dailyRate: number,
  weeklyRate: number,
  twentyEightDayRate: number,
): { total: number; breakdown: string } {
  if (days <= 0) return { total: 0, breakdown: "" };

  let bestPrice = Infinity;
  let bestBreakdown = "";

  const maxPeriods = Math.ceil(days / 28);
  const maxWeeks = Math.ceil(days / 7);

  for (let periods = 0; periods <= maxPeriods; periods++) {
    for (let weeks = 0; weeks <= maxWeeks; weeks++) {
      const covered = periods * 28 + weeks * 7;
      const remaining = Math.max(0, days - covered);
      const total = periods * twentyEightDayRate + weeks * weeklyRate + remaining * dailyRate;

      if (total < bestPrice) {
        bestPrice = total;
        const parts: string[] = [];
        if (periods > 0) parts.push(`${periods} period${periods > 1 ? "s" : ""} (28d) × $${twentyEightDayRate.toLocaleString()}`);
        if (weeks > 0) parts.push(`${weeks} week${weeks > 1 ? "s" : ""} × $${weeklyRate.toLocaleString()}`);
        if (remaining > 0) parts.push(`${remaining} day${remaining > 1 ? "s" : ""} × $${dailyRate.toLocaleString()}`);
        bestBreakdown = parts.join(" + ");
      }

      if (covered >= days) break;
    }
  }

  return {
    total: Math.round(bestPrice * 100) / 100,
    breakdown: bestBreakdown || `${days} days × $${dailyRate}`,
  };
}

/**
 * Apply shift multiplier to base rates.
 */
export function calculateShiftPricing(input: ShiftPricingInput): ShiftPricingResult {
  // Inline the DP logic to avoid circular/CJS issues — same algorithm as pricingCalculation.ts
  function calcCalendar(days: number, daily: number, weekly: number, monthly: number) {
    let best = Infinity; let bd = "";
    const mMax = Math.ceil(days / 30);
    const wMax = Math.ceil(days / 7);
    for (let m = 0; m <= mMax; m++) {
      for (let w = 0; w <= wMax; w++) {
        const c = m * 30 + w * 7;
        const r = Math.max(0, days - c);
        const t = m * monthly + w * weekly + (c < days ? r * daily : 0);
        if (t < best) {
          best = t;
          const p: string[] = [];
          if (m > 0) p.push(`${m} month${m > 1 ? "s" : ""} × $${monthly.toLocaleString()}`);
          if (w > 0) p.push(`${w} week${w > 1 ? "s" : ""} × $${weekly.toLocaleString()}`);
          if (c < days && r > 0) p.push(`${r} day${r > 1 ? "s" : ""} × $${daily.toLocaleString()}`);
          bd = p.join(" + ");
        }
      }
    }
    return { total: Math.round(best * 100) / 100, breakdown: bd || `${days} days × $${daily}` };
  }
  const multiplier = SHIFT_MULTIPLIERS[input.shiftType] || 1.0;

  let baseResult: { total: number; breakdown: string };

  if (input.billingCycleType === "28day" && input.twentyEightDayRate) {
    baseResult = calculate28DayPrice(
      input.days,
      input.dailyRate,
      input.weeklyRate,
      input.twentyEightDayRate,
    );
  } else {
    baseResult = calcCalendar(
      input.days,
      input.dailyRate,
      input.weeklyRate,
      input.monthlyRate,
    );
  }

  const adjustedFee = Math.round(baseResult.total * multiplier * 100) / 100;

  let breakdown = baseResult.breakdown;
  if (multiplier !== 1.0) {
    breakdown += ` × ${multiplier} (${input.shiftType} shift)`;
  }

  return {
    baseRentalFee: baseResult.total,
    shiftMultiplier: multiplier,
    adjustedRentalFee: adjustedFee,
    breakdown,
  };
}

/**
 * Calculate overtime cost based on engine hours.
 */
export function calculateOvertime(input: OvertimeInput): OvertimeResult {
  const { engineHoursUsed, rentalDays, standardHoursPerDay, dailyRate } = input;
  const standardHours = rentalDays * standardHoursPerDay;
  const overtimeHours = Math.max(0, engineHoursUsed - standardHours);
  const hourlyRate = Math.round((dailyRate / standardHoursPerDay) * 100) / 100;
  const overtimeCost = Math.round(overtimeHours * hourlyRate * 100) / 100;

  return {
    standardHours,
    actualHours: engineHoursUsed,
    overtimeHours,
    hourlyRate,
    overtimeCost,
  };
}
