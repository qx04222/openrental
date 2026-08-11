/**
 * Invoice PDF Generation
 * Generates professional B2B invoice PDFs with company branding from site_settings.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { uploadPDFToBucket } from "./storage";
import { getCompanyInfo, getRentalSettingsInfo, getPDFSettingsInfo } from "./siteSettingsHelper";
import { registerCJKFont } from "./pdfFontHelper";

const fmt = (v: string | number | null | undefined) => Number(v || 0).toFixed(2);

export async function generateInvoicePDF(invoiceId: number): Promise<{ url: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Fetch invoice
    const [invoiceRow] = await db
      .select()
      .from(schema.invoices)
      .leftJoin(schema.customers, and(eq(schema.invoices.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
      .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
      .limit(1);

    if (!invoiceRow) throw new Error(`Invoice #${invoiceId} not found`);

    const invoice = invoiceRow.invoices;
    const customer = invoiceRow.customers;

    // Fetch line items
    const lineItems = await db
      .select()
      .from(schema.invoiceLineItems)
      .where(eq(schema.invoiceLineItems.invoiceId, invoiceId))
      .orderBy(schema.invoiceLineItems.sortOrder);

    // Fetch company info and rental settings
    const company = await getCompanyInfo();
    const settings = await getRentalSettingsInfo();
    const _pdfSettings = await getPDFSettingsInfo();

    const { default: PDFDocument } = await import("pdfkit");

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));

    registerCJKFont(doc);

    const pdfPromise = new Promise<Buffer>((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    });

    // Colors
    const primaryColor = "#1a1a2e";
    const _accentColor = "#16213e";
    const lightGray = "#f5f5f5";
    const borderColor = "#dddddd";

    // ── PAID watermark ──
    if (invoice.status === "paid") {
      doc.save();
      doc.rotate(45, { origin: [300, 400] });
      doc.fontSize(80).fillColor("#00aa00").opacity(0.15).text("PAID", 120, 300, { align: "center" });
      doc.restore();
      doc.opacity(1);
    }

    // ── Header ──
    doc.fontSize(22).font("Helvetica-Bold").fillColor(primaryColor).text("INVOICE", 50, 50);

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

    // ── Invoice details + Bill To side by side ──
    const detailsY = doc.y;

    // Invoice details (left)
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Invoice Details", 50, detailsY);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    doc.text(`Invoice #: ${invoice.invoiceNumber}`, 50, doc.y + 4);
    doc.text(`Issue Date: ${invoice.issueDate ? new Date(invoice.issueDate).toLocaleDateString("en-CA") : "N/A"}`);
    doc.text(`Due Date: ${invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString("en-CA") : "N/A"}`);
    doc.text(`Payment Terms: ${settings.invoicePaymentTerms}`);
    doc.text(`Status: ${invoice.status.toUpperCase()}`);

    const afterDetailsY = doc.y;

    // Bill To (right)
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Bill To", rightX, detailsY);
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

      // Alternate row background
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
    doc.text(`$${fmt(invoice.subtotal)}`, totalsValX, rowY, { width: totalsW, align: "right" });
    rowY += 14;

    // Tax breakdown
    if (invoice.taxBreakdown) {
      // taxBreakdown can be like "GST 5%: $12.50 | PST 7%: $17.50"
      const parts = invoice.taxBreakdown.split("|").map((s: string) => s.trim()).filter(Boolean);
      for (const part of parts) {
        doc.text(part.split(":")[0]?.trim() || "Tax:", totalsX, rowY, { width: 85 });
        doc.text(part.split(":")[1]?.trim() || "", totalsValX, rowY, { width: totalsW, align: "right" });
        rowY += 14;
      }
    } else if (parseFloat(invoice.taxAmount) > 0) {
      doc.text("Tax:", totalsX, rowY, { width: 85 });
      doc.text(`$${fmt(invoice.taxAmount)}`, totalsValX, rowY, { width: totalsW, align: "right" });
      rowY += 14;
    }

    // Total
    rowY += 4;
    doc.moveTo(totalsX, rowY).lineTo(545, rowY).strokeColor(borderColor).stroke();
    rowY += 6;
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor);
    doc.text("Total:", totalsX, rowY, { width: 85 });
    doc.text(`$${fmt(invoice.totalAmount)}`, totalsValX, rowY, { width: totalsW, align: "right" });
    rowY += 18;

    // Amount Paid
    const amountPaid = parseFloat(invoice.amountPaid);
    if (amountPaid > 0) {
      doc.fontSize(9).font("Helvetica").fillColor("#333333");
      doc.text("Amount Paid:", totalsX, rowY, { width: 85 });
      doc.text(`$${fmt(invoice.amountPaid)}`, totalsValX, rowY, { width: totalsW, align: "right" });
      rowY += 14;
    }

    // Balance Due
    const balanceDue = parseFloat(invoice.balanceDue);
    if (balanceDue > 0) {
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#cc0000");
      doc.text("Balance Due:", totalsX, rowY, { width: 85 });
      doc.text(`$${fmt(invoice.balanceDue)}`, totalsValX, rowY, { width: totalsW, align: "right" });
      rowY += 18;
    }

    // ── Notes ──
    doc.y = rowY + 10;
    if (invoice.notes) {
      doc.fontSize(9).font("Helvetica-Bold").fillColor(primaryColor).text("Notes:", 50);
      doc.fontSize(8).font("Helvetica").fillColor("#555555").text(invoice.notes, 50, doc.y + 2, { width: 495 });
      doc.moveDown(1);
    }

    // ── Footer ──
    if (settings.invoiceFooterNotes) {
      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(borderColor).stroke();
      doc.moveDown(0.5);
      doc.fontSize(8).font("Helvetica").fillColor("#888888").text(settings.invoiceFooterNotes, 50, doc.y, { width: 495, align: "center" });
    }

    // Payment terms footer
    doc.moveDown(1);
    doc.fontSize(8).font("Helvetica").fillColor("#888888").text(`Payment Terms: ${settings.invoicePaymentTerms}`, 50, doc.y, { width: 495, align: "center" });

    doc.end();

    const pdfBuffer = await pdfPromise;
    const fileName = `invoices/invoice-${invoice.invoiceNumber}-${Date.now()}.pdf`;

    // Upload to permanent storage (invoices bucket)
    const url = await uploadPDFToBucket(pdfBuffer, fileName, "invoices");

    // Update the invoice record with the PDF URL
    await db.update(schema.invoices).set({
      pdfUrl: url,
      updatedAt: new Date(),
    }).where(eq(schema.invoices.id, invoiceId));

    logger.info("[InvoicePDF] Generated invoice PDF", { invoiceId, invoiceNumber: invoice.invoiceNumber, url });
    return { url };
  } catch (error) {
    logger.error("[InvoicePDF] Failed to generate invoice PDF", {
      invoiceId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to generate invoice PDF", { cause: error });
  }
}
