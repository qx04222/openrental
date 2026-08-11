const ADMIN_RENEWAL_REASON = /^Admin renewal: \+(\d+) days?$/;

export function adminRenewalDays(reason: string): number | null {
  const match = ADMIN_RENEWAL_REASON.exec(reason.trim());
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isSafeInteger(days) && days > 0 ? days : null;
}
