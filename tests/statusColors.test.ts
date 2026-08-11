import { describe, it, expect } from "vitest";
import {
  rentalStatusColors,
  dispatchStatusColors,
  fleetStatusColors,
  roleColors,
  auditActionColors,
  auditEntityColors,
  notificationStatusColors,
  catalogSourceColors,
  inspectionTypeBadges,
  conditionColors,
  maintStatusColors,
} from "../client/src/lib/statusColors";

// Validate that all color maps follow Tailwind class patterns
const BG_TEXT_PATTERN = /^bg-\w+-\d+\s+text-\w+-\d+$/;
const TEXT_ONLY_PATTERN = /^text-\w+-\d+$/;

function expectBgTextColors(map: Record<string, string>, name: string) {
  for (const [key, value] of Object.entries(map)) {
    expect(value, `${name}["${key}"]`).toMatch(BG_TEXT_PATTERN);
  }
}

function expectTextColors(map: Record<string, string>, name: string) {
  for (const [key, value] of Object.entries(map)) {
    expect(value, `${name}["${key}"]`).toMatch(TEXT_ONLY_PATTERN);
  }
}

describe("Status Color Maps", () => {
  describe("rentalStatusColors", () => {
    it("has all rental statuses", () => {
      expect(Object.keys(rentalStatusColors)).toEqual(
        expect.arrayContaining(["pending", "approved", "rejected", "active", "completed", "cancelled"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(rentalStatusColors, "rentalStatusColors");
    });
  });

  describe("dispatchStatusColors", () => {
    it("has all dispatch statuses", () => {
      expect(Object.keys(dispatchStatusColors)).toEqual(
        expect.arrayContaining(["pending", "assigned", "in_transit", "delivered", "completed", "cancelled"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(dispatchStatusColors, "dispatchStatusColors");
    });
  });

  describe("fleetStatusColors", () => {
    it("has all fleet statuses", () => {
      expect(Object.keys(fleetStatusColors)).toEqual(
        expect.arrayContaining(["available", "rented", "maintenance", "retired"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(fleetStatusColors, "fleetStatusColors");
    });
  });

  describe("roleColors", () => {
    it("has all roles", () => {
      expect(Object.keys(roleColors)).toEqual(
        expect.arrayContaining(["super_admin", "admin", "field_staff", "user"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(roleColors, "roleColors");
    });
  });

  describe("auditActionColors", () => {
    it("has CRUD + restore + permanent_delete actions", () => {
      expect(Object.keys(auditActionColors)).toEqual(
        expect.arrayContaining(["create", "update", "delete", "status_change", "restore", "permanent_delete", "empty_recycle_bin"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(auditActionColors, "auditActionColors");
    });
  });

  describe("auditEntityColors", () => {
    it("has all entity types", () => {
      expect(Object.keys(auditEntityColors)).toEqual(
        expect.arrayContaining(["rental", "fleet", "user", "customer", "dispatch", "warehouse", "settings", "inspection"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(auditEntityColors, "auditEntityColors");
    });
  });

  describe("notificationStatusColors", () => {
    it("has sent/failed/pending", () => {
      expect(Object.keys(notificationStatusColors)).toEqual(
        expect.arrayContaining(["sent", "failed", "pending"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(notificationStatusColors, "notificationStatusColors");
    });
  });

  describe("catalogSourceColors", () => {
    it("has industrial/powersports/manual", () => {
      expect(Object.keys(catalogSourceColors)).toEqual(
        expect.arrayContaining(["industrial", "powersports", "manual"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(catalogSourceColors, "catalogSourceColors");
    });
  });

  describe("inspectionTypeBadges", () => {
    it("has dispatch/return/general", () => {
      expect(Object.keys(inspectionTypeBadges)).toEqual(
        expect.arrayContaining(["dispatch", "return", "general"])
      );
    });

    it("follows bg-text Tailwind pattern", () => {
      expectBgTextColors(inspectionTypeBadges, "inspectionTypeBadges");
    });
  });

  describe("conditionColors (text-only)", () => {
    it("has excellent/good/fair/poor", () => {
      expect(Object.keys(conditionColors)).toEqual(
        expect.arrayContaining(["excellent", "good", "fair", "poor"])
      );
    });

    it("follows text-only Tailwind pattern", () => {
      expectTextColors(conditionColors, "conditionColors");
    });
  });

  describe("maintStatusColors (text-only)", () => {
    it("has ok/due_soon/overdue", () => {
      expect(Object.keys(maintStatusColors)).toEqual(
        expect.arrayContaining(["ok", "due_soon", "overdue"])
      );
    });

    it("follows text-only Tailwind pattern", () => {
      expectTextColors(maintStatusColors, "maintStatusColors");
    });
  });
});
