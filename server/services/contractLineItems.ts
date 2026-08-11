/**
 * Loads enriched line items for the contract PDF: each row joined with
 * fleet + equipment_model so we have brand/model/category/asset# regardless
 * of which side (fleet vs model) holds the canonical name.
 */
import { eq, and, isNull } from "drizzle-orm";
import * as schema from "../../drizzle/schema";

type Db = NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;

export interface ContractLineItem {
  brand: string;
  model: string;
  category: string;
  assetNumber: string | null;
  itemType: "machine" | "attachment";
  quantity: number;
  customerEquipmentNote: string | null;
  startDate: Date | null;
  endDate: Date | null;
  lineSubtotal: string | null;
}

export async function loadContractLineItems(db: Db, rentalRequestId: number): Promise<ContractLineItem[]> {
  const rows = await db
    .select({
      itemType: schema.rentalLineItems.itemType,
      quantity: schema.rentalLineItems.quantity,
      customerEquipmentNote: schema.rentalLineItems.customerEquipmentNote,
      startDate: schema.rentalLineItems.startDate,
      endDate: schema.rentalLineItems.endDate,
      lineSubtotal: schema.rentalLineItems.lineSubtotal,
      fleetBrand: schema.rentalFleet.brand,
      fleetModel: schema.rentalFleet.model,
      fleetCategory: schema.rentalFleet.category,
      fleetAssetNumber: schema.rentalFleet.assetNumber,
      modelBrand: schema.equipmentModels.brand,
      modelModel: schema.equipmentModels.model,
      modelCategory: schema.equipmentModels.category,
    })
    .from(schema.rentalLineItems)
    .leftJoin(schema.rentalFleet, and(eq(schema.rentalLineItems.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
    .leftJoin(schema.equipmentModels, and(eq(schema.rentalLineItems.equipmentModelId, schema.equipmentModels.id), isNull(schema.equipmentModels.deletedAt)))
    .where(and(
      eq(schema.rentalLineItems.rentalRequestId, rentalRequestId),
      isNull(schema.rentalLineItems.deletedAt),
    ))
    .orderBy(schema.rentalLineItems.id);

  return rows.map(r => ({
    brand: r.fleetBrand || r.modelBrand || "",
    model: r.fleetModel || r.modelModel || "",
    category: r.fleetCategory || r.modelCategory || "",
    assetNumber: r.fleetAssetNumber ?? null,
    itemType: r.itemType,
    quantity: r.quantity,
    customerEquipmentNote: r.customerEquipmentNote ?? null,
    startDate: r.startDate ?? null,
    endDate: r.endDate ?? null,
    lineSubtotal: r.lineSubtotal ?? null,
  }));
}
