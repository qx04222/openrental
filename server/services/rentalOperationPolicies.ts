import { listAllEnabled } from "./featureFlags";
import { logger } from "../_core/logger";
import {
  RENTAL_OPERATION_SAFETY_FLAGS,
  isRentalOperationSafetyFlag,
} from "../../shared/rentalOperationPolicies";

export interface RentalOperationPolicies {
  dispatchWorkflow: boolean;
  dispatchInspectionRequired: boolean;
  returnInspectionRequired: boolean;
}

export const SAFETY_FLAG_KEYS = RENTAL_OPERATION_SAFETY_FLAGS;
export const isSafetyFlagKey = isRentalOperationSafetyFlag;

export async function getRentalOperationPolicies(): Promise<RentalOperationPolicies> {
  let flags: Record<string, boolean> = {};
  try {
    flags = await listAllEnabled();
  } catch (error) {
    logger.error("[RentalOperationPolicies] flag snapshot failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    dispatchWorkflow: flags.dispatch_workflow ?? false,
    dispatchInspectionRequired: flags.dispatch_inspection_required ?? false,
    returnInspectionRequired: flags.return_inspection_required ?? true,
  };
}

export function shouldAutoCreateDispatch(
  dispatchWorkflow: boolean,
  deliveryMethod: "pickup" | "delivery" | "delivery_and_return" | null | undefined,
): boolean {
  return dispatchWorkflow && deliveryMethod != null && deliveryMethod !== "pickup";
}
