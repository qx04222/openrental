import { describe, expect, it } from "vitest";
import { canConfirmSafetyFlagChange } from "../client/src/lib/safetyFlagConfirmation";

describe("safety flag confirmation", () => {
  it("rejects a reason shorter than five trimmed characters", () => {
    expect(canConfirmSafetyFlagChange("no", false)).toBe(false);
    expect(canConfirmSafetyFlagChange("    ", false)).toBe(false);
  });

  it("accepts a meaningful reason only while no mutation is pending", () => {
    expect(canConfirmSafetyFlagChange("valid reason", false)).toBe(true);
    expect(canConfirmSafetyFlagChange("valid reason", true)).toBe(false);
  });
});
