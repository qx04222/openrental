/**
 * Fuel Settlement Calculation
 * Canadian units: litres, CAD/litre
 * Policy: full_to_full (default), included, excluded
 */

export interface FuelCalculationInput {
  fuelPolicy: "full_to_full" | "included" | "excluded";
  dispatchFuelLevel: number;  // percentage 0-100
  returnFuelLevel: number;    // percentage 0-100
  tankCapacityLitres: number;
  pricePerLitre: number;      // CAD/litre
}

export interface FuelCalculationResult {
  litresShort: number;
  surcharge: number;
  breakdown: string;
}

export function calculateFuelSurcharge(input: FuelCalculationInput): FuelCalculationResult {
  const { fuelPolicy, dispatchFuelLevel, returnFuelLevel, tankCapacityLitres, pricePerLitre } = input;

  // No surcharge for included or excluded policies
  if (fuelPolicy !== "full_to_full") {
    return { litresShort: 0, surcharge: 0, breakdown: `Fuel: ${fuelPolicy}` };
  }

  // Calculate litre difference
  const levelDiff = Math.max(0, dispatchFuelLevel - returnFuelLevel);
  const litresShort = Math.round((levelDiff / 100) * tankCapacityLitres * 100) / 100;
  const surcharge = Math.round(litresShort * pricePerLitre * 100) / 100;

  if (litresShort <= 0) {
    return { litresShort: 0, surcharge: 0, breakdown: "Fuel: returned full" };
  }

  return {
    litresShort,
    surcharge,
    breakdown: `Fuel: ${litresShort.toFixed(1)}L short × $${pricePerLitre.toFixed(2)}/L = $${surcharge.toFixed(2)}`,
  };
}
