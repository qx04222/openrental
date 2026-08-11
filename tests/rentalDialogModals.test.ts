/**
 * A dialog is dead if its trigger renders in more places than the dialog does.
 *
 * The delete button on every prepayment, and the waive button on every order's
 * pricing tab, both opened dialogs that were nested inside the credit-order
 * branch. On an ordinary order the click set the state and nothing mounted, so
 * the button did nothing at all — no dialog, no error, no clue. Reported from
 * production on order 20260706TK, whose $2,500 prepayment was a typo that could
 * not be removed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "client/src/pages/admin/RentalManagement/RentalDetailDialog.tsx";
const lines = readFileSync(SRC, "utf8").split("\n");

const indentOf = (l: string) => l.length - l.replace(/^ +/, "").length;

/** Line index of a JSX conditional block opener, e.g. `{foo && (`. */
function openerLine(token: string): number {
  const i = lines.findIndex((l) => l.trim() === `{${token} && (`);
  expect(i, `no JSX block for ${token}`).toBeGreaterThan(-1);
  return i;
}

/** The matching `)}` at the opener's own indentation. */
function closerLine(open: number): number {
  const ind = indentOf(lines[open]);
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trim() === ")}" && indentOf(lines[i]) === ind) return i;
  }
  throw new Error("unterminated JSX block");
}

describe("dialogs reachable from every order", () => {
  const creditOpen = openerLine("isCreditOrder");
  const creditClose = closerLine(creditOpen);

  for (const dialog of ["prepaymentDelete", "waivingCharge"]) {
    it(`${dialog} does not sit inside the credit-order branch`, () => {
      const open = openerLine(dialog);
      const inside = open > creditOpen && open < creditClose;
      expect(inside, `${dialog} renders only for credit orders, but its button does not`).toBe(false);
    });
  }

  it("chargeEdit may stay inside it, because its buttons are there too", () => {
    // Not every dialog belongs at the top level — this one is only ever opened
    // from buttons in the same branch, so gating it is correct.
    const open = openerLine("chargeEdit");
    expect(open > creditOpen && open < creditClose).toBe(true);
  });
});
