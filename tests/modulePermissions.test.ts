import { describe, expect, it } from "vitest";
import { canUseModulePermission } from "../client/src/lib/modulePermissions";

const permissions = [{
  module: "invoices",
  canCreate: true,
  canRead: true,
  canUpdate: false,
  canDelete: false,
}];

describe("module permission presentation", () => {
  it("reads the requested typed CRUD capability", () => {
    expect(canUseModulePermission(permissions, "invoices", "create")).toBe(true);
    expect(canUseModulePermission(permissions, "invoices", "update")).toBe(false);
  });

  it("denies missing permission data", () => {
    expect(canUseModulePermission(undefined, "invoices", "read")).toBe(false);
    expect(canUseModulePermission(permissions, "rentals", "read")).toBe(false);
  });
});
