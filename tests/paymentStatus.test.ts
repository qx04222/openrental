import { describe, expect, it } from "vitest";
import { derivePaymentState } from "../shared/paymentStatus";

describe("derivePaymentState", () => {
  it("marks paid when prepaid covers the total", () => {
    expect(derivePaymentState(100, 100)).toBe("paid");
    expect(derivePaymentState(100, 150)).toBe("paid");
  });
  it("absorbs sub-cent rounding into paid", () => {
    expect(derivePaymentState(100, 99.999)).toBe("paid");
  });
  it("marks partial when some but not all is collected", () => {
    expect(derivePaymentState(100, 50)).toBe("partial");
    expect(derivePaymentState(100, 99.99)).toBe("partial");
  });
  it("marks unpaid when nothing is collected", () => {
    expect(derivePaymentState(100, 0)).toBe("unpaid");
  });
  it("treats a zero/none total as unpaid (not paid)", () => {
    expect(derivePaymentState(0, 0)).toBe("unpaid");
  });
});
