import { describe, it, expect } from "vitest";
import { cn } from "../client/src/lib/utils";

describe("cn() — Tailwind class merger (real implementation)", () => {
  it("merges simple classes", () => {
    expect(cn("p-4", "m-2")).toBe("p-4 m-2");
  });

  it("deduplicates conflicting Tailwind classes", () => {
    // tailwind-merge resolves conflicts: last wins
    expect(cn("p-4", "p-8")).toBe("p-8");
  });

  it("handles conditional classes", () => {
    const shouldHide = false;
    expect(cn("base", shouldHide && "hidden", "flex")).toBe("base flex");
  });

  it("handles undefined/null inputs", () => {
    expect(cn("base", undefined, null, "flex")).toBe("base flex");
  });

  it("handles empty string", () => {
    expect(cn("", "p-4")).toBe("p-4");
  });

  it("merges background colors (last wins)", () => {
    expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
  });

  it("handles array of classes", () => {
    expect(cn(["p-4", "m-2"])).toBe("p-4 m-2");
  });

  it("returns empty string for no inputs", () => {
    expect(cn()).toBe("");
  });
});
