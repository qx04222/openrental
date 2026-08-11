/**
 * Contract PDF Generation
 * Professional rental contract with logo, bilingual support, and clean layout
 */

import { existsSync } from "fs";
import { resolve } from "path";
import { uploadContractToStorage } from "./storage";
import { logger } from "../_core/logger";
import { BRAND_CONTACT } from "../../shared/const";
import { registerCJKFont, registerSignatureFont } from "./pdfFontHelper";
import { getDb, eq } from "../db";
import * as schema from "../../drizzle/schema";
import { APP_TIMEZONE } from "../_core/dateUtils";

const fmt = (v: string | number | null | undefined) => Number(v || 0).toFixed(2);

// Brand color
const BRAND_ACCENT = "#2563EB";
const DARK = "#000000";
const GRAY = "#000000";
const LIGHT_GRAY = "#000000";
const BORDER = "#e0e0e0";
const BG_LIGHT = "#f8f8f8";

// Logo path candidates
const LOGO_CANDIDATES = [
  // Clean contract-specific logo (no tagline) preferred; fall back to site logo.
  resolve(process.cwd(), "client/public/contract-logo.png"),
  resolve(process.cwd(), "dist/public/contract-logo.png"),
  resolve(process.cwd(), "client/public/logo.png"),
  resolve(process.cwd(), "dist/public/logo.png"),
];

function getLogoPath(): string | null {
  return LOGO_CANDIDATES.find((p) => existsSync(p)) || null;
}

const DEFAULT_CONTRACT_TERMS = [
  "The renter agrees to use the equipment in a safe and proper manner and in compliance with all applicable laws and regulations.",
  "The renter is responsible for any damage to the equipment during the rental period, except for normal wear and tear.",
  "The renter must return the equipment in the same condition as received, clean and in good working order.",
  "Late returns may incur additional charges at the daily rental rate.",
  "The renter must maintain adequate insurance coverage for the equipment during the rental period.",
  "{companyName} is not liable for any damages or injuries resulting from the use of the rented equipment.",
];

interface CompanyInfo {
  companyName: string;
  address: string;
  rentalPhone: string;
  rentalEmail: string;
  // Built-in Lessor signature. Configured via Site Settings:
  //   contract_rep_signature : uploaded signature image (data URL / base64)
  //   contract_rep_name      : typeset fallback when no image is uploaded
  //   contract_rep_title     : credit line under the signature
  // Resolution: uploaded image → typeset name → blank line.
  repSignatureImage: string;
  repName: string;
  repTitle: string;
}

async function getCompanyInfo(): Promise<CompanyInfo> {
  const defaults: CompanyInfo = {
    companyName: BRAND_CONTACT.companyName,
    address: BRAND_CONTACT.address,
    rentalPhone: BRAND_CONTACT.rentalPhone,
    rentalEmail: BRAND_CONTACT.rentalEmail,
    repSignatureImage: "",
    repName: "",
    repTitle: "Authorized Representative",
  };
  try {
    const db = await getDb();
    if (!db) return defaults;
    const settings = await db.select().from(schema.siteSettings);
    const map: Record<string, string> = {};
    for (const s of settings) map[s.key] = s.value;
    return {
      companyName: map["company_name"] || defaults.companyName,
      address: map["company_address"] || defaults.address,
      rentalPhone: map["company_phone"] || defaults.rentalPhone,
      rentalEmail: map["company_email"] || defaults.rentalEmail,
      repSignatureImage: map["contract_rep_signature"] || defaults.repSignatureImage,
      repName: map["contract_rep_name"] || defaults.repName,
      repTitle: map["contract_rep_title"] || defaults.repTitle,
    };
  } catch {
    return defaults;
  }
}

interface FleetIdentifiers {
  vin: string | null;
  serialNumber: string | null;
  assetNumber: string | null;
  dailyRate: string | null;
  weeklyRate: string | null;
  monthlyRate: string | null;
}

/**
 * Pull identifiers + rate card for a rental's primary fleet unit, used to
 * auto-fill the contract body (VIN/serial, daily/weekly/monthly rates).
 * Rates fall back fleet -> equipment_model (fleet rows usually leave them null).
 */
async function getFleetIdentifiers(rentalId: number): Promise<FleetIdentifiers | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const [row] = await db
      .select({
        vin: schema.rentalFleet.vin,
        serialNumber: schema.rentalFleet.serialNumber,
        assetNumber: schema.rentalFleet.assetNumber,
        fleetDaily: schema.rentalFleet.dailyRate,
        fleetWeekly: schema.rentalFleet.weeklyRate,
        fleetMonthly: schema.rentalFleet.monthlyRate,
        modelDaily: schema.equipmentModels.dailyRate,
        modelWeekly: schema.equipmentModels.weeklyRate,
        modelMonthly: schema.equipmentModels.monthlyRate,
      })
      .from(schema.rentalRequests)
      .innerJoin(schema.rentalFleet, eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id))
      .leftJoin(schema.equipmentModels, eq(schema.rentalFleet.equipmentModelId, schema.equipmentModels.id))
      .where(eq(schema.rentalRequests.id, rentalId))
      .limit(1);
    if (!row) return null;
    return {
      vin: row.vin,
      serialNumber: row.serialNumber,
      assetNumber: row.assetNumber,
      dailyRate: row.fleetDaily ?? row.modelDaily,
      weeklyRate: row.fleetWeekly ?? row.modelWeekly,
      monthlyRate: row.fleetMonthly ?? row.modelMonthly,
    };
  } catch {
    return null;
  }
}

