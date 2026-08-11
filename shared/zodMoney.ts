import { z } from "zod";

/**
 * Reusable Zod validators for money / numeric string fields stored into
 * Postgres `numeric`/`decimal` columns via Drizzle (which expects a plain
 * numeric string, NOT a JS number).
 *
 * Why this exists: users routinely type money with a leading "$" and thousands
 * separators (e.g. "$37,700"). Naive `z.string()` validation lets that through,
 * and Postgres then rejects it with `invalid input syntax for type numeric`,
 * surfacing as an opaque 400. Empty strings ("") hit the same error.
 *
 * `zMoneyOptional()` accepts a string (the shape every form field already
 * sends — so client call sites keep their `string` types), strips "$", commas
 * and whitespace, treats blank as `undefined`, verifies the remainder is a
 * finite number, and yields a clean numeric string (e.g. "37700") for the
 * numeric column. Invalid input becomes a readable ZodError → clean 400.
 */

const INVALID = "__INVALID_MONEY__";

function cleanMoney(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const cleaned = String(raw).replace(/[$,\s]/g, "").trim();
  if (cleaned === "") return undefined; // blank → treat as "not provided"
  // Reject negatives: every money field here is a fee/rate/amount that is
  // non-negative by domain. Allowing "-" let a tampered client submit a
  // negative total to offset other charges.
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return INVALID;
  return cleaned;
}

/**
 * Optional money field. Input type stays `string` (form-friendly).
 * - "" / undefined → undefined (column unchanged / null)
 * - "$37,700"      → "37700"
 * - "abc"          → ZodError (clean 400 with a readable message)
 */
export function zMoneyOptional(opts?: { max?: number }) {
  const max = opts?.max ?? 20;
  // `.transform(...).optional()` (ZodOptional on the OUTSIDE) infers far better
  // inside z.object(...) than `.optional().transform(...)` — the latter degrades
  // sibling-field inference when the object is destructured (`...rest`) or built
  // as a client object literal.
  return z
    .string()
    .transform((v) => cleanMoney(v))
    .refine((v) => v !== INVALID, { message: "请输入有效的金额（仅数字，可含小数点）" })
    .refine((v) => v === undefined || v.length <= max, { message: `金额长度不能超过 ${max} 位` })
    .optional();
}
