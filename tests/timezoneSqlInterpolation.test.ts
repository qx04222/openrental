/**
 * `APP_TIMEZONE_SQL` must be inlined, never bound as a parameter.
 *
 * Drizzle turns `${x}` inside a sql`` template into a bind parameter. Doing
 * that with the timezone produces `AT TIME ZONE $1` bound to the string
 * `'America/Toronto'` — quote characters included — which Postgres rejects.
 * Every dashboard and report query then 500s, and because the UI renders
 * `data?.x ?? 0`, the user sees a dashboard of confident zeroes rather than an
 * error. That is exactly the failure this project claims not to ship.
 *
 * Unit tests could not catch it: they mock the database, so a malformed query
 * never reaches Postgres. This is a source-level guard instead — inside a
 * drizzle sql`` template the interpolation must be wrapped in `sql.raw()`.
 * Inside a plain JS string that is later handed to `sql.raw(...)`, direct
 * interpolation is correct and expected.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Split a source file into the regions covered by `sql.raw(\`...\`)`, where a
 * bare interpolation is correct. Anything outside those regions that sits in a
 * template is a drizzle template.
 */
function rawRegions(src: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];

  const direct = /sql\.raw\(\s*`/g;
  let m: RegExpExecArray | null;
  while ((m = direct.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf("`", start);
    if (end > start) regions.push([start, end]);
  }

  // A query is sometimes assembled as a string first and executed with
  // sql.raw() further down. Those fragments carry an explicit
  // `sql-raw-fragment` marker comment, both so a reader knows why the
  // timezone is inlined and so this check does not flag them.
  const marked = /sql-raw-fragment[\s\S]*?`/g;
  while ((m = marked.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf("`", start);
    if (end > start) regions.push([start, end]);
  }

  return regions;
}

describe("APP_TIMEZONE_SQL interpolation", () => {
  const files = walk(join(__dirname, "..", "server"))
    .filter((f) => readFileSync(f, "utf8").includes("APP_TIMEZONE_SQL"))
    .filter((f) => !f.endsWith("dateUtils.ts")); // the definition itself

  it("is used somewhere, so this test cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.split("/server/")[1]} wraps every drizzle-template use in sql.raw()`, () => {
      const src = readFileSync(file, "utf8");
      const raw = rawRegions(src);
      const offenders: number[] = [];

      const re = /\$\{APP_TIMEZONE_SQL\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const inRawString = raw.some(([a, b]) => m!.index >= a && m!.index < b);
        if (!inRawString) offenders.push(src.slice(0, m.index).split("\n").length);
      }

      expect(
        offenders,
        `bare \${APP_TIMEZONE_SQL} outside a sql.raw() string at line(s) ${offenders.join(", ")} — ` +
          "wrap it in sql.raw() or Postgres will receive a quoted bind parameter",
      ).toEqual([]);
    });
  }
});
