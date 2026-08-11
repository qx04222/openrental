import type { RentalOperationPolicies } from "./rentalOperationPolicies";
import { i18nError } from "../_core/i18nError";
import { and, asc, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { getFleetRentalConflicts } from "./rentalFleetConflict";
import type { FleetRentalConflict } from "./rentalFleetConflict";
import {
  deriveRollingOperationalState,
  type DelayResponsibility,
  type RollingOperationalState,
  type RollingTermStatus,
} from "../../shared/rollingRental";

export type AssetProgressStage =
  | "entry_pending"
  | "entry_ready"
  | "in_rental"
  | "return_pending"
  | "return_ready"
  | "completed";

export type InspectionProgress = "pending" | "completed" | "bypassed" | "not_required";

export type TransportProgress =
  | "disabled"
  | "not_required"
  | "pending"
  | "assigned"
  | "in_transit"
  | "delivered"
  | "completed"
  | "cancelled";

export type RentalProgressStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "active"
  | "completed"
  | "cancelled"
  | "overdue";

export type RentalProgressDeliveryMethod = "pickup" | "delivery" | "delivery_and_return";

type DispatchProgressStatus = Exclude<TransportProgress, "disabled" | "not_required">;

export interface DispatchOperationDetails {
  scheduledDate: Date | null;
  pickupAddress: string | null;
  deliveryAddress: string | null;
  distance: string | null;
  notes: string | null;
  driverNotes: string | null;
}

export interface RentalAssetProgressFacts {
  rentalRequestId: number;
  rentalFleetId: number;
  rentalNumber: string | null;
  customerName: string;
  customerPhone?: string | null;
  startDate: Date;
  endDate: Date;
  equipmentLabel: string;
  serialNumber: string | null;
  rentalStatus: RentalProgressStatus;
  deliveryMethod: RentalProgressDeliveryMethod;
  hasDispatchInspection: boolean;
  hasReturnInspection: boolean;
  hasDispatchInspectionBypass: boolean;
  hasReturnInspectionBypass: boolean;
  returnStarted: boolean;
  rollingStatus: RollingTermStatus | null;
  rollingBilledThroughDate: Date | null;
  nextSettlementDate: Date | null;
  customerReadyAt: Date | null;
  scheduledPickupAt: Date | null;
  delayResponsibility: DelayResponsibility;
  billingStopAt: Date | null;
  pickedUpAt: Date | null;
  deliveryDispatchStatus: DispatchProgressStatus | null;
  pickupDispatchStatus: DispatchProgressStatus | null;
  deliveryDispatchId: number | null;
  pickupDispatchId: number | null;
  deliveryDispatchDetails?: DispatchOperationDetails | null;
  pickupDispatchDetails?: DispatchOperationDetails | null;
  policies: RentalOperationPolicies;
  lastUpdatedAt: Date;
  occupancyConflict: boolean;
  conflictingRentals: FleetRentalConflict["rentals"];
}

export interface RentalAssetProgress {
  rentalRequestId: number;
  rentalFleetId: number;
  rentalNumber: string | null;
  customerName: string;
  customerPhone: string | null;
  startDate: Date;
  endDate: Date;
  equipmentLabel: string;
  serialNumber: string | null;
  deliveryMethod: RentalProgressDeliveryMethod;
  deliveryDispatchId: number | null;
  pickupDispatchId: number | null;
  deliveryDispatchDetails: DispatchOperationDetails | null;
  pickupDispatchDetails: DispatchOperationDetails | null;
  stage: AssetProgressStage;
  entryInspection: InspectionProgress;
  deliveryTransport: TransportProgress;
  returnInspection: InspectionProgress;
  pickupTransport: TransportProgress;
  rentalStatus: RentalProgressStatus;
  operationalState: RollingOperationalState;
  rollingStatus: RollingTermStatus | null;
  rollingBilledThroughDate: Date | null;
  nextSettlementDate: Date | null;
  customerReadyAt: Date | null;
  scheduledPickupAt: Date | null;
  delayResponsibility: DelayResponsibility;
  billingStopAt: Date | null;
  pickedUpAt: Date | null;
  lastUpdatedAt: Date;
  occupancyConflict: boolean;
  conflictingRentals: FleetRentalConflict["rentals"];
}

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ProgressReadDb = Pick<AppDb, "select">;
type ProgressWriteDb = Pick<AppDb, "insert">;
export type AssetProgressEventInput = Omit<typeof schema.rentalAssetProgressEvents.$inferInsert, "id">;

export function buildLifecycleProgressEvents(input: {
  commandKey: string;
  rentalRequestId: number;
  rentalFleetIds: number[];
  targetStatus: "approved" | "completed";
  actorUserId?: number;
  systemReturnInspectionBypassFleetIds?: number[];
  createdAt: Date;
}): AssetProgressEventInput[] {
  const events: AssetProgressEventInput[] = [];

  for (const rentalFleetId of input.systemReturnInspectionBypassFleetIds ?? []) {
    events.push({
      eventKey: `system:return_inspection_bypassed:${input.rentalRequestId}:${rentalFleetId}:credit_order_finalization`,
      rentalRequestId: input.rentalRequestId,
      rentalFleetId,
      eventType: "return_inspection_bypassed",
      fromStage: "return_pending",
      toStage: "return_ready",
      source: "system",
      reason: "credit_order_finalization",
      actorUserId: input.actorUserId,
      metadata: { commandKey: input.commandKey },
      createdAt: input.createdAt,
    });
  }

  const eventType = input.targetStatus === "approved" ? "entry_pending" : "completed";
  const fromStage = input.targetStatus === "approved" ? null : "return_ready";
  for (const rentalFleetId of input.rentalFleetIds) {
    events.push({
      eventKey: `lifecycle:${input.commandKey}:${rentalFleetId}:${eventType}`,
      rentalRequestId: input.rentalRequestId,
      rentalFleetId,
      eventType,
      fromStage,
      toStage: eventType,
      source: "rental_lifecycle",
      sourceEntityType: "rental_request",
      sourceEntityId: input.rentalRequestId,
      actorUserId: input.actorUserId,
      metadata: { commandKey: input.commandKey },
      createdAt: input.createdAt,
    });
  }

  return events;
}

function resolveInspection(
  completed: boolean,
  bypassed: boolean,
  required: boolean,
): InspectionProgress {
  if (completed) return "completed";
  if (bypassed) return "bypassed";
  return required ? "pending" : "not_required";
}

function resolveTransport(
  dispatchEnabled: boolean,
  required: boolean,
  status: DispatchProgressStatus | null,
): TransportProgress {
  if (!dispatchEnabled) return "disabled";
  if (!required) return "not_required";
  return status ?? "pending";
}

export function resolveRentalAssetProgress(facts: RentalAssetProgressFacts): RentalAssetProgress {
  const entryInspection = resolveInspection(
    facts.hasDispatchInspection,
    facts.hasDispatchInspectionBypass,
    facts.policies.dispatchInspectionRequired,
  );
  const returnInspection = resolveInspection(
    facts.hasReturnInspection,
    facts.hasReturnInspectionBypass,
    facts.policies.returnInspectionRequired,
  );

  const usesDelivery = facts.deliveryMethod !== "pickup";
  const usesPickup = facts.deliveryMethod === "delivery_and_return";
  const deliveryTransport = resolveTransport(
    facts.policies.dispatchWorkflow,
    usesDelivery,
    facts.deliveryDispatchStatus,
  );
  const pickupTransport = resolveTransport(
    facts.policies.dispatchWorkflow,
    usesPickup,
    facts.pickupDispatchStatus,
  );

  let stage: AssetProgressStage;
  if (facts.rentalStatus === "completed") {
    stage = "completed";
  } else if (facts.returnStarted || facts.customerReadyAt || facts.pickedUpAt
      || facts.hasReturnInspection || facts.hasReturnInspectionBypass) {
    stage = returnInspection === "pending" ? "return_pending" : "return_ready";
  } else if (facts.rentalStatus === "active" || facts.rentalStatus === "overdue") {
    stage = "in_rental";
  } else {
    stage = entryInspection === "pending" ? "entry_pending" : "entry_ready";
  }

  const operationalState = deriveRollingOperationalState({
    rentalStatus: facts.rentalStatus,
    rollingStatus: facts.rollingStatus,
    customerReadyAt: facts.customerReadyAt,
    pickedUpAt: facts.pickedUpAt,
    returnEvidence: returnInspection !== "pending",
    responsibility: facts.delayResponsibility,
  });

  return {
    rentalRequestId: facts.rentalRequestId,
    rentalFleetId: facts.rentalFleetId,
    rentalNumber: facts.rentalNumber,
    customerName: facts.customerName,
    customerPhone: facts.customerPhone ?? null,
    startDate: facts.startDate,
    endDate: facts.endDate,
    equipmentLabel: facts.equipmentLabel,
    serialNumber: facts.serialNumber,
    deliveryMethod: facts.deliveryMethod,
    deliveryDispatchId: facts.deliveryDispatchId,
    pickupDispatchId: facts.pickupDispatchId,
    deliveryDispatchDetails: facts.deliveryDispatchDetails ?? null,
    pickupDispatchDetails: facts.pickupDispatchDetails ?? null,
    stage,
    entryInspection,
    deliveryTransport,
    returnInspection,
    pickupTransport,
    rentalStatus: facts.rentalStatus,
    operationalState,
    rollingStatus: facts.rollingStatus,
    rollingBilledThroughDate: facts.rollingBilledThroughDate,
    nextSettlementDate: facts.nextSettlementDate,
    customerReadyAt: facts.customerReadyAt,
    scheduledPickupAt: facts.scheduledPickupAt,
    delayResponsibility: facts.delayResponsibility,
    billingStopAt: facts.billingStopAt,
    pickedUpAt: facts.pickedUpAt,
    lastUpdatedAt: facts.lastUpdatedAt,
    occupancyConflict: facts.occupancyConflict,
    conflictingRentals: facts.conflictingRentals,
  };
}

function latestDate(fallback: Date, dates: Array<Date | null | undefined>): Date {
  return dates.reduce<Date>((latest, value) => (
    value && value.getTime() > latest.getTime() ? value : latest
  ), fallback);
}

async function loadRentalAssetProgressBatchData(
  db: ProgressReadDb,
  rentalIds: number[],
  policies: RentalOperationPolicies,
) {
  const uniqueRentalIds = [...new Set(rentalIds)];
  if (uniqueRentalIds.length === 0) {
    return { progress: [] as RentalAssetProgress[], foundRentalIds: new Set<number>() };
  }

  const rentals = await db
    .select({
      id: schema.rentalRequests.id,
      rentalNumber: schema.rentalRequests.rentalNumber,
      customerName: schema.rentalRequests.customerName,
      customerPhone: schema.rentalRequests.customerPhone,
      startDate: schema.rentalRequests.startDate,
      endDate: schema.rentalRequests.endDate,
      status: schema.rentalRequests.status,
      deliveryMethod: schema.rentalRequests.deliveryMethod,
      rentalFleetId: schema.rentalRequests.rentalFleetId,
      updatedAt: schema.rentalRequests.updatedAt,
      rollingStatus: schema.rentalRollingTerms.status,
      rollingBilledThroughDate: schema.rentalRollingTerms.billedThroughDate,
      nextSettlementDate: schema.rentalRollingTerms.nextSettlementDate,
      parentBrand: schema.rentalFleet.brand,
      parentModel: schema.rentalFleet.model,
      parentSerialNumber: schema.rentalFleet.serialNumber,
    })
    .from(schema.rentalRequests)
    .leftJoin(schema.rentalRollingTerms, eq(schema.rentalRollingTerms.rentalRequestId, schema.rentalRequests.id))
    .leftJoin(schema.rentalFleet, eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id))
    .where(and(inArray(schema.rentalRequests.id, uniqueRentalIds), isNull(schema.rentalRequests.deletedAt)));

  const lineItems = await db
    .select({
      rentalRequestId: schema.rentalLineItems.rentalRequestId,
      rentalFleetId: schema.rentalLineItems.rentalFleetId,
      brand: schema.rentalFleet.brand,
      model: schema.rentalFleet.model,
      serialNumber: schema.rentalFleet.serialNumber,
    })
    .from(schema.rentalLineItems)
    .leftJoin(schema.rentalFleet, eq(schema.rentalLineItems.rentalFleetId, schema.rentalFleet.id))
    .where(and(
      inArray(schema.rentalLineItems.rentalRequestId, uniqueRentalIds),
      isNull(schema.rentalLineItems.deletedAt),
    ));

  const inspections = await db
    .select({
      id: schema.inspections.id,
      rentalRequestId: schema.inspections.rentalId,
      rentalFleetId: schema.inspections.rentalFleetId,
      type: schema.inspections.type,
      createdAt: schema.inspections.createdAt,
    })
    .from(schema.inspections)
    .where(and(inArray(schema.inspections.rentalId, uniqueRentalIds), isNull(schema.inspections.deletedAt)));

  const dispatches = await db
    .select({
      id: schema.dispatchOrders.id,
      rentalRequestId: schema.dispatchOrders.rentalRequestId,
      rentalFleetId: schema.dispatchOrders.rentalFleetId,
      orderType: schema.dispatchOrders.orderType,
      status: schema.dispatchOrders.status,
      scheduledDate: schema.dispatchOrders.scheduledDate,
      pickupAddress: schema.dispatchOrders.pickupAddress,
      deliveryAddress: schema.dispatchOrders.deliveryAddress,
      distance: schema.dispatchOrders.distance,
      notes: schema.dispatchOrders.notes,
      driverNotes: schema.dispatchOrders.driverNotes,
      updatedAt: schema.dispatchOrders.updatedAt,
    })
    .from(schema.dispatchOrders)
    .where(and(inArray(schema.dispatchOrders.rentalRequestId, uniqueRentalIds), isNull(schema.dispatchOrders.deletedAt)));

  const returnOperations = await db
    .select({
      rentalRequestId: schema.rentalAssetReturnOperations.rentalRequestId,
      rentalFleetId: schema.rentalAssetReturnOperations.rentalFleetId,
      customerReadyAt: schema.rentalAssetReturnOperations.customerReadyAt,
      scheduledPickupAt: schema.rentalAssetReturnOperations.scheduledPickupAt,
      delayResponsibility: schema.rentalAssetReturnOperations.delayResponsibility,
      billingStopAt: schema.rentalAssetReturnOperations.billingStopAt,
      pickedUpAt: schema.rentalAssetReturnOperations.pickedUpAt,
      updatedAt: schema.rentalAssetReturnOperations.updatedAt,
    })
    .from(schema.rentalAssetReturnOperations)
    .where(inArray(schema.rentalAssetReturnOperations.rentalRequestId, uniqueRentalIds));

  const events = await db
    .select({
      rentalRequestId: schema.rentalAssetProgressEvents.rentalRequestId,
      rentalFleetId: schema.rentalAssetProgressEvents.rentalFleetId,
      eventType: schema.rentalAssetProgressEvents.eventType,
      createdAt: schema.rentalAssetProgressEvents.createdAt,
    })
    .from(schema.rentalAssetProgressEvents)
    .where(inArray(schema.rentalAssetProgressEvents.rentalRequestId, uniqueRentalIds));

  const allFleetIds = rentals.flatMap((rental) => {
    const assignedIds = lineItems
      .filter((line) => line.rentalRequestId === rental.id)
      .flatMap((line) => line.rentalFleetId ? [line.rentalFleetId] : []);
    if (assignedIds.length === 0 && rental.rentalFleetId) assignedIds.push(rental.rentalFleetId);
    return assignedIds;
  });
  const conflicts = await getFleetRentalConflicts(db, allFleetIds);

  const progress = rentals.flatMap((rental) => {
    const rentalLineItems = lineItems.filter((row) => row.rentalRequestId === rental.id);
    const rentalInspections = inspections.filter((row) => row.rentalRequestId === rental.id);
    const rentalDispatches = dispatches.filter((row) => row.rentalRequestId === rental.id);
    const rentalReturnOperations = returnOperations.filter((row) => row.rentalRequestId === rental.id);
    const rentalEvents = events.filter((row) => row.rentalRequestId === rental.id);
    const assignedIds = rentalLineItems.flatMap((line) => line.rentalFleetId ? [line.rentalFleetId] : []);
    if (assignedIds.length === 0 && rental.rentalFleetId) assignedIds.push(rental.rentalFleetId);
    const fleetIds = [...new Set(assignedIds)].sort((a, b) => a - b);
    const legacySingleUnit = fleetIds.length === 1;

    return fleetIds.map((rentalFleetId) => {
    const lineItem = rentalLineItems.find((row) => row.rentalFleetId === rentalFleetId);
    const unitInspections = rentalInspections.filter((row) => (
      row.rentalFleetId === rentalFleetId || (legacySingleUnit && row.rentalFleetId == null)
    ));
    const unitDispatches = rentalDispatches.filter((row) => row.rentalFleetId === rentalFleetId);
    const unitEvents = rentalEvents.filter((row) => row.rentalFleetId === rentalFleetId);
    const returnOperation = rentalReturnOperations.find((row) => row.rentalFleetId === rentalFleetId);
    const conflict = conflicts.get(rentalFleetId);
    const latestDispatch = (orderType: "delivery" | "pickup") => unitDispatches
      .filter((row) => row.orderType === orderType)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];
    const deliveryDispatch = latestDispatch("delivery");
    const pickupDispatch = latestDispatch("pickup");

    return resolveRentalAssetProgress({
      rentalRequestId: rental.id,
      rentalFleetId,
      rentalNumber: rental.rentalNumber,
      customerName: rental.customerName,
      customerPhone: rental.customerPhone,
      startDate: rental.startDate,
      endDate: rental.endDate,
      equipmentLabel: [lineItem?.brand ?? rental.parentBrand, lineItem?.model ?? rental.parentModel].filter(Boolean).join(" ") || `Fleet #${rentalFleetId}`,
      serialNumber: lineItem?.serialNumber ?? rental.parentSerialNumber ?? null,
      rentalStatus: rental.status as RentalProgressStatus,
      deliveryMethod: rental.deliveryMethod as RentalProgressDeliveryMethod,
      hasDispatchInspection: unitInspections.some((row) => row.type === "dispatch"),
      hasReturnInspection: unitInspections.some((row) => row.type === "return"),
      hasDispatchInspectionBypass: unitEvents.some((row) => row.eventType === "dispatch_inspection_bypassed"),
      hasReturnInspectionBypass: unitEvents.some((row) => row.eventType === "return_inspection_bypassed"),
      returnStarted: unitEvents.some((row) => row.eventType === "return_started"),
      rollingStatus: (rental.rollingStatus as RollingTermStatus | null | undefined) ?? null,
      rollingBilledThroughDate: rental.rollingBilledThroughDate ?? null,
      nextSettlementDate: rental.nextSettlementDate ?? null,
      customerReadyAt: returnOperation?.customerReadyAt ?? null,
      scheduledPickupAt: returnOperation?.scheduledPickupAt ?? null,
      delayResponsibility: (returnOperation?.delayResponsibility as DelayResponsibility | undefined) ?? "none",
      billingStopAt: returnOperation?.billingStopAt ?? null,
      pickedUpAt: returnOperation?.pickedUpAt ?? null,
      deliveryDispatchStatus: deliveryDispatch?.status ?? null,
      pickupDispatchStatus: pickupDispatch?.status ?? null,
      deliveryDispatchId: deliveryDispatch?.id ?? null,
      pickupDispatchId: pickupDispatch?.id ?? null,
      deliveryDispatchDetails: deliveryDispatch ? {
        scheduledDate: deliveryDispatch.scheduledDate,
        pickupAddress: deliveryDispatch.pickupAddress,
        deliveryAddress: deliveryDispatch.deliveryAddress,
        distance: deliveryDispatch.distance,
        notes: deliveryDispatch.notes,
        driverNotes: deliveryDispatch.driverNotes,
      } : null,
      pickupDispatchDetails: pickupDispatch ? {
        scheduledDate: pickupDispatch.scheduledDate,
        pickupAddress: pickupDispatch.pickupAddress,
        deliveryAddress: pickupDispatch.deliveryAddress,
        distance: pickupDispatch.distance,
        notes: pickupDispatch.notes,
        driverNotes: pickupDispatch.driverNotes,
      } : null,
      policies,
      lastUpdatedAt: latestDate(rental.updatedAt, [
        ...unitInspections.map((row) => row.createdAt),
        ...unitDispatches.map((row) => row.updatedAt),
        returnOperation?.updatedAt,
        ...unitEvents.map((row) => row.createdAt),
      ]),
      occupancyConflict: Boolean(conflict),
      conflictingRentals: conflict?.rentals ?? [],
    });
    });
  });

  return { progress, foundRentalIds: new Set(rentals.map((rental) => rental.id)) };
}

