/**
 * csvExport — unit tests for the client-side CSV generation helper.
 *
 * These tests exercise the pure CSV-building logic directly, bypassing the
 * DOM download side-effect. We re-export or inline the escaping logic to keep
 * tests fast and browser-free.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// ── Stub browser globals required by the module ───────────────────────
// The `exportCsv` function calls URL.createObjectURL / revokeObjectURL and
// document.createElement, which are not available in a Node/JSDOM-less vitest
// environment unless configured. We stub them here.

const appendChildSpy = vi.fn();
const clickSpy = vi.fn();
const removeChildSpy = vi.fn();

beforeAll(() => {
  // @ts-expect-error - partial stub
  global.URL = {
    createObjectURL: vi.fn().mockReturnValue("blob:mock-url"),
    revokeObjectURL: vi.fn(),
  };
  // @ts-expect-error - partial stub
  global.document = {
    createElement: vi.fn().mockReturnValue({
      href: "",
      download: "",
      style: {},
      click: clickSpy,
    }),
    body: {
      appendChild: appendChildSpy,
      removeChild: removeChildSpy,
    },
  };
  // Suppress setTimeout calls in the module
  vi.useFakeTimers();
});

afterAll(() => {
  vi.useRealTimers();
});

// ── Import the module under test ──────────────────────────────────────
// Because the module uses `document` at call time (not import time) we can
// import it after setting up the stubs.
import { exportCsv } from "../client/src/lib/csvExport";

// ── Helper: rebuild a CSV string from rows (mirrors internal buildCsv) ─
function escapeField(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\r") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const headerRow = headers.map(escapeField).join(",");
  const dataRows = rows.map((row) => headers.map((h) => escapeField(row[h])).join(","));
  return [headerRow, ...dataRows].join("\r\n");
}

// ── Tests ──────────────────────────────────────────────────────────────
describe("buildCsv (internal logic mirrored in tests)", () => {
  it("returns empty string for empty rows array", () => {
    expect(buildCsv([])).toBe("");
  });

  it("produces a header row from object keys", () => {
    const csv = buildCsv([{ name: "Alice", age: 30 }]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("name,age");
  });

  it("produces one data row per object", () => {
    const csv = buildCsv([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[1]).toBe("1,2");
    expect(lines[2]).toBe("3,4");
  });

  it("wraps fields containing commas in double-quotes", () => {
    const csv = buildCsv([{ address: "123 Main St, Suite 4" }]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe('"123 Main St, Suite 4"');
  });

  it("escapes double-quote characters by doubling them", () => {
    const csv = buildCsv([{ note: 'He said "hello"' }]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe('"He said ""hello"""');
  });

  it("wraps fields containing newlines in double-quotes", () => {
    const csv = buildCsv([{ text: "line1\nline2" }]);
    const lines = csv.split("\r\n");
    // The first data value should be wrapped
    expect(lines[1]).toMatch(/^"/);
  });

  it("wraps fields containing carriage returns", () => {
    const csv = buildCsv([{ text: "line1\rline2" }]);
    expect(csv).toMatch(/"line1\rline2"/);
  });

  it("renders null as empty string", () => {
    const csv = buildCsv([{ x: null }]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("");
  });

  it("renders undefined as empty string", () => {
    const csv = buildCsv([{ x: undefined }]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("");
  });

  it("renders numbers as plain strings", () => {
    const csv = buildCsv([{ count: 42, amount: 3.14 }]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("42,3.14");
  });

  it("does not quote plain alphanumeric strings", () => {
    const csv = buildCsv([{ name: "Alice" }]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("Alice");
  });
});

describe("exportCsv (browser download trigger)", () => {
  it("calls document.createElement with 'a'", () => {
    exportCsv("test.csv", [{ col: "value" }]);
    expect(document.createElement).toHaveBeenCalledWith("a");
  });

  it("calls anchor.click to trigger download", () => {
    exportCsv("test.csv", [{ col: "value" }]);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("sets the correct filename on the anchor element", () => {
    const anchor = { href: "", download: "", style: {}, click: clickSpy };
    vi.mocked(document.createElement).mockReturnValue(anchor as unknown as HTMLElement);
    exportCsv("my-file.csv", [{ col: "x" }]);
    expect(anchor.download).toBe("my-file.csv");
  });

  it("creates a Blob with CSV mime type", () => {
    const BlobSpy = vi.spyOn(global, "Blob");
    exportCsv("test.csv", [{ a: "1" }]);
    expect(BlobSpy).toHaveBeenCalledWith(
      [expect.any(String)],
      expect.objectContaining({ type: expect.stringContaining("text/csv") })
    );
  });

  it("handles empty rows without throwing", () => {
    expect(() => exportCsv("empty.csv", [])).not.toThrow();
  });
});
