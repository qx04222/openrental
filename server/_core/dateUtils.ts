/**
 * The timezone every calendar-date field is anchored to.
 *
 * A rental day is a *calendar* day in the yard's local time, not a UTC day:
 * a machine returned at 8pm on the 3rd is a three-day rental whether or not
 * UTC has already rolled over. So one timezone has to be authoritative, and it
 * has to be the operator's, not the server's.
 *
 * Set APP_TIMEZONE to any IANA zone (America/Toronto, America/Vancouver,
 * America/Chicago, America/New_York, America/Phoenix …). The value is
 * validated at load: an unknown zone fails fast rather than silently shifting
 * every invoice by a day, and validation is also what makes it safe to
 * interpolate into the `AT TIME ZONE` SQL below.
 */
function resolveAppTimezone(): string {
  const raw = process.env.APP_TIMEZONE?.trim();
  if (!raw) return "America/Toronto";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
  } catch {
    throw new Error(
      `APP_TIMEZONE="${raw}" is not a valid IANA timezone. Use e.g. America/Toronto, America/Denver, America/Vancouver.`,
    );
  }
  return raw;
}

export const APP_TIMEZONE = resolveAppTimezone();

/**
 * The same value, quoted for direct use inside a SQL string. Safe because
 * resolveAppTimezone() already rejected anything Intl does not recognise as a
 * timezone, and IANA zone ids contain no quotes.
 */
export const APP_TIMEZONE_SQL = `'${APP_TIMEZONE}'`;

/**
 * Offset, in milliseconds, between the given `timeZone`'s wall clock and UTC at
 * a specific instant — i.e. `(wall-clock read as if it were UTC) − instant`.
 * For America/Toronto this is −4h (EDT) or −5h (EST) depending on DST.
 */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const p: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - instant.getTime();
}

/**
 * Parse a calendar-date string from a client form (`<input type="date">` →
 * `"YYYY-MM-DD"`) as **midnight in `timeZone`** (Toronto by default), returned
 * as the corresponding UTC instant.
 *
 * Why: an `<input type="date">` represents a *day*, not an instant. The old
 * implementation stored it as UTC midnight, but the display layer renders
 * calendar dates in Toronto time — so a UTC-midnight value (00:00Z) shows up as
 * the *previous* day (e.g. May 1 → Apr 30 20:00 EDT). Anchoring to Toronto
 * midnight (04:00Z / 05:00Z) makes the value round-trip correctly through both
 * the Toronto display formatter and the naive `new Date(v).toISOString()` edit
 * paths, since Toronto midnight stays on the same UTC calendar day.
 *
 * The tz offset itself depends on the date (DST). We sample it at the naive-UTC
 * guess, which for Toronto is always ~20:00 the previous day — comfortably on
 * the same side of the 02:00-local DST transition as the true local midnight,
 * so the sampled offset is correct.
 *
 * Strings that already carry a time component (`...T10:30`) or timezone suffix
 * (`Z`, `+04:00`) pass through unchanged — they are real instants, not calendar
 * dates.
 */
export function parseCalendarDate(raw: string, timeZone: string = APP_TIMEZONE): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const naiveUtc = new Date(`${raw}T00:00:00.000Z`);
    const offset = tzOffsetMs(naiveUtc, timeZone);
    return new Date(naiveUtc.getTime() - offset);
  }
  return new Date(raw);
}

/**
 * Parse an `<input type="datetime-local">` string (`"YYYY-MM-DDTHH:mm"`, no
 * timezone suffix) as **wall time in `timeZone`** (Toronto by default). A bare
 * `new Date(raw)` would read it in the container's zone — wrong on the UTC
 * Railway box. Strings carrying a zone suffix pass through unchanged.
 */
export function parseZonedDateTime(raw: string, timeZone: string = APP_TIMEZONE): Date {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)$/.exec(raw);
  if (m) {
    const naiveUtc = new Date(`${m[1]}${m[1].length === 16 ? ":00" : ""}.000Z`);
    const offset = tzOffsetMs(naiveUtc, timeZone);
    return new Date(naiveUtc.getTime() - offset);
  }
  return new Date(raw);
}

