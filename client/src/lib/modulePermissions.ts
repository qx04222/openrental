import type { Action, Module } from "@shared/authRules";

type ModulePermission = {
  module: string;
  canCreate: boolean;
  canRead: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

const ACTION_KEYS = {
  create: "canCreate",
  read: "canRead",
  update: "canUpdate",
  delete: "canDelete",
} as const satisfies Record<Action, keyof ModulePermission>;

export function canUseModulePermission(
  permissions: readonly ModulePermission[] | null | undefined,
  module: Module,
  action: Action,
): boolean {
  const permission = permissions?.find((item) => item.module === module);
  return permission?.[ACTION_KEYS[action]] ?? false;
}
