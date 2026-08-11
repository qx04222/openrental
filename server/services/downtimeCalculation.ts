/**
 * Downtime / Fault Suspension Calculation
 * Excludes weekends and Ontario statutory holidays.
 */
import { calendarPartsInTimeZone } from "../_core/dateUtils";

// Ontario statutory holidays (fixed dates + computed)
function getOntarioHolidays(year: number): Date[] {
  const holidays: Date[] = [
    new Date(year, 0, 1),   // New Year's Day
    new Date(year, 6, 1),   // Canada Day
    new Date(year, 11, 25), // Christmas Day
    new Date(year, 11, 26), // Boxing Day
  ];

  // Family Day: 3rd Monday of February
  holidays.push(getNthWeekday(year, 1, 1, 3));
  // Good Friday: Easter - 2 days
  const easter = computeEaster(year);
  holidays.push(new Date(easter.getTime() - 2 * 86400000));
  // Victoria Day: Monday before May 25
  const may25 = new Date(year, 4, 25);
  const vDay = new Date(may25);
  vDay.setDate(25 - ((may25.getDay() + 6) % 7 || 7));
  holidays.push(vDay);
  // Civic Holiday (Simcoe Day): 1st Monday of August
  holidays.push(getNthWeekday(year, 7, 1, 1));
  // Labour Day: 1st Monday of September
  holidays.push(getNthWeekday(year, 8, 1, 1));
  // Thanksgiving: 2nd Monday of October
  holidays.push(getNthWeekday(year, 9, 1, 2));

  return holidays;
}

function getNthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  let day = 1 + ((weekday - first.getDay() + 7) % 7);
  day += (n - 1) * 7;
  return new Date(year, month, day);
}

function computeEaster(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month, day);
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export interface DowntimeCalculationInput {
  reportedAt: Date;
  resolvedAt: Date;
}

export interface DowntimeCalculationResult {
  totalCalendarDays: number;
  excludedDays: number;     // weekends + holidays
  workingDaysLost: number;
}

export function calculateWorkingDaysLost(input: DowntimeCalculationInput): DowntimeCalculationResult {
  const { reportedAt, resolvedAt } = input;

  let totalCalendarDays = 0;
  let excludedDays = 0;
  let workingDaysLost = 0;

  // Anchor on the Toronto calendar day of each instant (not the UTC container's),
  // then run the rest of the day-walk in local time so weekend/holiday matching
  // stays self-consistent.
  const rt = calendarPartsInTimeZone(reportedAt);
  const current = new Date(rt.year, rt.month - 1, rt.day);
  const re = calendarPartsInTimeZone(resolvedAt);
  const end = new Date(re.year, re.month - 1, re.day);

  // Collect holidays for relevant years
  const years = new Set<number>();
  const d = new Date(current);
  while (d <= end) {
    years.add(d.getFullYear());
    d.setDate(d.getDate() + 1);
  }
  const allHolidays: Date[] = [];
  for (const y of years) {
    allHolidays.push(...getOntarioHolidays(y));
  }

  while (current <= end) {
    totalCalendarDays++;
    const dayOfWeek = current.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = allHolidays.some((h) => isSameDay(h, current));

    if (isWeekend || isHoliday) {
      excludedDays++;
    } else {
      workingDaysLost++;
    }

    current.setDate(current.getDate() + 1);
  }

  return { totalCalendarDays, excludedDays, workingDaysLost };
}
