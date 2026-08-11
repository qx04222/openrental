import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("feature flag admin UI", () => {
  it("exposes the rolling renewal safety flag with bilingual copy", () => {
    const page = readFileSync("client/src/pages/admin/FeatureFlags.tsx", "utf8");
    const en = readFileSync("client/src/i18n/locales/en/common.json", "utf8");
    const zh = readFileSync("client/src/i18n/locales/zh/common.json", "utf8");

    expect(page).toContain('"rolling_renewal_operations"');
    expect(en).toContain('"featureFlags.name.rolling_renewal_operations"');
    expect(en).toContain('"featureFlags.desc.rolling_renewal_operations"');
    expect(zh).toContain('"featureFlags.name.rolling_renewal_operations"');
    expect(zh).toContain('"featureFlags.desc.rolling_renewal_operations"');
  });
});
