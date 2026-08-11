/**
 * Quotation PDF Generation
 * Generates professional quotation PDFs with company branding.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { getCompanyInfo, getRentalSettingsInfo, getPDFSettingsInfo } from "./siteSettingsHelper";
import { registerCJKFont } from "./pdfFontHelper";
import { uploadPDFToBucket } from "./storage";

const fmt = (v: string | number | null | undefined) => Number(v || 0).toFixed(2);

export async function generateQuotationPDF(quotationId: number): Promise<{ url: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Fetch quotation
    const [quotationRow] = await db
      .select()
      .from(schema.quotations)
      .leftJoin(schema.customers, and(eq(schema.quotations.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
      .leftJoin(schema.rentalRequests, and(eq(schema.quotations.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
      .where(and(eq(schema.quotations.id, quotationId), isNull(schema.quotations.deletedAt)))
      .limit(1);

    if (!quotationRow) throw new Error(`Quotation #${quotationId} not found`);

    const quotation = quotationRow.quotations;
    const customer = quotationRow.customers;
    const rental = quotationRow.rental_requests;

    // Fetch line items
    const lineItems = await db
      .select()
      .from(schema.quotationLineItems)
      .where(eq(schema.quotationLineItems.quotationId, quotationId))
      .orderBy(schema.quotationLineItems.sortOrder);

    const company = await getCompanyInfo();
    const _settings = await getRentalSettingsInfo();
    const pdfSettings = await getPDFSettingsInfo();

    const { default: PDFDocument } = await import("pdfkit");

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));

    registerCJKFont(doc);

    const pdfPromise = new Promise<Buffer>((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    });

    const primaryColor = pdfSettings.accentColor || "#1a1a2e";
    const lightGray = "#f5f5f5";
    const borderColor = "#dddddd";

    // ── Header ──
    doc.fontSize(22).font("Helvetica-Bold").fillColor(primaryColor).text("QUOTATION", 50, 50);

    // Company info (right-aligned)
    const rightX = 350;
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text(company.companyName, rightX, 50, { align: "right", width: 195 });
    doc.fontSize(8).font("Helvetica").fillColor("#555555");
    if (company.address) doc.text(company.address, rightX, doc.y, { align: "right", width: 195 });
    if (company.phone) doc.text(`Phone: ${company.phone}`, rightX, doc.y, { align: "right", width: 195 });
    if (company.email) doc.text(`Email: ${company.email}`, rightX, doc.y, { align: "right", width: 195 });
    if (company.gstHstNumber) doc.text(`GST/HST: ${company.gstHstNumber}`, rightX, doc.y, { align: "right", width: 195 });

    doc.moveDown(2);

    // ── Horizontal line ──
    const lineY = doc.y;
    doc.moveTo(50, lineY).lineTo(545, lineY).strokeColor(borderColor).lineWidth(1).stroke();
    doc.moveDown(1);

    // ── Quotation details + Customer side by side ──
    const detailsY = doc.y;

    // Quotation details (left)
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Quotation Details", 50, detailsY);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    doc.text(`Quote #: ${quotation.quotationNumber}`, 50, doc.y + 4);
    if (rental?.rentalNumber) {
      doc.text(`Rental #: ${rental.rentalNumber}`);
    }
    doc.text(`Issue Date: ${quotation.issueDate ? new Date(quotation.issueDate).toLocaleDateString("en-CA") : "N/A"}`);
    doc.text(`Valid Until: ${quotation.validUntil ? new Date(quotation.validUntil).toLocaleDateString("en-CA") : "N/A"}`);
    doc.text(`Status: ${quotation.status.toUpperCase()}`);

    if (rental) {
      doc.text(`Rental Period: ${new Date(rental.startDate).toLocaleDateString("en-CA")} — ${new Date(rental.endDate).toLocaleDateString("en-CA")}`);
    }

    const afterDetailsY = doc.y;

    // Customer info (right)
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Customer", rightX, detailsY);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    if (customer) {
      doc.text(customer.name, rightX, doc.y + 4);
      if (customer.company) doc.text(customer.company, rightX);
      if (customer.address) doc.text(customer.address, rightX);
      if (customer.email) doc.text(customer.email, rightX);
      if (customer.phone) doc.text(customer.phone, rightX);
    } else {
      doc.text("N/A", rightX, doc.y + 4);
    }

    doc.y = Math.max(afterDetailsY, doc.y) + 20;

    // ── Line Items Table ──
    const tableTop = doc.y;
    const colX = { desc: 50, qty: 320, unit: 390, amount: 470 };
    const colW = { desc: 265, qty: 65, unit: 75, amount: 75 };

    // Table header
    doc.rect(50, tableTop, 495, 20).fill(primaryColor);
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#ffffff");
    doc.text("Description", colX.desc + 5, tableTop + 5, { width: colW.desc });
    doc.text("Qty", colX.qty, tableTop + 5, { width: colW.qty, align: "center" });
    doc.text("Unit Price", colX.unit, tableTop + 5, { width: colW.unit, align: "right" });
    doc.text("Amount", colX.amount, tableTop + 5, { width: colW.amount, align: "right" });

    let rowY = tableTop + 22;
    doc.fillColor("#333333").font("Helvetica").fontSize(8);

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];

      if (i % 2 === 0) {
        doc.rect(50, rowY - 2, 495, 16).fill(lightGray);
        doc.fillColor("#333333");
      }

      doc.text(item.description, colX.desc + 5, rowY, { width: colW.desc });
      doc.text(String(parseFloat(item.quantity)), colX.qty, rowY, { width: colW.qty, align: "center" });
      doc.text(`$${fmt(item.unitPrice)}`, colX.unit, rowY, { width: colW.unit, align: "right" });
      doc.text(`$${fmt(item.amount)}`, colX.amount, rowY, { width: colW.amount, align: "right" });

      rowY += 18;
    }

    // Table bottom line
    doc.moveTo(50, rowY).lineTo(545, rowY).strokeColor(borderColor).stroke();
    rowY += 10;

    // ── Totals ──
    const totalsX = 380;
    const totalsValX = 470;
    const totalsW = 75;

    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    doc.text("Subtotal:", totalsX, rowY, { width: 85 });
    doc.text(`$${fmt(quotation.subtotal)}`, totalsValX, rowY, { width: totalsW, align: "right" });
    rowY += 14;

    // Tax breakdown
    if (quotation.taxBreakdown) {
      const parts = quotation.taxBreakdown.split("|").map((s: string) => s.trim()).filter(Boolean);
      for (const part of parts) {
        doc.text(part.split(":")[0]?.trim() || "Tax:", totalsX, rowY, { width: 85 });
        doc.text(part.split(":")[1]?.trim() || "", totalsValX, rowY, { width: totalsW, align: "right" });
        rowY += 14;
      }
    } else if (parseFloat(quotation.taxAmount) > 0) {
      doc.text("Tax:", totalsX, rowY, { width: 85 });
      doc.text(`$${fmt(quotation.taxAmount)}`, totalsValX, rowY, { width: totalsW, align: "right" });
      rowY += 14;
    }

    // Total
    rowY += 4;
    doc.moveTo(totalsX, rowY).lineTo(545, rowY).strokeColor(borderColor).stroke();
    rowY += 6;
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor);
    doc.text("Total:", totalsX, rowY, { width: 85 });
    doc.text(`$${fmt(quotation.totalAmount)}`, totalsValX, rowY, { width: totalsW, align: "right" });
    rowY += 22;

    // ── Notes ──
    doc.y = rowY;
    if (quotation.notes) {
      doc.fontSize(9).font("Helvetica-Bold").fillColor(primaryColor).text("Notes:", 50);
      doc.fontSize(8).font("Helvetica").fillColor("#555555").text(quotation.notes, 50, doc.y + 2, { width: 495 });
      doc.moveDown(1);
    }

    // ── Footer ──
    const quoteFooter = pdfSettings.quoteFooter;
    if (quoteFooter) {
      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(borderColor).stroke();
      doc.moveDown(0.5);
      doc.fontSize(8).font("Helvetica").fillColor("#888888").text(quoteFooter, 50, doc.y, { width: 495, align: "center" });
    }

    doc.moveDown(1);
    doc.fontSize(8).font("Helvetica").fillColor("#888888")
      .text("This quotation is valid for 30 days from the issue date.", 50, doc.y, { width: 495, align: "center" });

    doc.end();

    const pdfBuffer = await pdfPromise;
    const fileName = `quotations/quotation-${quotation.quotationNumber}-${Date.now()}.pdf`;

    const url = await uploadPDFToBucket(pdfBuffer, fileName, "quotations");

    await db.update(schema.quotations).set({
      pdfUrl: url,
      updatedAt: new Date(),
    }).where(eq(schema.quotations.id, quotationId));

    logger.info("[QuotationPDF] Generated quotation PDF", { quotationId, quotationNumber: quotation.quotationNumber, url });
    return { url };
  } catch (error) {
    logger.error("[QuotationPDF] Failed to generate quotation PDF", {
      quotationId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to generate quotation PDF", { cause: error });
  }
}
