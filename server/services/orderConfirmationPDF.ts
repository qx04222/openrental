/**
 * Order Confirmation PDF Generation
 * Generates order confirmation PDFs for approved rentals with company branding from site_settings.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { getCompanyInfo, getPDFSettingsInfo } from "./siteSettingsHelper";
import { registerCJKFont } from "./pdfFontHelper";
import { uploadPDFToBucket } from "./storage";

const fmt = (v: string | number | null | undefined) => Number(v || 0).toFixed(2);

export async function generateOrderConfirmationPDF(rentalId: number): Promise<{ url: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Fetch rental with fleet + customer info
    const [rentalRow] = await db
      .select()
      .from(schema.rentalRequests)
      .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
      .leftJoin(schema.customers, and(eq(schema.rentalRequests.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
      .where(and(eq(schema.rentalRequests.id, rentalId), isNull(schema.rentalRequests.deletedAt)))
      .limit(1);

    if (!rentalRow) throw new Error(`Rental #${rentalId} not found`);

    const rental = rentalRow.rental_requests;
    const fleet = rentalRow.rental_fleet;
    const customer = rentalRow.customers;

    // Fetch company info from site_settings
    const company = await getCompanyInfo();
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
    const accentColor = "#0e6f3e";
    const lightGray = "#f5f5f5";
    const borderColor = "#dddddd";

    // ── Header ──
    doc.fontSize(22).font("Helvetica-Bold").fillColor(accentColor).text("ORDER CONFIRMATION", 50, 50);

    // Company info (right-aligned)
    const rightX = 350;
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text(company.companyName, rightX, 50, { align: "right", width: 195 });
    doc.fontSize(8).font("Helvetica").fillColor("#555555");
    if (company.address) doc.text(company.address, rightX, doc.y, { align: "right", width: 195 });
    if (company.phone) doc.text(`Phone: ${company.phone}`, rightX, doc.y, { align: "right", width: 195 });
    if (company.email) doc.text(`Email: ${company.email}`, rightX, doc.y, { align: "right", width: 195 });

    doc.moveDown(2);

    // ── Horizontal line ──
    const lineY = doc.y;
    doc.moveTo(50, lineY).lineTo(545, lineY).strokeColor(accentColor).lineWidth(2).stroke();
    doc.moveDown(1);

    // ── Order details + Customer info side by side ──
    const detailsY = doc.y;

    // Order details (left)
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Order Details", 50, detailsY);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    doc.text(`Rental ID: ${rental.rentalNumber || `#${rental.id}`}`, 50, doc.y + 4);
    doc.text(`Approval Date: ${new Date().toLocaleDateString("en-CA")}`);
    doc.text(`Status: ${rental.status.toUpperCase()}`);

    const afterLeftY = doc.y;

    // Customer info (right)
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Customer", rightX, detailsY);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    doc.text(rental.customerName, rightX, doc.y + 4);
    if (rental.customerCompany || customer?.company) doc.text(rental.customerCompany || customer?.company || "", rightX);
    if (customer?.address) doc.text(customer.address, rightX);
    if (rental.customerEmail) doc.text(rental.customerEmail, rightX);
    if (rental.customerPhone) doc.text(rental.customerPhone, rightX);

    doc.y = Math.max(afterLeftY, doc.y) + 20;

    // ── Equipment Information ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Equipment Information", 50);
    doc.moveDown(0.5);

    const eqTop = doc.y;
    doc.rect(50, eqTop, 495, 0).fill(lightGray); // will adjust height after

    const eqFields: Array<[string, string]> = [];
    if (fleet) {
      eqFields.push(["Brand", fleet.brand]);
      eqFields.push(["Model", fleet.model]);
      if (fleet.category) eqFields.push(["Category", fleet.category]);
      if (fleet.assetNumber) eqFields.push(["Asset #", fleet.assetNumber]);
    } else if (rental.equipmentDescription) {
      eqFields.push(["Description", rental.equipmentDescription]);
    }

    let eqY = eqTop + 5;
    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    for (const [label, value] of eqFields) {
      doc.font("Helvetica-Bold").text(`${label}: `, 55, eqY, { continued: true });
      doc.font("Helvetica").text(value);
      eqY = doc.y + 2;
    }

    // Fill background for equipment box
    const eqHeight = eqY - eqTop + 5;
    doc.save();
    doc.rect(50, eqTop, 495, eqHeight).fill(lightGray);
    doc.restore();

    // Re-draw text on top of background
    eqY = eqTop + 5;
    doc.fontSize(9).fillColor("#333333");
    for (const [label, value] of eqFields) {
      doc.font("Helvetica-Bold").text(`${label}: `, 55, eqY, { continued: true });
      doc.font("Helvetica").text(value);
      eqY = doc.y + 2;
    }

    doc.y = eqY + 10;

    // ── Rental Period ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Rental Period", 50);
    doc.moveDown(0.5);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");

    const startDate = rental.startDate;
    const endDate = rental.endDate;
    const days = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));

    doc.text(`Start Date: ${startDate.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}`);
    doc.text(`End Date: ${endDate.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}`);
    doc.text(`Duration: ${days} day${days !== 1 ? "s" : ""}`);
    doc.moveDown(1);

    // ── Price Breakdown ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Price Breakdown", 50);
    doc.moveDown(0.5);

    const priceTableTop = doc.y;
    const priceColX = { label: 55, value: 470 };

    // Table header
    doc.rect(50, priceTableTop, 495, 18).fill(primaryColor);
    doc.fontSize(8).font("Helvetica-Bold").fillColor("#ffffff");
    doc.text("Item", priceColX.label, priceTableTop + 4, { width: 350 });
    doc.text("Amount", priceColX.value, priceTableTop + 4, { width: 70, align: "right" });

    let priceY = priceTableTop + 20;
    doc.fontSize(9).font("Helvetica").fillColor("#333333");

    const rentalFee = parseFloat(rental.rentalFee || "0");
    const freightCost = parseFloat(rental.freightCost || "0");
    const insuranceCost = parseFloat(rental.insuranceCost || "0");
    const taxAmount = parseFloat(rental.taxAmount || "0");
    const depositAmount = parseFloat(rental.depositAmount || "0");
    const totalAmount = parseFloat(rental.totalAmount || "0");

    // Rental fee with rate info
    const priceRows: Array<[string, number]> = [];
    if (rentalFee > 0) {
      const dailyRate = days > 0 ? rentalFee / days : rentalFee;
      priceRows.push([`Rental Fee (${days} days @ $${fmt(dailyRate)}/day)`, rentalFee]);
    }
    if (freightCost > 0) priceRows.push(["Freight / Delivery", freightCost]);
    if (insuranceCost > 0) {
      const insLabel = rental.insuranceType === "full" ? "Insurance (Full Coverage)" : rental.insuranceType === "basic" ? "Insurance (Basic Coverage)" : "Insurance";
      priceRows.push([insLabel, insuranceCost]);
    }

    for (let i = 0; i < priceRows.length; i++) {
      const [label, val] = priceRows[i];
      if (i % 2 === 0) {
        doc.rect(50, priceY - 2, 495, 16).fill(lightGray);
        doc.fillColor("#333333");
      }
      doc.text(label, priceColX.label, priceY, { width: 380 });
      doc.text(`$${fmt(val)}`, priceColX.value, priceY, { width: 70, align: "right" });
      priceY += 18;
    }

    // Tax
    if (taxAmount > 0) {
      if (rental.taxBreakdown) {
        const parts = rental.taxBreakdown.split("|").map((s: string) => s.trim()).filter(Boolean);
        for (const part of parts) {
          const taxLabel = part.split(":")[0]?.trim() || "Tax";
          const taxVal = part.split(":")[1]?.trim() || `$${fmt(taxAmount)}`;
          doc.text(taxLabel, priceColX.label, priceY, { width: 380 });
          doc.text(taxVal, priceColX.value, priceY, { width: 70, align: "right" });
          priceY += 18;
        }
      } else {
        doc.text("Tax", priceColX.label, priceY, { width: 380 });
        doc.text(`$${fmt(taxAmount)}`, priceColX.value, priceY, { width: 70, align: "right" });
        priceY += 18;
      }
    }

    // Deposit
    if (depositAmount > 0) {
      doc.text("Security Deposit", priceColX.label, priceY, { width: 380 });
      doc.text(`$${fmt(depositAmount)}`, priceColX.value, priceY, { width: 70, align: "right" });
      priceY += 18;
    }

    // Total line
    doc.moveTo(50, priceY).lineTo(545, priceY).strokeColor(borderColor).stroke();
    priceY += 6;
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor);
    doc.text("Total:", priceColX.label, priceY, { width: 380 });
    doc.text(`$${fmt(totalAmount)}`, priceColX.value, priceY, { width: 70, align: "right" });
    priceY += 22;

    doc.y = priceY;

    // ── Delivery Info ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Delivery Information", 50);
    doc.moveDown(0.5);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");

    const method = rental.deliveryMethod || "pickup";
    const methodLabels: Record<string, string> = {
      pickup: "Customer Pickup",
      delivery: "Delivery",
      delivery_and_return: "Delivery & Return",
    };
    doc.text(`Method: ${methodLabels[method] || method}`);
    if (rental.deliveryAddress) doc.text(`Address: ${rental.deliveryAddress}`);
    if (rental.deliveryNotes) doc.text(`Notes: ${rental.deliveryNotes}`);
    doc.moveDown(1);

    // ── Terms Summary ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Terms Summary", 50);
    doc.moveDown(0.3);
    doc.fontSize(8).font("Helvetica").fillColor("#555555");
    doc.text("1. Equipment must be used in compliance with all applicable laws and regulations.", 50, doc.y, { width: 495 });
    doc.text("2. Renter is responsible for damage beyond normal wear and tear.", 50, doc.y + 2, { width: 495 });
    doc.text("3. Late returns may incur additional charges at the applicable daily rate.", 50, doc.y + 2, { width: 495 });
    doc.text("4. A full rental contract with detailed terms will be provided separately.", 50, doc.y + 2, { width: 495 });
    doc.moveDown(2);

    // ── Footer ──
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(borderColor).stroke();
    doc.moveDown(0.5);
    const contactChannel = company.phone || company.email || "our support team";
    doc.fontSize(8).font("Helvetica").fillColor("#888888").text(
      `Thank you for choosing ${company.companyName}. If you have any questions, please contact us at ${contactChannel}.`,
      50, doc.y, { width: 495, align: "center" },
    );

    doc.end();

    const pdfBuffer = await pdfPromise;
    const fileName = `order-confirmations/order-confirmation-${rentalId}-${Date.now()}.pdf`;

    // Upload to permanent storage
    const url = await uploadPDFToBucket(pdfBuffer, fileName, "order-confirmations");

    // Update rental_requests with the PDF URL
    await db.update(schema.rentalRequests).set({
      orderConfirmationPdfUrl: url,
      updatedAt: new Date(),
    }).where(eq(schema.rentalRequests.id, rentalId));

    logger.info("[OrderConfirmationPDF] Generated order confirmation PDF", { rentalId, url });
    return { url };
  } catch (error) {
    logger.error("[OrderConfirmationPDF] Failed to generate order confirmation PDF", {
      rentalId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to generate order confirmation PDF", { cause: error });
  }
}
