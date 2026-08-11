import { describe, expect, it } from "vitest";
import { resolveDatabasePoolMax } from "../server/db/core";

describe("database pool configuration", () => {
  it("keeps the application below the production pooler capacity", () => {
    expect(resolveDatabasePoolMax(true)).toBe(10);
  });

  it("keeps the existing non-production limit", () => {
    expect(resolveDatabasePoolMax(false)).toBe(10);
  });
});
