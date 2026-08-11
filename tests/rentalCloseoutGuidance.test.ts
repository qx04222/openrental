import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const en = JSON.parse(readFileSync("client/src/i18n/locales/en/common.json", "utf8"));
const zh = JSON.parse(readFileSync("client/src/i18n/locales/zh/common.json", "utf8"));

describe("rental close-out guidance", () => {
  it("provides matched bilingual copy for the awaiting-close workflow", () => {
    const keys = [
      "assetProgress.operational.awaiting_close",
      "assetProgress.closeReadyTitle",
      "assetProgress.closeReadyHint",
      "assetProgress.closeReadyAction",
    ];

    for (const key of keys) {
      expect(en[key], `missing English key ${key}`).toBeTruthy();
      expect(zh[key], `missing Chinese key ${key}`).toBeTruthy();
    }
    expect(en["assetProgress.stage.returnReady"]).toBe("Awaiting admin close-out");
    expect(zh["assetProgress.stage.returnReady"]).toBe("待管理员关单");
    expect(en["assetProgress.tab.return"]).toBe("Return tasks");
    expect(zh["assetProgress.tab.return"]).toBe("退场处理");
    expect(en["assetProgress.adminHint"]).toContain("this admin view refreshes every 10 seconds");
    expect(zh["assetProgress.adminHint"]).toContain("此管理页面每10秒自动刷新");
  });

  it("offers the existing close dialog only from the admin rental detail", () => {
    const detail = readFileSync("client/src/pages/admin/RentalManagement/RentalDetailDialog.tsx", "utf8");
    const field = readFileSync("client/src/pages/FieldDeliveries.tsx", "utf8");

    expect(detail).toContain("areAssetsReadyForAdminClose");
    expect(detail).toContain('t("assetProgress.closeReadyHint", { ns: "common" })');
    expect(detail).toContain('t("assetProgress.closeReadyAction", { ns: "common" })');
    expect(detail).toContain("!rentalReadyForClose");
    expect(detail).not.toContain("!r.returnInspectionCompleted");
    expect(detail).toContain('t("management.liveRefresh", { seconds: 10 })');
    expect(field).toContain('labelKey: "assetProgress.tab.return"');
    expect(field).not.toContain('labelKey: "assetProgress.stage.returnPending"');
    expect(field).not.toContain("assetProgress.closeReadyAction");
  });
});
