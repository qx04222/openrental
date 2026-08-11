import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { canTransition } from "../../shared/rentalStateMachine";

export type RentalStatus = "pending" | "approved" | "rejected" | "active" | "completed" | "cancelled" | "overdue";

export type LifecycleEffectType =
  | "contract_generate"
  | "order_confirmation"
  | "quotation_generate"
  | "invoice_reconcile"
  | "invoice_document"
  | "renewal_supplement"
  | "notification";

export interface LifecycleRentalSnapshot {
  id: number;
  status: RentalStatus;
  startDate: Date;
  endDate: Date;
  updatedAt: Date;
  lifecycleVersion?: number | null;
}

export interface FulfillmentSnapshot {
  requiredFleetIds: number[];
  dispatchInspectedFleetIds: number[];
  dispatchInspectionBypassedFleetIds: number[];
  returnInspectedFleetIds: number[];
  returnInspectionBypassedFleetIds: number[];
  incompletePickupFleetIds: number[];
  unpickedReturnOperationFleetIds: number[];
}

export type LifecycleBlockerCode =
  | "DISPATCH_INSPECTION_MISSING"
  | "RETURN_INSPECTION_MISSING"
  | "PICKUP_INCOMPLETE"
  | "PHYSICAL_PICKUP_MISSING"
  | "INVALID_TRANSITION"
  | "EARLY_RETURN_UNCONFIRMED";

export interface LifecycleBlocker {
  code: LifecycleBlockerCode;
  fleetId?: number;
  message: string;
}

export interface LifecyclePlan {
  rentalId: number;
  expectedStatus: RentalStatus;
  targetStatus: RentalStatus;
  willWrite: boolean;
  reconcileOnly: boolean;
  commandKey: string;
  fulfillment: FulfillmentSnapshot;
  blockers: LifecycleBlocker[];
  requiredEffects: LifecycleEffectType[];
}

type Db = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

export const getLifecycleEffectsForStatus = (status: RentalStatus): LifecycleEffectType[] => {
  switch (status) {
    case "approved":
      return ["contract_generate", "order_confirmation", "quotation_generate", "notification"];
    case "completed":
      return ["invoice_reconcile", "invoice_document", "notification"];
    case "active":
    case "cancelled":
    case "rejected":
    case "overdue":
      return ["notification"];
    default:
      return [];
  }
};

export const getLifecycleReconciliationEffects = (status: RentalStatus): LifecycleEffectType[] => {
  switch (status) {
    case "approved":
      return ["contract_generate", "quotation_generate"];
    case "completed":
      return ["invoice_reconcile", "invoice_document"];
    default:
      return [];
  }
};

export function makeLifecycleCommandKey(rental: LifecycleRentalSnapshot, targetStatus: RentalStatus): string {
  const version = rental.lifecycleVersion == null
    ? `t${rental.updatedAt?.getTime() ?? 0}`
    : `v${rental.lifecycleVersion}`;
  return `rental:${rental.id}:${rental.status}:${targetStatus}:${version}`;
}

export function nextLifecycleVersion(current: number | null | undefined): number {
  return (current ?? 0) + 1;
}

