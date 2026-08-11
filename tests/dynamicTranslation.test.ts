import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import { translateDynamic } from "../client/src/lib/i18nHelpers";

describe("dynamic translation helper", () => {
  it("forwards runtime keys and fallback options to i18next", () => {
    const translate = vi.fn((key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    );

    expect(translateDynamic(translate as unknown as TFunction, "status.runtime", {
      defaultValue: "runtime",
    })).toBe("runtime");
    expect(translate).toHaveBeenCalledWith("status.runtime", { defaultValue: "runtime" });
  });
});
