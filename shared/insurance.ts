export const INSURANCE_OPTIONS = {
  none: {
    label: "No Insurance",
    description: "Customer assumes full responsibility for any damage or loss during the rental period. Recommended only when the customer has their own comprehensive equipment insurance policy.",
    costPercentage: 0,
    deductible: null,
    coverage: "No coverage – customer liable for all damages, theft, vandalism, and accidental loss. Customer must provide proof of third-party liability insurance.",
  },
  basic: {
    label: "Basic Insurance (LDW)",
    description: "Loss Damage Waiver covering major structural damage with a $1,000 deductible. Includes protection against accidental damage during normal operation. Does not cover theft, vandalism, or operator negligence.",
    costPercentage: 0.15,
    deductible: 1000,
    coverage: "Covers accidental damage over $1,000 deductible. Includes: structural damage, hydraulic system failures during normal use, tire/track damage from job site conditions. Excludes: theft, vandalism, operator negligence, cosmetic damage.",
  },
  full: {
    label: "Full Coverage Insurance",
    description: "Comprehensive protection with $0 deductible. Covers all damage including theft, vandalism, and accidental loss. Ideal for high-value equipment or remote job sites.",
    costPercentage: 0.25,
    deductible: 0,
    coverage: "Full coverage with zero deductible. Includes: all accidental damage, theft, vandalism, fire, flood, and weather-related damage. Covers equipment during transport and on job site. Excludes only intentional damage and use outside agreed terms.",
  },
} as const;

export type InsuranceType = keyof typeof INSURANCE_OPTIONS;

export const DEPOSIT_CONFIG = {
  percentageOfValue: 0.2,
  fallbackDeposits: {
    industrial: 5000,
    powersports: 1000,
  },
};

export function calculateInsuranceCost(rentalTotal: number, insuranceType: InsuranceType): number {
  const option = INSURANCE_OPTIONS[insuranceType];
  return Math.round(rentalTotal * option.costPercentage * 100) / 100;
}

export function calculateDeposit(equipmentPrice: number | null, division?: string): number {
  if (equipmentPrice && equipmentPrice > 0) {
    return Math.round(equipmentPrice * DEPOSIT_CONFIG.percentageOfValue * 100) / 100;
  }
  const key = division === "powersports" ? "powersports" : "industrial";
  return DEPOSIT_CONFIG.fallbackDeposits[key];
}