export async function loadRentalAssetProgressBatch(
  db: ProgressReadDb,
  rentalIds: number[],
  policies: RentalOperationPolicies,
): Promise<RentalAssetProgress[]> {
  return (await loadRentalAssetProgressBatchData(db, rentalIds, policies)).progress;
}

export async function loadRentalAssetProgress(
  db: ProgressReadDb,
  rentalId: number,
  policies: RentalOperationPolicies,
): Promise<RentalAssetProgress[]> {
  const result = await loadRentalAssetProgressBatchData(db, [rentalId], policies);
  if (!result.foundRentalIds.has(rentalId)) {
    throw i18nError({
      code: "NOT_FOUND",
      message: "Rental not found",
      i18nKey: "errors.rentalNotFound",
    });
  }
  return result.progress;
}

export async function recordAssetProgressEvent(
  db: ProgressWriteDb,
  event: AssetProgressEventInput,
): Promise<void> {
  await db
    .insert(schema.rentalAssetProgressEvents)
    .values(event)
    .onConflictDoNothing({ target: schema.rentalAssetProgressEvents.eventKey });
}

export function filterFieldProgressByDispatchAssignments(
  progress: RentalAssetProgress[],
  assignments: Array<{ rentalRequestId: number | null; rentalFleetId: number | null }>,
  dispatchEnabled: boolean,
): RentalAssetProgress[] {
  if (!dispatchEnabled) return progress;
  const assignedKeys = new Set(assignments.flatMap((row) => (
    row.rentalRequestId && row.rentalFleetId ? [`${row.rentalRequestId}:${row.rentalFleetId}`] : []
  )));
  return progress.filter((item) => assignedKeys.has(`${item.rentalRequestId}:${item.rentalFleetId}`));
}

