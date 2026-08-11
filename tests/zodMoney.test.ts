import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zMoneyOptional } from "../shared/zodMoney";

const schema = z.object({ amount: zMoneyOptional() });

describe("zMoneyOptional", () => {
  it("strips $ and thousands separators", () => {
    expect(schema.parse({ amount: "$37,700" })).toEqual({ amount: "37700" });
  });

  it("treats blank as undefined", () => {
    expect(schema.parse({ amount: "" })).toEqual({ amount: undefined });
  });

  it("accepts decimals", () => {
    expect(schema.parse({ amount: "12.50" })).toEqual({ amount: "12.50" });
  });

  it("rejects non-numeric input", () => {
    expect(() => schema.parse({ amount: "abc" })).toThrow();
  });

  // Regression: a tampered client must not be able to submit a negative
  // amount to offset other charges (Top-10 #1).
  it("rejects negative amounts", () => {
    expect(() => schema.parse({ amount: "-100" })).toThrow();
    expect(() => schema.parse({ amount: "-0.01" })).toThrow();
    expect(() => schema.parse({ amount: "$-50" })).toThrow();
  });
});
