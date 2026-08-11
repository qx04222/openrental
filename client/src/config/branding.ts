import { createContext, useContext } from "react";

export interface BrandingConfig {
  companyName: string;
  tagline: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  contactEmail: string;
  contactPhone: string;
  salesEmail: string;
  salesPhone: string;
  address: string;
  domain: string;
}

export const defaultBranding: BrandingConfig = {
  companyName: "OpenRental",
  tagline: "Equipment rental, run properly",
  logoUrl: "/logo.png",
  primaryColor: "#1C1917",
  accentColor: "#2563EB",
  contactEmail: "rentals@openrental.example",
  contactPhone: "+1 555-010-0100",
  salesEmail: "sales@openrental.example",
  salesPhone: "+1 555-010-0200",
  address: "100 Example Ave, Toronto, ON M5V 0A1",
  domain: "openrental.example",
};

export const BrandingContext = createContext<BrandingConfig>(defaultBranding);

export function useBranding(): BrandingConfig {
  return useContext(BrandingContext);
}