export function evaluateLifecyclePlan(input: {
  rental: LifecycleRentalSnapshot;
  targetStatus: RentalStatus;
  fulfillment: FulfillmentSnapshot;
  now?: Date;
  earlyReturn?: boolean;
  dispatchWorkflow?: boolean;
  dispatchInspectionRequired?: boolean;
  returnInspectionRequired?: boolean;
  transitionOverrideReason?: string;
}): LifecyclePlan {
  const now = input.now ?? new Date();
  const sameStatus = input.rental.status === input.targetStatus;
  const blockers: LifecycleBlocker[] = [];

  if (!sameStatus && !input.transitionOverrideReason?.trim() && !canTransition(input.rental.status, input.targetStatus)) {
    blockers.push({
      code: "INVALID_TRANSITION",
      message: `Cannot transition from "${input.rental.status}" to "${input.targetStatus}"`,
    });
  }

  if (!sameStatus && input.targetStatus === "completed") {
    if (input.rental.endDate.getTime() > now.getTime() && !input.earlyReturn) {
      blockers.push({
        code: "EARLY_RETURN_UNCONFIRMED",
        message: `Rental period has not ended (endDate=${input.rental.endDate.toISOString()})`,
      });
    }

    if (input.returnInspectionRequired ?? true) {
      const inspected = new Set(input.fulfillment.returnInspectedFleetIds);
      const bypassed = new Set(input.fulfillment.returnInspectionBypassedFleetIds);
      for (const fleetId of input.fulfillment.requiredFleetIds) {
        if (!inspected.has(fleetId) && !bypassed.has(fleetId)) {
          blockers.push({
            code: "RETURN_INSPECTION_MISSING",
            fleetId,
            message: `Return inspection is missing for fleet #${fleetId}`,
          });
        }
      }
    }

    if (input.dispatchWorkflow ?? true) {
      for (const fleetId of input.fulfillment.incompletePickupFleetIds) {
        blockers.push({
          code: "PICKUP_INCOMPLETE",
          fleetId,
          message: `Pickup dispatch is not complete for fleet #${fleetId}`,
        });
      }
    }

    for (const fleetId of input.fulfillment.unpickedReturnOperationFleetIds) {
      blockers.push({
        code: "PHYSICAL_PICKUP_MISSING",
        fleetId,
        message: `Physical pickup is missing for fleet #${fleetId}`,
      });
    }
  }

  if (!sameStatus && input.targetStatus === "active" && input.dispatchInspectionRequired) {
    const inspected = new Set(input.fulfillment.dispatchInspectedFleetIds);
    const bypassed = new Set(input.fulfillment.dispatchInspectionBypassedFleetIds);
    for (const fleetId of input.fulfillment.requiredFleetIds) {
      if (!inspected.has(fleetId) && !bypassed.has(fleetId)) {
        blockers.push({
          code: "DISPATCH_INSPECTION_MISSING",
          fleetId,
          message: `Dispatch inspection is missing for fleet #${fleetId}`,
        });
      }
    }
  }

  return {
    rentalId: input.rental.id,
    expectedStatus: input.rental.status,
    targetStatus: input.targetStatus,
    willWrite: !sameStatus && blockers.length === 0,
    reconcileOnly: sameStatus,
    commandKey: makeLifecycleCommandKey(input.rental, input.targetStatus),
    fulfillment: input.fulfillment,
    blockers,
    requiredEffects: sameStatus
      ? getLifecycleReconciliationEffects(input.targetStatus)
      : getLifecycleEffectsForStatus(input.targetStatus),
  };
}

