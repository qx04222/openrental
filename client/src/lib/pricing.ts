/**
 * Client-side pricing calculation utilities
 * DP-based optimal pricing: tries all month/week/day combos
 */

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

  let bestPrice = Infinity;
  let bestBreakdown = "";

  const maxMonths = Math.ceil(days / 30);
  const maxWeeks = Math.ceil(days / 7);

  for (let months = 0; months <= maxMonths; months++) {
    for (let weeks = 0; weeks <= maxWeeks; weeks++) {
      const coveredDays = months * 30 + weeks * 7;

      if (coveredDays < days) {
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
  const diffTime = endDate.getTime() - startDate.getTime();
  if (diffTime < 0) return 1; // Guard: start after end should not silently flip
  return Math.max(1, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
}

export function formatCurrency(amount: number, locale?: string): string {
  const resolvedLocale = locale || (typeof window !== "undefined" && localStorage.getItem("i18nextLng")?.startsWith("zh") ? "zh-CN" : "en-CA");
  return new Intl.NumberFormat(resolvedLocale, { style: "currency", currency: "CAD" }).format(amount);
}