/**
 * The {year, month (1-indexed), day} of `instant` as read on the wall clock of
 * `timeZone` (Toronto by default). Use this instead of `Date#getFullYear/
 * getMonth/getDate`, which read the *container's* local zone — wrong on the
 * UTC Railway box for anything that should be "today in Toronto".
 */
export function calendarPartsInTimeZone(
  instant: Date,
  timeZone: string = APP_TIMEZONE,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** `YYYY-MM-DD` for `instant` as seen in `timeZone` (Toronto by default). */
export function calendarDateStringInTimeZone(
  instant: Date,
  timeZone: string = APP_TIMEZONE,
): string {
  const { year, month, day } = calendarPartsInTimeZone(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The UTC instant of midnight (00:00) on the given calendar day in `timeZone`.
 * DST-aware: samples the real offset for that day via `Intl`.
 */
export function zonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string = APP_TIMEZONE,
): Date {
  const naiveUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const offset = tzOffsetMs(naiveUtc, timeZone);
  return new Date(naiveUtc.getTime() - offset);
}

/**
 * UTC instant bounds of the calendar day that is `dayOffset` days from the
 * `timeZone` day containing `now`. `dayOffset` 0 = today, +1 = tomorrow,
 * -1 = yesterday. Returns a half-open range [startUtc, endUtc).
 *
 * This is the single source of truth for "which UTC window is <day> in
 * Toronto" — every cron / range query should go through it instead of
 * `setHours()` (which silently uses the container zone).
 */
export function zonedDayRangeUtc(
  now: Date = new Date(),
  dayOffset = 0,
  timeZone: string = APP_TIMEZONE,
): { startUtc: Date; endUtc: Date; dateStr: string } {
  const { year, month, day } = calendarPartsInTimeZone(now, timeZone);
  // Build today's midnight, then shift by whole days. Date.UTC handles month/
  // year rollover; re-anchoring through zonedMidnightUtc re-samples DST so a
  // day that crosses a DST boundary still lands on true local midnight.
  const todayMidnight = zonedMidnightUtc(year, month, day, timeZone);
  const shifted = new Date(todayMidnight.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const sp = calendarPartsInTimeZone(shifted, timeZone);
  const startUtc = zonedMidnightUtc(sp.year, sp.month, sp.day, timeZone);
  const endParts = calendarPartsInTimeZone(
    new Date(startUtc.getTime() + 25 * 60 * 60 * 1000), // +25h clears any DST short day
    timeZone,
  );
  const endUtc = zonedMidnightUtc(endParts.year, endParts.month, endParts.day, timeZone);
  return {
    startUtc,
    endUtc,
    dateStr: `${sp.year}-${String(sp.month).padStart(2, "0")}-${String(sp.day).padStart(2, "0")}`,
  };
}

/**
 * The UTC instant of Toronto midnight `days` calendar days from the `timeZone`
 * day containing `now`. For calendar-date fields computed as an offset from
 * today (e.g. invoice dueDate = today + 30). DST-aware via re-anchoring.
 */
export function zonedTodayPlusDaysUtc(
  days: number,
  now: Date = new Date(),
  timeZone: string = APP_TIMEZONE,
): Date {
  const { year, month, day } = calendarPartsInTimeZone(now, timeZone);
  const scratch = new Date(Date.UTC(year, month - 1, day));
  scratch.setUTCDate(scratch.getUTCDate() + days);
  return zonedMidnightUtc(
    scratch.getUTCFullYear(),
    scratch.getUTCMonth() + 1,
    scratch.getUTCDate(),
    timeZone,
  );
}

/**
 * SQL fragment that reinterprets a `timestamp without time zone` column (which
 * this app stores as a UTC instant) into the wall-clock of `timeZone`, so that
 * `date_trunc` / `EXTRACT` group by the Toronto calendar instead of UTC.
 * Returns e.g. `("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Toronto'`.
 * `column` must be a trusted identifier expression (never user input).
 */
export function sqlInAppZone(column: string, timeZone: string = APP_TIMEZONE): string {
  return `(${column} AT TIME ZONE 'UTC') AT TIME ZONE '${timeZone}'`;
}

/** `now()` rendered as Toronto wall-clock `timestamp` for same-zone comparisons. */
export function sqlNowInAppZone(timeZone: string = APP_TIMEZONE): string {
  return `(now() AT TIME ZONE '${timeZone}')`;
}