export async function getFulfillmentSnapshot(db: Db, rentalId: number): Promise<FulfillmentSnapshot> {
  const [rental] = await db
    .select({
      rentalFleetId: schema.rentalRequests.rentalFleetId,
      returnInspectionCompleted: schema.rentalRequests.returnInspectionCompleted,
    })
    .from(schema.rentalRequests)
    .where(and(eq(schema.rentalRequests.id, rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);

  if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

  const lines = await db
    .select({ rentalFleetId: schema.rentalLineItems.rentalFleetId })
    .from(schema.rentalLineItems)
    .where(and(
      eq(schema.rentalLineItems.rentalRequestId, rentalId),
      isNull(schema.rentalLineItems.deletedAt),
    ));

  const lineFleetIds = lines.flatMap((line) => line.rentalFleetId ? [line.rentalFleetId] : []);
  const requiredFleetIds = [...new Set(lineFleetIds.length > 0
    ? lineFleetIds
    : rental.rentalFleetId ? [rental.rentalFleetId] : [])];

  const inspections = await db
    .select({
      rentalFleetId: schema.inspections.rentalFleetId,
      type: schema.inspections.type,
    })
    .from(schema.inspections)
    .where(and(
      eq(schema.inspections.rentalId, rentalId),
      inArray(schema.inspections.type, ["dispatch", "return"]),
      isNull(schema.inspections.deletedAt),
    ));

  const explicitDispatchInspected = inspections.flatMap((inspection) => inspection.type === "dispatch" && inspection.rentalFleetId
    ? [inspection.rentalFleetId]
    : []);
  const explicitInspected = inspections.flatMap((inspection) => inspection.type === "return" && inspection.rentalFleetId
    ? [inspection.rentalFleetId]
    : []);
  const hasLegacyUnscopedInspection = inspections.some((inspection) => inspection.rentalFleetId == null);
  const hasLegacySingleUnitCompletion = rental.returnInspectionCompleted && requiredFleetIds.length === 1;
  const returnInspectedFleetIds = [...new Set(
    (hasLegacyUnscopedInspection || hasLegacySingleUnitCompletion) && requiredFleetIds.length === 1
      ? [...explicitInspected, requiredFleetIds[0]]
      : explicitInspected,
  )];
  const hasLegacyUnscopedDispatchInspection = inspections.some((inspection) => (
    inspection.type === "dispatch" && inspection.rentalFleetId == null
  ));
  const dispatchInspectedFleetIds = [...new Set(
    hasLegacyUnscopedDispatchInspection && requiredFleetIds.length === 1
      ? [...explicitDispatchInspected, requiredFleetIds[0]]
      : explicitDispatchInspected,
  )];

  const bypassEvents = await db
    .select({
      rentalFleetId: schema.rentalAssetProgressEvents.rentalFleetId,
      eventType: schema.rentalAssetProgressEvents.eventType,
    })
    .from(schema.rentalAssetProgressEvents)
    .where(and(
      eq(schema.rentalAssetProgressEvents.rentalRequestId, rentalId),
      inArray(schema.rentalAssetProgressEvents.eventType, [
        "dispatch_inspection_bypassed",
        "return_inspection_bypassed",
      ]),
    ));
  const returnInspectionBypassedFleetIds = [...new Set(bypassEvents.flatMap((event) => (
    event.eventType === "return_inspection_bypassed" && event.rentalFleetId ? [event.rentalFleetId] : []
  )))];
  const dispatchInspectionBypassedFleetIds = [...new Set(bypassEvents.flatMap((event) => (
    event.eventType === "dispatch_inspection_bypassed" && event.rentalFleetId ? [event.rentalFleetId] : []
  )))];

  const pickups = requiredFleetIds.length === 0 ? [] : await db
    .select({
      rentalFleetId: schema.dispatchOrders.rentalFleetId,
      status: schema.dispatchOrders.status,
    })
    .from(schema.dispatchOrders)
    .where(and(
      eq(schema.dispatchOrders.rentalRequestId, rentalId),
      eq(schema.dispatchOrders.orderType, "pickup"),
      inArray(schema.dispatchOrders.rentalFleetId, requiredFleetIds),
      notInArray(schema.dispatchOrders.status, ["completed", "cancelled"]),
      isNull(schema.dispatchOrders.deletedAt),
    ));

  const [rollingTerm] = await db
    .select({ status: schema.rentalRollingTerms.status })
    .from(schema.rentalRollingTerms)
    .where(eq(schema.rentalRollingTerms.rentalRequestId, rentalId))
    .limit(1);
  const returnOperations = await db
    .select({
      rentalFleetId: schema.rentalAssetReturnOperations.rentalFleetId,
      pickedUpAt: schema.rentalAssetReturnOperations.pickedUpAt,
    })
    .from(schema.rentalAssetReturnOperations)
    .where(eq(schema.rentalAssetReturnOperations.rentalRequestId, rentalId));
  const pickedUp = new Set(returnOperations.flatMap((operation) => (
    operation.pickedUpAt ? [operation.rentalFleetId] : []
  )));
  const rollingReturnRequired = rollingTerm?.status === "active" || rollingTerm?.status === "ending";

  return {
    requiredFleetIds,
    dispatchInspectedFleetIds,
    dispatchInspectionBypassedFleetIds,
    returnInspectedFleetIds,
    returnInspectionBypassedFleetIds,
    incompletePickupFleetIds: [...new Set(pickups.flatMap((pickup) =>
      pickup.rentalFleetId && ["pending", "assigned", "in_transit", "delivered"].includes(pickup.status)
        ? [pickup.rentalFleetId]
        : [],
    ))],
    unpickedReturnOperationFleetIds: rollingReturnRequired
      ? requiredFleetIds.filter((fleetId) => !pickedUp.has(fleetId))
      : [],
  };
}

export async function planRentalTransition(db: Db, input: {
  rentalId: number;
  targetStatus: RentalStatus;
  now?: Date;
  earlyReturn?: boolean;
  dispatchWorkflow?: boolean;
  dispatchInspectionRequired?: boolean;
  returnInspectionRequired?: boolean;
}): Promise<LifecyclePlan> {
  const [row] = await db
    .select({
      id: schema.rentalRequests.id,
      status: schema.rentalRequests.status,
      startDate: schema.rentalRequests.startDate,
      endDate: schema.rentalRequests.endDate,
      updatedAt: schema.rentalRequests.updatedAt,
    })
    .from(schema.rentalRequests)
    .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
    .limit(1);

  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
  const fulfillment = await getFulfillmentSnapshot(db, input.rentalId);

  return evaluateLifecyclePlan({
    rental: { ...row, status: row.status as RentalStatus },
    targetStatus: input.targetStatus,
    fulfillment,
    now: input.now,
    earlyReturn: input.earlyReturn,
    dispatchWorkflow: input.dispatchWorkflow,
    dispatchInspectionRequired: input.dispatchInspectionRequired,
    returnInspectionRequired: input.returnInspectionRequired,
  });
}
