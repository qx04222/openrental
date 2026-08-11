export type DeliveryMethod = "pickup" | "delivery" | "delivery_and_return";
export type InsuranceType = "none" | "basic" | "full";

export interface RentalFormData {
  // Equipment
  rentalFleetId: number;
  // Dates
  startDate: string;
  endDate: string;
  // Delivery
  deliveryMethod: DeliveryMethod;
  deliveryAddress?: string;
  deliveryProvince?: string;
  pickupWarehouseId?: number;
  // Insurance
  insuranceType: InsuranceType;
  // Customer
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerCompany?: string;
  projectDescription?: string;
  customerNotes?: string;
}

export interface CostEstimate {
  rentalFee: number;
  rentalBreakdown: string;
  freightCost: number;
  insuranceCost: number;
  taxAmount: number;
  taxBreakdown: string;
  depositAmount: number;
  subtotal: number;
  totalAmount: number;
}

export interface ShippingDetails {
  distance: number;
  duration: number;
  baseFee: number;
  includedKm: number;
  excessKm: number;
  excessCost: number;
  totalCost: number;
  tierName: string;
}

export const CANADA_PROVINCES = [
  { code: "AB", name: "Alberta" },
  { code: "BC", name: "British Columbia" },
  { code: "MB", name: "Manitoba" },
  { code: "NB", name: "New Brunswick" },
  { code: "NL", name: "Newfoundland and Labrador" },
  { code: "NS", name: "Nova Scotia" },
  { code: "NT", name: "Northwest Territories" },
  { code: "NU", name: "Nunavut" },
  { code: "ON", name: "Ontario" },
  { code: "PE", name: "Prince Edward Island" },
  { code: "QC", name: "Quebec" },
  { code: "SK", name: "Saskatchewan" },
  { code: "YT", name: "Yukon" },
] as const;
