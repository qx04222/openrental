import { describe, expect, it } from "vitest";
import { adminRenewalDays } from "../shared/extensionRequestPresentation";

describe("extension request presentation", () => {
  it("extracts system-generated admin renewal durations", () => {
    expect(adminRenewalDays("Admin renewal: +1 day")).toBe(1);
    expect(adminRenewalDays("Admin renewal: +21 days")).toBe(21);
  });

  it("leaves customer-entered reasons untouched", () => {
    expect(adminRenewalDays("Customer requested more time")).toBeNull();
    expect(adminRenewalDays("")).toBeNull();
  });
});
