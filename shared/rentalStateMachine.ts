/**
 * Rental request state machine — shared between server router and tests.
 * Defines valid status transitions for rental requests.
 */

export const RENTAL_VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["approved", "rejected", "cancelled"],
  // Direct close is valid for customer-pickup / admin-created orders that may
  // never have a delivery dispatch to promote them through active first.
  approved: ["active", "completed", "cancelled"],
  active: ["completed", "cancelled", "overdue"],
  // A renewal can move endDate back inside the grace window; the overdue cron
  // then clears the derived flag without bypassing the state machine.
  overdue: ["active", "completed", "cancelled"],
  // completed, cancelled, rejected are terminal states
};

export const TERMINAL_STATES = ["completed", "cancelled", "rejected"] as const;

export function canTransition(from: string, to: string): boolean {
  const allowed = RENTAL_VALID_TRANSITIONS[from];
  return !!allowed && allowed.includes(to);
}

export function isTerminalState(status: string): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(status);
}

export function getAllowedTransitions(from: string): string[] {
  return RENTAL_VALID_TRANSITIONS[from] || [];
}