function substituteVariables(content: string, vars: Record<string, string>): string {
  return content.replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match);
}

interface TemplateResult {
  content: string;
  isMarkdown: boolean;
}

async function getContractTemplate(contractTemplateId?: number | null): Promise<TemplateResult> {
  try {
    const db = await getDb();
    if (!db) return { content: DEFAULT_CONTRACT_TERMS.join("\n\n"), isMarkdown: false };

    if (contractTemplateId) {
      const [template] = await db.select().from(schema.contractTemplates)
        .where(eq(schema.contractTemplates.id, contractTemplateId)).limit(1);
      if (template) return { content: template.content, isMarkdown: /^#{1,3}\s+/m.test(template.content) };
    }

    const [defaultTemplate] = await db.select().from(schema.contractTemplates)
      .where(eq(schema.contractTemplates.isDefault, true)).limit(1);
    if (defaultTemplate) return { content: defaultTemplate.content, isMarkdown: /^#{1,3}\s+/m.test(defaultTemplate.content) };

    const results = await db.select().from(schema.rentalSettings);
    const settingsMap = Object.fromEntries(results.map((r) => [r.key, r.value]));
    const termsJson = settingsMap["contract_terms"];
    if (termsJson) {
      const parsed = JSON.parse(termsJson);
      if (Array.isArray(parsed) && parsed.length > 0) return { content: parsed.join("\n\n"), isMarkdown: false };
    }
  } catch { /* fall through */ }
  return { content: DEFAULT_CONTRACT_TERMS.join("\n\n"), isMarkdown: false };
}

export interface ContractLineItem {
  brand: string;
  model: string;
  category: string;
  assetNumber?: string | null;
  itemType: "machine" | "attachment";
  quantity: number;
  customerEquipmentNote?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  lineSubtotal?: string | null;
}

interface ContractData {
  rentalId: number;
  rentalNumber?: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  companyName?: string;
  // Single-item legacy fields. Used when `items` is empty.
  equipmentBrand: string;
  equipmentModel: string;
  equipmentCategory: string;
  // Multi-item: when present, the PDF renders a line-items table instead of
  // the single equipmentBrand/Model line.
  items?: ContractLineItem[];
  startDate: Date;
  endDate: Date;
  rentalDays: number;
  rentalFee: string;
  freightCost: string;
  insuranceCost: string;
  taxAmount: string;
  depositAmount?: string;
  totalCost: string;
  // Customer discount % (already reflected in rentalFee) and price-match note.
  customerDiscountPercent?: string | null;
  priceMatchEnabled?: boolean;
  priceMatchCompetitor?: string | null;
  priceMatchAmount?: string | null;
  deliveryAddress: string;
  projectDescription?: string;
  contractTemplateId?: number | null;
  // Customer signature image (data URL or base64). When present, embedded on the signature line.
  customerSignature?: string | null;
  customerSignedAt?: Date | null;
  // Company representative signature image
  repSignature?: string | null;
  repSignedAt?: Date | null;
  // Signature evidence (appended when signature_evidence flag is on)
  signatureEvidence?: {
    signedAt: Date;
    ip: string | null;
    userAgent: string | null;
    contractHash: string | null;
  };
}

function decodeSignatureToBuffer(input: string | null | undefined): Buffer | null {
  if (!input) return null;
  try {
    const m = input.match(/^data:image\/[a-zA-Z+]+;base64,(.+)$/);
    const b64 = m ? m[1] : input;
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}

export async function generateContractPDF(data: ContractData): Promise<{ url: string; version: number }> {
  try {
    const { default: PDFDocument } = await import("pdfkit");

    const [company, template, fleetIds] = await Promise.all([
      getCompanyInfo(),
      getContractTemplate(data.contractTemplateId),
      getFleetIdentifiers(data.rentalId),
    ]);

    // Two distinct semantics — do NOT merge these back into one options object.
    //
    // dateOpts renders calendar-date COLUMNS (startDate/endDate). Those are
    // anchored to a calendar day, so a bare render on the UTC container already
    // prints the intended day — both for Toronto-midnight rows (04:00/05:00 UTC,
    // written since the parseCalendarDate fix) and for legacy 00:00:00 UTC rows.
    // Adding a timeZone here would shift the legacy rows BACK one day.
    // rental_line_items (rendered in the items table below) was never re-anchored
    // — sql/102 covered rental_requests only — so it must keep the bare render.
    const dateOpts: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" };
    // instantDateOpts renders real instants ("now", signed-at). The production
    // container runs UTC, so a bare render prints tomorrow's date after 20:00
    // EDT. Contracts are legal documents — anchor the instant to Toronto.
    const instantDateOpts: Intl.DateTimeFormatOptions = { timeZone: APP_TIMEZONE, year: "numeric", month: "long", day: "numeric" };
    const todayStr = new Date().toLocaleDateString("en-US", instantDateOpts);
    const BLANK = "__________";
    const rate = (v: string | null | undefined) => v != null && Number(v) > 0 ? `$${fmt(v)}` : BLANK;
    // Equipment serial: prefer VIN, then manufacturer serial, then asset number;
    // legacy single-line rentals with no fleet link fall back to a blank.
    const serial = fleetIds?.vin || fleetIds?.serialNumber || fleetIds?.assetNumber
      || (data.items && data.items.length === 1 ? data.items[0].assetNumber : null)
      || (data.items && data.items.length > 1 ? "See Order Items above" : null)
      || BLANK;
    const depositStr = data.depositAmount && Number(data.depositAmount) > 0
      ? `$${fmt(data.depositAmount)}`
      : BLANK;

    const variables: Record<string, string> = {
      companyName: company.companyName,
      customerName: data.customerName,
      equipmentDescription: `${data.equipmentBrand} ${data.equipmentModel}`,
      equipmentSerial: serial,
      startDate: data.startDate.toLocaleDateString("en-US", dateOpts),
      endDate: data.endDate.toLocaleDateString("en-US", dateOpts),
      deliveryAddress: data.deliveryAddress || BLANK,
      dailyRate: rate(fleetIds?.dailyRate),
      weeklyRate: rate(fleetIds?.weeklyRate),
      monthlyRate: rate(fleetIds?.monthlyRate),
      deposit: depositStr,
      totalAmount: `$${fmt(data.totalCost)}`,
      agreementNumber: data.rentalNumber || `#${data.rentalId}`,
      effectiveDate: todayStr,
      signatureDate: todayStr,
      renterSignature: "",
    };

    const M = 50; // margin
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 40, bottom: 40, left: M, right: M } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    const pdfPromise = new Promise<Buffer>((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    });

    registerCJKFont(doc);
    const hasScriptFont = registerSignatureFont(doc);

    const pageW = 612; // Letter width
    const contentW = pageW - M * 2;
    const hasCJK = (s: string) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s);
    const cjkOk = (() => { try { doc.font("NotoSansSC"); doc.font("Helvetica"); return true; } catch { return false; } })();
    const fontFor = (text: string, bold = false) => {
      if (cjkOk && hasCJK(text)) return "NotoSansSC";
      return bold ? "Helvetica-Bold" : "Helvetica";
    };

    // ─── HEADER WITH LOGO ────────────────────────────────────────
    const logoPath = getLogoPath();
    if (logoPath) {
      try {
        const logoH = 52;
        doc.image(logoPath, M, 40, { height: logoH });
        // Company info right-aligned next to logo
        const infoX = pageW - M - 200;
        doc.fontSize(8).font("Helvetica").fillColor(GRAY);
        doc.text(company.address, infoX, 45, { width: 200, align: "right" });
        doc.text(`Tel: ${company.rentalPhone}`, infoX, doc.y, { width: 200, align: "right" });
        doc.text(company.rentalEmail, infoX, doc.y, { width: 200, align: "right" });
        doc.y = 40 + logoH + 10;
      } catch {
        // Logo failed, fall back to text header
        doc.fontSize(16).font("Helvetica-Bold").fillColor(BRAND_ACCENT)
          .text(company.companyName, { align: "center" });
        doc.fontSize(8).font("Helvetica").fillColor(GRAY)
          .text(`${company.address} | ${company.rentalPhone} | ${company.rentalEmail}`, { align: "center" });
        doc.moveDown(0.5);
      }
    } else {
      doc.fontSize(16).font("Helvetica-Bold").fillColor(BRAND_ACCENT)
        .text(company.companyName, { align: "center" });
      doc.fontSize(8).font("Helvetica").fillColor(GRAY)
        .text(`${company.address} | ${company.rentalPhone} | ${company.rentalEmail}`, { align: "center" });
      doc.moveDown(0.5);
    }

    // Red divider line
    const divY = doc.y + 2;
    doc.moveTo(M, divY).lineTo(pageW - M, divY).lineWidth(2).strokeColor(BRAND_ACCENT).stroke();
    doc.y = divY + 8;

    // ─── TITLE ───────────────────────────────────────────────────
    doc.fontSize(16).font("Helvetica-Bold").fillColor(DARK)
      .text("EQUIPMENT RENTAL AGREEMENT", M, doc.y, { width: contentW, align: "center" });
    doc.moveDown(0.8);

    // ─── CONTRACT ID BAR ─────────────────────────────────────────
    const barY = doc.y;
    doc.rect(M, barY, contentW, 22).fill(BG_LIGHT);
    const contractLabel = `Contract No: ${data.rentalNumber || `#${data.rentalId}`}`;
    const dateLabel = `Date: ${todayStr}`;
    doc.fontSize(9).font(fontFor(contractLabel, true)).fillColor(DARK)
      .text(contractLabel, M + 10, barY + 5);
    doc.font(fontFor(dateLabel)).fillColor(GRAY)
      .text(dateLabel, M + 10, barY + 5, { width: contentW - 20, align: "right" });
    doc.y = barY + 30;

    // ─── INFO GRID (2 columns) ───────────────────────────────────
    const colW = contentW / 2 - 5;
    const gridStartY = doc.y;

    const drawSectionTitle = (title: string, x: number) => {
      doc.fontSize(10).font(fontFor(title, true)).fillColor(BRAND_ACCENT).text(title, x, doc.y);
      doc.moveTo(x, doc.y + 2).lineTo(x + colW, doc.y + 2).lineWidth(0.5).strokeColor(BORDER).stroke();
      doc.moveDown(0.3);
    };

    const drawField = (label: string, value: string, x: number) => {
      doc.fontSize(8).font(fontFor(label)).fillColor(LIGHT_GRAY).text(label, x, doc.y);
      doc.fontSize(9).font(fontFor(value)).fillColor(DARK).text(value || "-", x, doc.y);
      doc.moveDown(0.15);
    };

    // Left column: Customer
    drawSectionTitle("Customer Information", M);
    drawField("Name", data.customerName, M);
    if (data.companyName) drawField("Company", data.companyName, M);
    drawField("Email", data.customerEmail, M);
    drawField("Phone", data.customerPhone, M);
    const leftEndY = doc.y;

    // Right column: Equipment
    doc.y = gridStartY;
    const rightX = M + colW + 10;
    drawSectionTitle("Equipment Information", rightX);
    const items = data.items && data.items.length > 0 ? data.items : null;
    if (items && items.length > 1) {
      // Multi-item summary on the right column — short, with a full table below
      doc.fontSize(8).font(fontFor("Items")).fillColor(LIGHT_GRAY).text("Items", rightX, doc.y);
      doc.fontSize(9).font(fontFor("count")).fillColor(DARK).text(`${items.length} items (see table below)`, rightX, doc.y);
      doc.moveDown(0.15);
    } else {
      drawField("Brand", data.equipmentBrand, rightX);
      drawField("Model", data.equipmentModel, rightX);
      drawField("Category", data.equipmentCategory, rightX);
      if (fleetIds?.vin) drawField("VIN", fleetIds.vin, rightX);
      if (fleetIds?.serialNumber) drawField("S/N", fleetIds.serialNumber, rightX);
    }
    const rightEndY = doc.y;

    doc.y = Math.max(leftEndY, rightEndY) + 8;

    // ─── ITEMS TABLE (multi-item only) ────────────────────────────
    if (items && items.length > 1) {
      drawSectionTitle("Order Items", M);
      const tblX = M;
      const colNo = 22;
      const colEquip = 168;
      const colQty = 30;
      const colDates = 140;
      const colPrice = contentW - (colNo + colEquip + colQty + colDates);
      let yRow = doc.y;
      // Header row
      doc.fontSize(8).font("Helvetica-Bold").fillColor(LIGHT_GRAY);
      doc.text("#", tblX, yRow, { width: colNo });
      doc.text("Equipment", tblX + colNo, yRow, { width: colEquip });
      doc.text("Qty", tblX + colNo + colEquip, yRow, { width: colQty });
      doc.text("Rental Period", tblX + colNo + colEquip + colQty, yRow, { width: colDates });
      doc.text("Price", tblX + colNo + colEquip + colQty + colDates, yRow, { width: colPrice, align: "right" });
      doc.moveDown(0.6);
      // Body rows
      items.forEach((it, i) => {
        yRow = doc.y;
        const equip = `${it.brand || ""} ${it.model || ""}`.trim() || "-";
        const period = (it.startDate && it.endDate)
          ? `${it.startDate.toLocaleDateString("en-US", dateOpts)} – ${it.endDate.toLocaleDateString("en-US", dateOpts)}`
          : "Order dates";
        const price = (it.lineSubtotal != null && it.lineSubtotal !== "")
          ? `$${fmt(it.lineSubtotal)}` : "—";
        doc.fontSize(9).font(fontFor(equip)).fillColor(DARK);
        doc.text(String(i + 1), tblX, yRow, { width: colNo });
        doc.text(equip, tblX + colNo, yRow, { width: colEquip });
        doc.text(String(it.quantity), tblX + colNo + colEquip, yRow, { width: colQty });
        doc.fontSize(8).text(period, tblX + colNo + colEquip + colQty, yRow, { width: colDates });
        doc.fontSize(9).font("Helvetica").text(price, tblX + colNo + colEquip + colQty + colDates, yRow, { width: colPrice, align: "right" });
        if (it.customerEquipmentNote) {
          doc.fontSize(8).fillColor(GRAY).text(`  on customer machine: ${it.customerEquipmentNote}`, tblX + colNo, doc.y, { width: contentW - colNo });
        }
        doc.moveDown(0.3);
      });
      doc.moveDown(0.3);
    }

    // ─── RENTAL DETAILS ──────────────────────────────────────────
    drawSectionTitle("Rental Details", M);
    const detailY = doc.y;
    drawField("Start Date", data.startDate.toLocaleDateString("en-US", dateOpts), M);
    drawField("End Date", data.endDate.toLocaleDateString("en-US", dateOpts), M);
    const detailLeftEnd = doc.y;
    doc.y = detailY;
    drawField("Duration", `${data.rentalDays} days`, rightX);
    drawField("Delivery Address", data.deliveryAddress, rightX);
    if (data.projectDescription) drawField("Project", data.projectDescription, rightX);
    doc.y = Math.max(detailLeftEnd, doc.y) + 8;

    // ─── PRICING TABLE ───────────────────────────────────────────
    drawSectionTitle("Pricing Breakdown", M);
    const tableX = M;
    const labelW = contentW * 0.65;
    const valW = contentW * 0.35;

    const drawRow = (label: string, value: string, opts?: { bold?: boolean; bg?: string; border?: boolean }) => {
      const y = doc.y;
      const rowH = 18;
      if (opts?.bg) {
        doc.rect(tableX, y, contentW, rowH).fill(opts.bg);
      }
      if (opts?.border) {
        doc.moveTo(tableX, y).lineTo(tableX + contentW, y).lineWidth(0.5).strokeColor(BORDER).stroke();
      }
      const fontSize = opts?.bold ? 10 : 9;
      doc.fontSize(fontSize).font(fontFor(label, opts?.bold)).fillColor(DARK);
      doc.text(label, tableX + 8, y + 4, { width: labelW });
      doc.fontSize(fontSize).font(fontFor(value, opts?.bold)).fillColor(DARK);
      doc.text(value, tableX + labelW, y + 4, { width: valW - 8, align: "right" });
      doc.y = y + rowH;
    };

    drawRow("Rental Fee", `$${fmt(data.rentalFee)}`, { bg: BG_LIGHT });
    if (data.customerDiscountPercent && Number(data.customerDiscountPercent) > 0) {
      drawRow("Customer Discount", `${Number(data.customerDiscountPercent)}% (applied)`);
    }
    if (data.priceMatchEnabled) {
      const pm = data.priceMatchCompetitor
        ? `Matched: ${data.priceMatchCompetitor}${data.priceMatchAmount ? ` ($${fmt(data.priceMatchAmount)})` : ""}`
        : "Price matched";
      drawRow("Price Match", pm);
    }
    drawRow("Freight & Delivery", `$${fmt(data.freightCost)}`);
    drawRow("Insurance (LDW)", `$${fmt(data.insuranceCost)}`, { bg: BG_LIGHT });

    // Subtotal is pre-tax (rental + freight + insurance); tax is shown after it.
    const subtotal = Number(data.rentalFee || 0) + Number(data.freightCost || 0) + Number(data.insuranceCost || 0);
    drawRow("Subtotal", `$${subtotal.toFixed(2)}`, { bold: true, border: true });
    drawRow("Tax", `$${fmt(data.taxAmount)}`);

    if (data.depositAmount && Number(data.depositAmount) > 0) {
      drawRow("Deposit (refundable)", `$${fmt(data.depositAmount)}`, { bg: BG_LIGHT });
    }
    drawRow("Total Amount Due", `$${fmt(data.totalCost)}`, { bold: true, border: true, bg: "#fef2f2" });
    doc.moveDown(1);

    // ─── TERMS AND CONDITIONS ────────────────────────────────────
    // Section divider
    doc.moveTo(M, doc.y).lineTo(pageW - M, doc.y).lineWidth(1).strokeColor(BRAND_ACCENT).stroke();
    doc.moveDown(0.5);

    if (template.isMarkdown) {
      const resolvedContent = substituteVariables(template.content, variables);
      const lines = resolvedContent.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { doc.moveDown(0.15); continue; }

        // [[LESSOR_SIGNATURE]] — built-in company (Lessor) signature.
        // Uploaded signature image → typeset name → blank line.
        if (trimmed === "[[LESSOR_SIGNATURE]]") {
          const sy = doc.y;
          const repBuf = decodeSignatureToBuffer(company.repSignatureImage || null);
          let drew = false;
          if (repBuf) {
            try {
              doc.image(repBuf, M, sy, { fit: [200, 55] });
              doc.y = sy + 48;
              drew = true;
            } catch (err) {
              logger.warn("[contractPDF] failed to embed rep signature image, falling back", { err: err instanceof Error ? err.message : String(err) });
            }
          }
          if (!drew && company.repName) {
            if (hasScriptFont) {
              doc.fontSize(26).font("Signature").fillColor(DARK).text(company.repName, M, sy);
            } else {
              doc.fontSize(18).font("Times-Italic").fillColor(DARK).text(company.repName, M, sy);
            }
            drew = true;
          }
          if (!drew) {
            doc.fontSize(8).font("Helvetica").fillColor(DARK)
              .text("Signature: ______________________________", M, sy);
          } else if (company.repName) {
            const credit = company.repTitle ? `${company.repName}, ${company.repTitle}` : company.repName;
            doc.fontSize(8).font("Helvetica").fillColor(GRAY).text(`Per: ${credit}`, M, doc.y + 1);
          }
          doc.moveDown(0.3);
          continue;
        }

        // [[LESSEE_SIGNATURE]] — embed the customer's captured e-signature image
        // when present, otherwise a blank fill-in line.
        if (trimmed === "[[LESSEE_SIGNATURE]]") {
          const sy = doc.y;
          const custBuf = decodeSignatureToBuffer(data.customerSignature ?? null);
          doc.fontSize(8).font("Helvetica").fillColor(DARK).text("Signature:", M, sy);
          if (custBuf) {
            try {
              doc.image(custBuf, M + 60, sy - 8, { fit: [170, 44] });
              doc.y = sy + 30;
            } catch {
              doc.fontSize(8).text("______________________________", M + 60, sy);
            }
          } else {
            doc.fontSize(8).text("______________________________", M + 60, sy);
          }
          doc.moveDown(0.3);
          continue;
        }

        if (/^---+$/.test(trimmed)) {
          doc.moveDown(0.15);
          doc.moveTo(M, doc.y).lineTo(pageW - M, doc.y).lineWidth(0.5).strokeColor(BORDER).stroke();
          doc.moveDown(0.15);
          continue;
        }

        // # Main title
        if (/^# /.test(trimmed)) {
          const text = trimmed.replace(/^# /, "");
          doc.fontSize(11).font(fontFor(text, true)).fillColor(DARK)
            .text(text, M, doc.y, { width: contentW, align: "center" });
          doc.moveDown(0.1);
          continue;
        }
        // ## Section heading
        if (/^## /.test(trimmed)) {
          doc.moveDown(0.25);
          const text = trimmed.replace(/^## /, "");
          doc.fontSize(9.5).font(fontFor(text, true)).fillColor(BRAND_ACCENT)
            .text(text, M, doc.y, { width: contentW });
          doc.moveTo(M, doc.y + 1).lineTo(M + contentW * 0.35, doc.y + 1).lineWidth(0.5).strokeColor(BRAND_ACCENT).stroke();
          doc.moveDown(0.15);
          continue;
        }
        // ### Subsection heading
        if (/^### /.test(trimmed)) {
          const text = trimmed.replace(/^### /, "");
          doc.fontSize(8.5).font(fontFor(text, true)).fillColor(DARK)
            .text(text, M, doc.y, { width: contentW });
          doc.moveDown(0.05);
          continue;
        }

        const cleaned = trimmed.replace(/\*\*/g, "");
        doc.fontSize(8).font(fontFor(cleaned)).fillColor(DARK)
          .text(cleaned, M, doc.y, { width: contentW });
        doc.moveDown(0.05);
      }
    } else {
      // Legacy numbered terms
      doc.fontSize(11).font("Helvetica-Bold").fillColor(DARK)
        .text("Terms and Conditions", M, doc.y, { width: contentW }).moveDown(0.5);
      const terms = template.content.split(/\n\n+/).map((p) => p.replace(/^\d+\.\s+/, "").trim()).filter(Boolean);
      terms.forEach((term, i) => {
        const resolved = substituteVariables(term, variables);
        doc.fontSize(9).font(fontFor(resolved)).fillColor(DARK)
          .text(`${i + 1}. ${resolved}`, M, doc.y, { width: contentW, align: "justify" })
          .moveDown(0.3);
      });
    }

    // Signatures — only add if template doesn't include them
    if (!(template.isMarkdown && /signature/i.test(template.content))) {
      doc.moveDown(2);
      const custBuf = decodeSignatureToBuffer(data.customerSignature ?? null);
      const repBuf = decodeSignatureToBuffer(data.repSignature ?? null);
      // Signed-at are real timestamps with no Toronto-midnight anchoring, so
      // they must carry an explicit timeZone (see dateOpts above).
      const signedDateOpts: Intl.DateTimeFormatOptions = { timeZone: APP_TIMEZONE };
      const custDateStr = data.customerSignedAt ? new Date(data.customerSignedAt).toLocaleDateString(undefined, signedDateOpts) : "_____________";
      const repDateStr = data.repSignedAt ? new Date(data.repSignedAt).toLocaleDateString(undefined, signedDateOpts) : "_____________";

      // Customer signature row
      const custY = doc.y;
      doc.fontSize(10).font("Helvetica").fillColor(DARK)
        .text("Customer Signature:", M, custY);
      if (custBuf) {
        try {
          doc.image(custBuf, M + 130, custY - 10, { fit: [180, 50] });
        } catch (err) {
          logger.warn("[contractPDF] failed to embed customer signature, falling back", { err: err instanceof Error ? err.message : String(err) });
          doc.text("_________________________", M + 130, custY);
        }
      } else {
        doc.text("_________________________", M + 130, custY);
      }
      doc.fontSize(10).font("Helvetica").fillColor(DARK).text(`Date: ${custDateStr}`, M + 340, custY);

      doc.moveDown(custBuf ? 3 : 2);

      // Company representative signature row
      const repY = doc.y;
      doc.fontSize(10).font("Helvetica").fillColor(DARK)
        .text(`${company.companyName} Representative:`, M, repY);
      if (repBuf) {
        try {
          doc.image(repBuf, M + 180, repY - 10, { fit: [160, 50] });
        } catch (err) {
          logger.warn("[contractPDF] failed to embed rep signature, falling back", { err: err instanceof Error ? err.message : String(err) });
          doc.text("_________________________", M + 180, repY);
        }
      } else {
        doc.text("_________________________", M + 180, repY);
      }
      doc.fontSize(10).font("Helvetica").fillColor(DARK).text(`Date: ${repDateStr}`, M + 360, repY);
    }

    // Append a Signature Evidence page when evidence data is supplied
    if (data.signatureEvidence) {
      const ev = data.signatureEvidence;
      doc.addPage();
      doc.fontSize(14).font("Helvetica-Bold").fillColor(DARK)
        .text("Signature Evidence", M, 60, { width: contentW });
      doc.moveDown(0.5);
      doc.fontSize(9).font("Helvetica").fillColor(GRAY)
        .text("The following metadata was captured at the time of electronic signature and forms part of the audit trail.", M, doc.y, { width: contentW });
      doc.moveDown(1);

      const rows: [string, string][] = [
        ["Signed at", ev.signedAt.toISOString()],
        ["IP address", ev.ip ?? "(not captured)"],
        ["User agent", ev.userAgent ?? "(not captured)"],
        ["Contract SHA-256", ev.contractHash ?? "(not captured)"],
      ];

      for (const [label, value] of rows) {
        const y = doc.y;
        doc.fontSize(8.5).font("Helvetica-Bold").fillColor(DARK).text(label, M, y, { width: 120, continued: false });
        doc.fontSize(8.5).font("Helvetica").fillColor(GRAY).text(value, M + 130, y, { width: contentW - 130 });
        doc.moveDown(0.6);
      }
    }

    doc.end();

    const pdfBuffer = await pdfPromise;
    const fileName = `rental-contract-${data.rentalId}-${Date.now()}.pdf`;
    const url = await uploadContractToStorage(pdfBuffer, fileName);

    logger.info("[ContractPDF] Generated contract", { rentalId: data.rentalId, url });
    return { url, version: 1 };
  } catch (error) {
    logger.error("[ContractPDF] Failed to generate contract", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to generate contract PDF", { cause: error });
  }
}

interface RenewalAddendumData {
  rentalId: number;
  rentalNumber?: string | null;
  customerName: string;
  equipmentDescription: string;
  oldEndDate: Date;
  newEndDate: Date;
  extensionDays: number;
  supplementAmount: string;
  newTotalAmount: string;
  newVersion: number;
}

/**
 * Generate a standalone renewal addendum PDF. The caller is responsible for
 * setting rental_requests.contractUrl to the returned URL and bumping
 * contractVersion. The original contract URL is preserved in the audit log
 * before being overwritten.
 */
export async function generateRenewalAddendumPDF(data: RenewalAddendumData): Promise<{ url: string }> {
  try {
    const { default: PDFDocument } = await import("pdfkit");
    const company = await getCompanyInfo();

    const M = 50;
    const pageW = 612;
    const contentW = pageW - M * 2;
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 40, bottom: 40, left: M, right: M } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    const pdfPromise = new Promise<Buffer>((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    });

    registerCJKFont(doc);
    const hasCJK = (s: string) => /[一-鿿㐀-䶿]/.test(s);
    const cjkOk = (() => { try { doc.font("NotoSansSC"); doc.font("Helvetica"); return true; } catch { return false; } })();
    const fontFor = (text: string, bold = false) => {
      if (cjkOk && hasCJK(text)) return "NotoSansSC";
      return bold ? "Helvetica-Bold" : "Helvetica";
    };

    // See generateContractPDF: calendar-date columns render bare (adding a
    // timeZone would shift legacy 00:00:00 UTC rows back a day); only the real
    // "now" instant needs the explicit Toronto anchor.
    const dateOpts: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" };
    const instantDateOpts: Intl.DateTimeFormatOptions = { timeZone: APP_TIMEZONE, year: "numeric", month: "long", day: "numeric" };
    const oldEndStr = data.oldEndDate.toLocaleDateString("en-US", dateOpts);
    const newEndStr = data.newEndDate.toLocaleDateString("en-US", dateOpts);
    const todayStr = new Date().toLocaleDateString("en-US", instantDateOpts);

    // Header
    const logoPath = getLogoPath();
    if (logoPath) {
      try {
        const logoH = 45;
        doc.image(logoPath, M, 40, { height: logoH });
        const infoX = pageW - M - 200;
        doc.fontSize(8).font("Helvetica").fillColor(GRAY);
        doc.text(company.address, infoX, 45, { width: 200, align: "right" });
        doc.text(`Tel: ${company.rentalPhone}`, infoX, doc.y, { width: 200, align: "right" });
        doc.text(company.rentalEmail, infoX, doc.y, { width: 200, align: "right" });
        doc.y = 40 + logoH + 20;
      } catch {
        doc.y = 80;
      }
    } else {
      doc.y = 60;
    }

    // Title
    doc.fontSize(18).font("Helvetica-Bold").fillColor(BRAND_ACCENT)
      .text("Rental Renewal Addendum", M, doc.y, { width: contentW, align: "center" });
    doc.moveDown(0.2);
    doc.fontSize(12).font(fontFor("续租附录", true)).fillColor(DARK)
      .text("续租附录", M, doc.y, { width: contentW, align: "center" });
    doc.moveDown(1);

    // Reference
    doc.fontSize(10).font("Helvetica").fillColor(DARK);
    doc.text(`Agreement: ${data.rentalNumber || `#${data.rentalId}`}`, M, doc.y);
    doc.text(`Customer: `, M, doc.y, { continued: true })
      .font(fontFor(data.customerName)).text(data.customerName)
      .font("Helvetica");
    doc.text(`Equipment: `, M, doc.y, { continued: true })
      .font(fontFor(data.equipmentDescription)).text(data.equipmentDescription)
      .font("Helvetica");
    doc.text(`Effective date: ${todayStr}`, M, doc.y);
    doc.text(`Addendum version: v${data.newVersion}`, M, doc.y);
    doc.moveDown(1);

    // Body
    doc.fontSize(11).font("Helvetica-Bold").fillColor(DARK)
      .text("1. Term Extension / 期限延长", M, doc.y, { width: contentW });
    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica").fillColor(DARK)
      .text(
        `The original rental end date of ${oldEndStr} is hereby extended by ${data.extensionDays} day${data.extensionDays !== 1 ? "s" : ""} to ${newEndStr}. All other terms of the original rental agreement remain in full force and effect.`,
        M, doc.y, { width: contentW, align: "justify" },
      );
    doc.moveDown(0.4);
    doc.font(fontFor("原租期")).text(
      `原租期结束日期 ${oldEndStr} 延长 ${data.extensionDays} 天至 ${newEndStr}。原租赁合同其余条款继续有效。`,
      M, doc.y, { width: contentW, align: "justify" },
    );
    doc.moveDown(1);

    // Supplement charge
    doc.fontSize(11).font("Helvetica-Bold").fillColor(DARK)
      .text("2. Supplemental Charges / 续租补费", M, doc.y, { width: contentW });
    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica").fillColor(DARK);
    const rowY1 = doc.y;
    doc.text("Renewal supplement (incl. tax):", M, rowY1, { width: contentW - 120, continued: false });
    doc.text(`$${fmt(data.supplementAmount)} CAD`, M + contentW - 120, rowY1, { width: 120, align: "right" });
    doc.moveDown(0.3);
    const rowY2 = doc.y;
    doc.text("New rental total (incl. tax):", M, rowY2, { width: contentW - 120, continued: false });
    doc.text(`$${fmt(data.newTotalAmount)} CAD`, M + contentW - 120, rowY2, { width: 120, align: "right" });
    doc.moveDown(0.4);
    doc.font(fontFor("补费金额")).fontSize(9).fillColor(GRAY).text(
      "Supplemental charges have been billed on a separate invoice and remain due per its terms. 补费金额已通过单独发票出具，付款条款以该发票为准。",
      M, doc.y, { width: contentW },
    );
    doc.moveDown(1.5);

    // Signature block
    doc.fontSize(11).font("Helvetica-Bold").fillColor(DARK)
      .text("3. Acknowledgement / 客户确认", M, doc.y, { width: contentW });
    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica").fillColor(DARK)
      .text(
        "By signing below, the renter agrees to the extended term and supplemental charges set out above.",
        M, doc.y, { width: contentW },
      );
    doc.moveDown(0.3);
    doc.font(fontFor("签字"))
      .text("客户签署本附录即表示同意以上延长租期及补费金额。", M, doc.y, { width: contentW });
    doc.moveDown(2);

    const sigY = doc.y;
    doc.fontSize(10).font("Helvetica").fillColor(DARK);
    doc.text("Renter signature:", M, sigY);
    doc.text("_________________________", M + 110, sigY);
    doc.text("Date: ____________________", M + 320, sigY);

    doc.end();
    const pdfBuffer = await pdfPromise;
    const fileName = `rental-addendum-${data.rentalId}-v${data.newVersion}-${Date.now()}.pdf`;
    const url = await uploadContractToStorage(pdfBuffer, fileName);

    logger.info("[ContractPDF] Generated renewal addendum", {
      rentalId: data.rentalId,
      version: data.newVersion,
      url,
    });
    return { url };
  } catch (error) {
    logger.error("[ContractPDF] Failed to generate renewal addendum", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to generate renewal addendum PDF", { cause: error });
  }
}
