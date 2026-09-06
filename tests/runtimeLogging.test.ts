import { describe, it, expect } from "vitest";
import { redactLogValue, safeRequestPath, requestContext } from "../server/_core/logger";

describe("runtime log privacy", () => {
  it("redacts nested credentials while retaining diagnostics", () => {
    expect(redactLogValue({ status: 503, child: { password: "example", apiKey: "example", count: 2 } }))
      .toEqual({ status: 503, child: { password: "[REDACTED]", apiKey: "[REDACTED]", count: 2 } });
  });
  it("handles cycles, bigint and error credentials without crashing logging", () => {
    const value: Record<string, unknown> = { count: 1n };
    value.self = value;
    expect(redactLogValue(value)).toEqual({ count: "1", self: "[Circular]" });
    const text = JSON.stringify(redactLogValue(new Error("postgresql://user:private@host/db token=abc Bearer xyz")));
    expect(text).not.toContain("private");
    expect(text).not.toContain("abc");
    expect(text).not.toContain("xyz");
  });
  it("removes inspection links and query inputs from access logs", () => {
    expect(safeRequestPath("/api/inspection/verify/secret?name=person")).toBe("/api/inspection/verify/[REDACTED]");
  });
  it("keeps concurrent request identities isolated", async () => {
    const identities = await Promise.all(["a", "b"].map(requestId => requestContext.run({ requestId }, async () => {
      await Promise.resolve();
      return requestContext.getStore()?.requestId;
    })));
    expect(identities).toEqual(["a", "b"]);
    expect(requestContext.getStore()).toBeUndefined();
  });
});
