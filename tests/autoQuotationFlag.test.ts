/**
 * The post-approval quotation generator must stay behind its flag on EVERY path.
 *
 * `quotation_generate` runs from two places: inline in the rentals status
 * mutation, and again from the lifecycle-effects retry cron. Gating only the
 * inline one leaves the cron free to resurrect the quotation a few minutes
 * later — the failure would look like "the flag doesn't work sometimes".
 *
 * This is a structural test: it asserts that in each file, the branch handling
 * `quotation_generate` checks `auto_quotation_on_approve` before it reaches
 * `generateQuotationFromRental`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");

const CALL_SITES = [
  "server/routers/rentalRequests.router.ts",
  "server/jobs/rentalLifecycleEffectsCron.ts",
];

/** The slice of source between the quotation branch and its generator call. */
function branchPrelude(source: string): string | null {
  const branchAt = source.indexOf('effectType === "quotation_generate"');
  if (branchAt === -1) return null;
  const callAt = source.indexOf("generateQuotationFromRental", branchAt);
  if (callAt === -1) return null;
  return source.slice(branchAt, callAt);
}

describe("auto_quotation_on_approve gate", () => {
  for (const relPath of CALL_SITES) {
    it(`${relPath} checks the flag before generating`, () => {
      const source = readFileSync(join(ROOT, relPath), "utf8");
      const prelude = branchPrelude(source);

      expect(prelude, `no quotation_generate branch found in ${relPath}`).not.toBeNull();
      expect(prelude).toContain("auto_quotation_on_approve");
      expect(prelude).toContain("isFeatureEnabled");
    });
  }

  it("has no third, ungated call site", () => {
    // Any new caller must be added to CALL_SITES above and gated too.
    const gated = new Set(CALL_SITES);
    const suspects = [
      "server/routers/rentalRequests.router.ts",
      "server/jobs/rentalLifecycleEffectsCron.ts",
      "server/services/quotationGenerator.ts",
    ];
    for (const relPath of suspects) {
      if (gated.has(relPath)) continue;
      const source = readFileSync(join(ROOT, relPath), "utf8");
      // The generator's own definition is fine; a *call* from elsewhere is not.
      expect(source).not.toContain('effectType === "quotation_generate"');
    }
  });
});
