// Extra-charge reasons (额外收费原因). damage_claims is generalized to carry any
// of these via its chargeType column. "damage" keeps the full claim lifecycle
// (pending→estimated→accepted→invoiced); the rest are simple charges that bill
// directly. Reference: common heavy-equipment extra charges.

export const EXTRA_CHARGE_REASONS = ["damage", "fuel", "cleaning", "overtime", "transport", "swap", "other"] as const;
export type ExtraChargeReason = (typeof EXTRA_CHARGE_REASONS)[number];

export const EXTRA_CHARGE_LABELS: Record<ExtraChargeReason, { en: string; zh: string }> = {
  damage: { en: "Damage", zh: "损坏赔偿" },
  fuel: { en: "Fuel / refuel", zh: "加油 / 燃油补费" },
  cleaning: { en: "Cleaning", zh: "清洁费" },
  overtime: { en: "Overtime", zh: "超时" },
  transport: { en: "Transport", zh: "运输" },
  swap: { en: "Equipment swap", zh: "换机调整费" },
  other: { en: "Other", zh: "其他" },
};

// Invoice line type per reason (damage already has a dedicated lineType).
export function chargeLineType(reason: string): string {
  return reason === "fuel" ? "fuel_surcharge" : reason === "damage" ? "damage" : "extra_charge";
}