export async function loadFieldRentalAssetProgress(
  db: ProgressReadDb,
  userId: number,
  policies: RentalOperationPolicies,
): Promise<RentalAssetProgress[]> {
  let assignments: Array<{ rentalRequestId: number | null; rentalFleetId: number | null }> = [];
  if (policies.dispatchWorkflow) {
    const [driver] = await db
      .select({ id: schema.drivers.id })
      .from(schema.drivers)
      .where(and(eq(schema.drivers.userId, userId), isNull(schema.drivers.deletedAt)));
    if (!driver) return [];
    assignments = await db
      .select({
        rentalRequestId: schema.dispatchOrders.rentalRequestId,
        rentalFleetId: schema.dispatchOrders.rentalFleetId,
      })
      .from(schema.dispatchOrders)
      .where(and(
        eq(schema.dispatchOrders.assignedDriverId, driver.id),
        isNull(schema.dispatchOrders.deletedAt),
      ));
  }

  const recentCompletionCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rentals = await db
    .select({ id: schema.rentalRequests.id })
    .from(schema.rentalRequests)
    .where(and(
      or(
        inArray(schema.rentalRequests.status, ["approved", "active", "overdue"]),
        and(
          eq(schema.rentalRequests.status, "completed"),
          gte(schema.rentalRequests.updatedAt, recentCompletionCutoff),
        ),
      ),
      isNull(schema.rentalRequests.deletedAt),
    ))
    .orderBy(desc(schema.rentalRequests.updatedAt));

  const result = await loadRentalAssetProgressBatch(db, rentals.map((rental) => rental.id), policies);
  return filterFieldProgressByDispatchAssignments(result, assignments, policies.dispatchWorkflow);
}

