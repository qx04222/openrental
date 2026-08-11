/**
 * parseCalendarDate — calendar-date strings must anchor to Toronto midnight, not
 * UTC midnight, so they round-trip through the Toronto display layer without the
 * classic off-by-one (May 1 rendering as Apr 30).
 */
import { describe, expect, it } from "vitest";
import { parseCalendarDate, APP_TIMEZONE } from "../server/_core/dateUtils";

describe("parseCalendarDate", () => {
  it("parses a summer (EDT, UTC-4) date as Toronto midnight", () => {
    // 2026-05-01 00:00 Toronto (EDT) === 2026-05-01 04:00 UTC
    expect(parseCalendarDate("2026-05-01").toISOString()).toBe("2026-05-01T04:00:00.000Z");
  });

  it("parses a winter (EST, UTC-5) date as Toronto midnight", () => {
    // 2026-01-15 00:00 Toronto (EST) === 2026-01-15 05:00 UTC
    expect(parseCalendarDate("2026-01-15").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("keeps the value on the same UTC calendar day (no off-by-one)", () => {
    // The whole point: the UTC date portion still reads as the picked day.
    expect(parseCalendarDate("2026-05-01").toISOString().slice(0, 10)).toBe("2026-05-01");
    expect(parseCalendarDate("2026-05-15").toISOString().slice(0, 10)).toBe("2026-05-15");
  });

  it("renders back as the same calendar day in Toronto time", () => {
    const d = parseCalendarDate("2026-05-01");
    const shown = new Intl.DateTimeFormat("en-CA", {
      timeZone: APP_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
    expect(shown).toBe("2026-05-01");
  });

  it("passes through strings that already carry a time component", () => {
    expect(parseCalendarDate("2026-05-01T10:30:00Z").toISOString()).toBe("2026-05-01T10:30:00.000Z");
  });
});

describe("parseZonedDateTime", () => {
  it("parses a datetime-local string as Toronto wall time (EDT, UTC-4)", async () => {
    const { parseZonedDateTime } = await import("../server/_core/dateUtils");
    // 2026-07-09 14:30 Toronto (EDT) === 18:30 UTC
    expect(parseZonedDateTime("2026-07-09T14:30").toISOString()).toBe("2026-07-09T18:30:00.000Z");
  });

  it("parses a winter datetime as Toronto wall time (EST, UTC-5)", async () => {
    const { parseZonedDateTime } = await import("../server/_core/dateUtils");
    expect(parseZonedDateTime("2026-01-15T09:00").toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("accepts an optional seconds component", async () => {
    const { parseZonedDateTime } = await import("../server/_core/dateUtils");
    expect(parseZonedDateTime("2026-07-09T14:30:45").toISOString()).toBe("2026-07-09T18:30:45.000Z");
  });

  it("passes real instants (zone suffix) through unchanged", async () => {
    const { parseZonedDateTime } = await import("../server/_core/dateUtils");
    expect(parseZonedDateTime("2026-07-09T14:30:00.000Z").toISOString()).toBe("2026-07-09T14:30:00.000Z");
  });
});
