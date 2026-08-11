/**
 * Return inspection is REQUIRED in production (feature flag
 * `return_inspection_required` defaults to true and is enabled), so "close the
 * order before the return inspection is on file" is the single most common
 * error an operator hits. It used to surface as raw English carrying a database
 * id — "Return inspection is missing for fleet #123" — inside a Chinese UI.
 *
 * The English message must stay byte-identical (it is what gets logged, it is
 * the client-side fallback, and tests elsewhere assert on the blocker codes),
 * so the fix only adds a translation hint alongside it. This pins both halves:
 * every blocker code has a key in BOTH locales, and the key naming stays in
 * sync with the codes the lifecycle planner can actually emit.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enCommon from "../client/src/i18n/locales/en/common.json";

/** Codes evaluateLifecyclePlan can put on a blocker. */
const BLOCKER_CODES = [
  "INVALID_TRANSITION",
  "EARLY_RETURN_UNCONFIRMED",
  "RETURN_INSPECTION_MISSING",
  "PICKUP_INCOMPLETE",
  "PHYSICAL_PICKUP_MISSING",
  "DISPATCH_INSPECTION_MISSING",
] as const;

describe("lifecycle blocker errors are translatable", () => {
  it("every blocker code has a key in both locales", () => {
    for (const code of BLOCKER_CODES) {
      const key = `errors.lifecycleBlocker.${code}`;
      expect(zhCommon, `zh missing ${key}`).toHaveProperty(key);
      expect(enCommon, `en missing ${key}`).toHaveProperty(key);
    }
    expect(zhCommon).toHaveProperty("errors.lifecycleBlockedMultiple");
    expect(enCommon).toHaveProperty("errors.lifecycleBlockedMultiple");
  });

  it("the zh copy is actually Chinese, not a copy of the English", () => {
    for (const code of BLOCKER_CODES) {
      const key = `errors.lifecycleBlocker.${code}` as keyof typeof zhCommon;
      expect(String(zhCommon[key]), `${key} should contain Chinese`).toMatch(/[一-龥]/);
    }
  });

  it("the codes here match the ones the planner can emit", () => {
    // Guards against a new blocker being added upstream with no translation.
    // Read the LifecycleBlockerCode union rather than every `code: "..."` in the
    // file — the latter also picks up the TRPCError codes (NOT_FOUND) thrown
    // there, which are not blockers at all.
    const src = readFileSync("server/services/rentalLifecycle.ts", "utf8");
    const union = src.match(/export type LifecycleBlockerCode =([\s\S]*?);/)?.[1] ?? "";
    expect(union, "LifecycleBlockerCode union not found").not.toBe("");
    const emitted = new Set(Array.from(union.matchAll(/"([A-Z_]+)"/g)).map((m) => m[1]));
    expect(emitted.size).toBe(BLOCKER_CODES.length);
    for (const code of emitted) {
      expect(BLOCKER_CODES as readonly string[], `new blocker code ${code} has no translation`).toContain(code);
    }
  });

  it("the throw site attaches the hint without rewriting the English message", () => {
    const src = readFileSync("server/routers/rentalRequests.router.ts", "utf8");
    // message is still the joined blocker messages — unchanged behaviour for
    // logging and for the untranslated fallback path.
    expect(src).toContain('message: plan.blockers.map((blocker) => blocker.message).join("; ")');
    expect(src).toContain("errors.lifecycleBlocker.");
  });
});
