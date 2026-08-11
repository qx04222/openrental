function normaliseAuditToken(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function auditActionKey(action: string): string {
  return `auditLog.actions.${normaliseAuditToken(action)}`;
}

export function auditEntityKey(entityType: string): string {
  return `auditLog.entities.${normaliseAuditToken(entityType)}`;
}

export function auditFallbackLabel(value: string): string {
  const words = normaliseAuditToken(value).replace(/_/g, " ");
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : value;
}
