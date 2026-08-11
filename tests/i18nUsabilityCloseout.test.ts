import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enAdmin from "../client/src/i18n/locales/en/admin.json";
import zhAdmin from "../client/src/i18n/locales/zh/admin.json";
import enCommon from "../client/src/i18n/locales/en/common.json";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enRental from "../client/src/i18n/locales/en/rental.json";
import zhRental from "../client/src/i18n/locales/zh/rental.json";
import {
  auditActionKey,
  auditEntityKey,
  auditFallbackLabel,
} from "../client/src/lib/auditPresentation";

const read = (path: string) => readFileSync(path, "utf8");

describe("active admin surfaces are fully localisable", () => {
  it("normalises lifecycle and audit values without losing an unknown fallback", () => {
    expect(auditActionKey("status change")).toBe("auditLog.actions.status_change");
    expect(auditActionKey("reminder_first_overdue")).toBe("auditLog.actions.reminder_first_overdue");
    expect(auditEntityKey("rental_asset_progress")).toBe("auditLog.entities.rental_asset_progress");
    expect(auditFallbackLabel("customer_ready_for_return")).toBe("Customer ready for return");
  });

  it("keeps every new key symmetric and gives Chinese users a real translation", () => {
    const keys = [
      "customers.tier",
      "customers.tier.active",
      "customers.tier.churned",
      "customers.profile.credit",
      "profile.unlimited",
      "auditLog.searchLabel",
      "auditLog.actions.create",
      "auditLog.actions.customer_ready_for_return",
      "auditLog.entities.rental_asset_progress",
      "invoices.batchSendAll",
      "invoices.batchExportCsv",
      "rentalSettings.systemInsurancePresetNotice",
    ];

    for (const key of keys) {
      const en = (enAdmin as Record<string, string>)[key];
      const zh = (zhAdmin as Record<string, string>)[key];
      expect(en, `missing English key ${key}`).toBeTruthy();
      expect(zh, `missing Chinese key ${key}`).toBeTruthy();
      expect(zh, `Chinese key ${key} still looks English`).not.toBe(en);
    }

    for (const key of ["management.liveRefresh", "management.estimatedLateFee"]) {
      const en = (enRental as Record<string, string>)[key];
      const zh = (zhRental as Record<string, string>)[key];
      expect(en, `missing English key ${key}`).toBeTruthy();
      expect(zh, `missing Chinese key ${key}`).toBeTruthy();
      expect(zh, `Chinese key ${key} still looks English`).not.toBe(en);
    }

    for (const key of ["batch.actions", "batch.selected", "batch.clearSelection", "batch.clear"]) {
      const en = (enCommon as Record<string, string>)[key];
      const zh = (zhCommon as Record<string, string>)[key];
      expect(en, `missing English key ${key}`).toBeTruthy();
      expect(zh, `missing Chinese key ${key}`).toBeTruthy();
      expect(zh, `Chinese key ${key} still looks English`).not.toBe(en);
    }
  });

  it("does not directly render the audited English strings or raw event codes", () => {
    const audit = read("client/src/pages/admin/AuditLog.tsx");
    const customers = read("client/src/pages/admin/Customers.tsx");
    const profile = read("client/src/components/CustomerProfileDialog.tsx");
    const batch = read("client/src/components/BatchActionBar.tsx");
    const invoices = read("client/src/pages/admin/Invoices.tsx");
    const rental = read("client/src/pages/admin/RentalManagement/RentalDetailDialog.tsx");
    const insurance = read("client/src/pages/admin/RentalSettings/InsuranceTab.tsx");

    expect(audit).not.toContain("{entry.action}");
    expect(audit).not.toContain("{row.action.replace(/_/g, \" \")}");
    expect(audit).not.toMatch(/>\s*(View changes|Clear|Timestamp|User|Action|Entity)\s*</);
    expect(audit).not.toContain('placeholder="Search..."');
    expect(customers).not.toMatch(/>\s*(Active|Churned|Tier)\s*</);
    expect(customers).not.toMatch(/aria-label="(Filter by tier|Edit customer|Delete customer)"/);
    expect(profile).not.toMatch(/>\s*(Credit|Unlimited|Since|Remove from Blacklist|Add to Blacklist|Save)\s*</);
    expect(profile).not.toContain('placeholder="Reason for blacklisting..."');
    expect(batch).not.toMatch(/(aria-label=")?(Batch actions|Clear selection)/);
    expect(batch).not.toMatch(/>\s*Clear\s*</);
    expect(invoices).not.toMatch(/>\s*(Send All|Export CSV)\s*</);
    expect(rental).not.toContain("{entry.action}");
    expect(rental).not.toContain('toast.success("Signed")');
    expect(rental).not.toContain("10s LIVE");
    expect(rental).not.toContain("Estimated late fee:");
    expect(insurance).not.toContain("Insurance types (None / Basic LDW / Full Coverage) are system presets.");
  });
});
