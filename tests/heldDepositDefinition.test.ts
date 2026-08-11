/**
 * "Held deposit" must mean the same thing in the UI and in the work queue.
 *
 * A deposit leaves the held bucket two ways: converted to rent (`appliedAt`) or
 * parked on the customer's account (`transferredToCreditAt`, migration 150).
 * The rental dialog only checked `appliedAt`, so a deposit moved to the
 * customer's balance still displayed as held — and the new "this rental is over
 * and X is unhandled" banner would have nagged forever about money that was
 * already dealt with, while the sidebar badge (which reads the work queue)
 * showed nothing. Two truths about the same dollar is the bug class this
 * codebase keeps paying for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("held deposit definition", () => {
  it("the rental dialog excludes both applied and transferred deposits", () => {
    const source = read("client/src/pages/admin/RentalManagement/RentalDetailDialog.tsx");
    const start = source.indexOf("const heldTotal = useMemo(");
    expect(start, "heldTotal not found").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("[prepayments]", start));

    expect(body).toContain("!p.appliedAt");
    expect(body).toContain("!p.transferredToCreditAt");
  });

  it("the internal work queue excludes both as well", () => {
    const source = read("server/services/internalWorkQueue.ts");
    const start = source.indexOf("'held_deposit'::text AS kind");
    expect(start, "held_deposit branch not found").toBeGreaterThan(-1);
    const branch = source.slice(start, source.indexOf("UNION ALL", start));

    expect(branch).toContain('"appliedAt" IS NULL');
    expect(branch).toContain('"transferredToCreditAt" IS NULL');
  });

  it("the banner only fires on finished rentals", () => {
    const source = read("client/src/pages/admin/RentalManagement/RentalDetailDialog.tsx");
    const start = source.indexOf("const isFinished =");
    expect(start).toBeGreaterThan(-1);
    const line = source.slice(start, source.indexOf("\n", start));

    // An active rental's deposit is a live guarantee, not a loose end.
    expect(line).toContain("completed");
    expect(line).toContain("cancelled");
    expect(line).not.toContain('"active"');
  });
});
