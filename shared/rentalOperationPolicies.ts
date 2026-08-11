export const RENTAL_OPERATION_SAFETY_FLAGS = [
  "dispatch_workflow",
  "dispatch_inspection_required",
  "return_inspection_required",
  "rolling_renewal_operations",
] as const;

const safetyFlagKeySet = new Set<string>(RENTAL_OPERATION_SAFETY_FLAGS);

export function isRentalOperationSafetyFlag(
  key: string,
): key is typeof RENTAL_OPERATION_SAFETY_FLAGS[number] {
  return safetyFlagKeySet.has(key);
}