export async function listAssetProgressEvents(
  db: ProgressReadDb,
  rentalId: number,
  rentalFleetId: number,
) {
  return db
    .select({
      id: schema.rentalAssetProgressEvents.id,
      eventType: schema.rentalAssetProgressEvents.eventType,
      fromStage: schema.rentalAssetProgressEvents.fromStage,
      toStage: schema.rentalAssetProgressEvents.toStage,
      source: schema.rentalAssetProgressEvents.source,
      sourceEntityType: schema.rentalAssetProgressEvents.sourceEntityType,
      sourceEntityId: schema.rentalAssetProgressEvents.sourceEntityId,
      reason: schema.rentalAssetProgressEvents.reason,
      actorUserId: schema.rentalAssetProgressEvents.actorUserId,
      actorName: schema.users.name,
      metadata: schema.rentalAssetProgressEvents.metadata,
      createdAt: schema.rentalAssetProgressEvents.createdAt,
    })
    .from(schema.rentalAssetProgressEvents)
    .leftJoin(schema.users, eq(schema.rentalAssetProgressEvents.actorUserId, schema.users.id))
    .where(and(
      eq(schema.rentalAssetProgressEvents.rentalRequestId, rentalId),
      eq(schema.rentalAssetProgressEvents.rentalFleetId, rentalFleetId),
    ))
    .orderBy(asc(schema.rentalAssetProgressEvents.createdAt));
}
