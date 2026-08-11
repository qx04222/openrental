export const DISPATCH_STATUSES = ['pending', 'assigned', 'in_transit', 'delivered', 'completed', 'cancelled'] as const;
export type DispatchStatus = typeof DISPATCH_STATUSES[number];

export const DISPATCH_VALID_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
  pending: ['assigned', 'cancelled'],
  assigned: ['in_transit', 'cancelled'],
  in_transit: ['delivered', 'cancelled'],
  delivered: ['completed'],
  completed: [],
  cancelled: [],
};

export function isValidTransition(from: DispatchStatus, to: DispatchStatus): boolean {
  return DISPATCH_VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export const DISPATCH_STATUS_COLORS: Record<DispatchStatus, string> = {
  pending: '#f59e0b',
  assigned: '#3b82f6',
  in_transit: '#8b5cf6',
  delivered: '#f97316',
  completed: '#22c55e',
  cancelled: '#6b7280',
};
