export type AssetProgressStage =
  | "entry_pending"
  | "entry_ready"
  | "in_rental"
  | "return_pending"
  | "return_ready"
  | "completed";

export type InspectionEvidence = "pending" | "completed" | "bypassed" | "not_required";
export type AssetProgressTab = "entry" | "rental" | "return" | "completed";
export type AdminCloseReadyAsset = {
  stage: AssetProgressStage;
  pickupTransport: "disabled" | "not_required" | "pending" | "assigned" | "in_transit" | "delivered" | "completed" | "cancelled";
  rollingStatus: "active" | "ending" | "ended" | null;
  pickedUpAt: Date | string | null;
};

const STAGES: AssetProgressStage[] = [
  "entry_pending",
  "entry_ready",
  "in_rental",
  "return_pending",
  "return_ready",
  "completed",
];

export function assetProgressTab(stage: AssetProgressStage): AssetProgressTab {
  if (stage.startsWith("entry_")) return "entry";
  if (stage === "in_rental") return "rental";
  if (stage.startsWith("return_")) return "return";
  return "completed";
}

export function inspectionEvidenceTone(evidence: InspectionEvidence) {
  if (evidence === "completed") return "verified" as const;
  if (evidence === "bypassed") return "bypassed" as const;
  if (evidence === "pending") return "attention" as const;
  return "neutral" as const;
}

export function stageProgressIndex(stage: AssetProgressStage): number {
  return STAGES.indexOf(stage);
}

export function rollingOperationalTone(state: RollingOperationalState) {
  if (state === "customer_overdue") return "danger" as const;
  if (state === "awaiting_pickup" || state === "awaiting_return_inspection") return "warning" as const;
  if (state === "rolling_renewal") return "info" as const;
  if (state === "awaiting_close" || state === "completed") return "success" as const;
  return "neutral" as const;
}

export function areAssetsReadyForAdminClose(items: AdminCloseReadyAsset[]) {
  const incompletePickupStatuses = new Set<AdminCloseReadyAsset["pickupTransport"]>([
    "pending",
    "assigned",
    "in_transit",
    "delivered",
  ]);
  return items.length > 0 && items.every((item) => (
    item.stage === "return_ready"
    && !incompletePickupStatuses.has(item.pickupTransport)
    && (item.rollingStatus === null || Boolean(item.pickedUpAt))
  ));
}

export function shouldShowNextSettlement(input: {
  rentalStatus: string;
  rollingStatus: "active" | "ending" | "ended" | null;
  nextSettlementDate: Date | string | null;
}) {
  return input.rentalStatus !== "completed"
    && (input.rollingStatus === "active" || input.rollingStatus === "ending")
    && Boolean(input.nextSettlementDate);
}

export function canConfirmPhysicalPickup(input: {
  operationalState: RollingOperationalState;
  pickedUpAt: Date | string | null;
}) {
  return input.operationalState === "awaiting_pickup" && !input.pickedUpAt;
}

export function areFieldOperationsBlocked(input: { occupancyConflict: boolean }) {
  return input.occupancyConflict;
}

export function fieldProgressRefreshInterval(visibilityState: string) {
  return visibilityState === "visible" ? 30_000 : false;
}
import type { RollingOperationalState } from "@shared/rollingRental";
