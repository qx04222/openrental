/**
 * Site Settings Helper
 * Fetches company info and rental settings from the database.
 */

import { getDb } from "../db";
import * as schema from "../../drizzle/schema";

export interface CompanyInfo {
  companyName: string;
  address: string;
  phone: string;
  email: string;
  salesEmail: string;
  salesPhone: string;
  gstHstNumber: string;
  logoUrl: string;
  domain: string;
}

export async function getCompanyInfo(): Promise<CompanyInfo> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const rows = await db.select().from(schema.siteSettings);
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }

  return {
    companyName: map.company_name || "OpenRental",
    address: map.address || "",
    phone: map.contact_phone || "",
    email: map.contact_email || "",
    salesEmail: map.sales_email || "",
    salesPhone: map.sales_phone || "",
    gstHstNumber: map.gstHstNumber || "",
    logoUrl: map.logo_url || "",
    domain: map.domain || "",
  };
}

export interface RentalSettingsInfo {
  invoicePaymentTerms: string;
  invoiceDueDays: number;
  invoiceFooterNotes: string;
  invoiceAutoSend: boolean;
  orderConfirmationAutoSend: boolean;
}

export async function getRentalSettingsInfo(): Promise<RentalSettingsInfo> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const rows = await db.select().from(schema.rentalSettings);
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }

  return {
    invoicePaymentTerms: map.invoice_payment_terms || "Net 30",
    invoiceDueDays: parseInt(map.invoice_due_days || "30", 10),
    invoiceFooterNotes: map.invoice_footer_notes || "",
    invoiceAutoSend: map.invoice_auto_send === "true",
    orderConfirmationAutoSend: map.order_confirmation_auto_send === "true",
  };
}

export interface PDFSettingsInfo {
  accentColor: string;
  showLogo: boolean;
  orderFooter: string;
  dispatchFooter: string;
  inspectionFooter: string;
  invoiceFooter: string;
  quoteFooter: string;
}

export async function getPDFSettingsInfo(): Promise<PDFSettingsInfo> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const rows = await db.select().from(schema.rentalSettings);
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }

  return {
    accentColor: map.pdf_accent_color || "#2563EB",
    showLogo: map.pdf_show_logo !== "false",
    orderFooter: map.pdf_order_footer || "",
    dispatchFooter: map.pdf_dispatch_footer || "",
    inspectionFooter: map.pdf_inspection_footer || "",
    invoiceFooter: map.pdf_invoice_footer || "",
    quoteFooter: map.pdf_quote_footer || "",
  };
}
