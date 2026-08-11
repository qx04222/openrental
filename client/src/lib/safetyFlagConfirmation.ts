export function canConfirmSafetyFlagChange(reason: string, pending: boolean): boolean {
  return reason.trim().length >= 5 && !pending;
}
