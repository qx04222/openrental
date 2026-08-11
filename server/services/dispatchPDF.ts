/**
 * Dispatch Order PDF Generation
 * Generates professional dispatch order PDFs with company branding.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { getCompanyInfo, getPDFSettingsInfo } from "./siteSettingsHelper";
import { registerCJKFont } from "./pdfFontHelper";
import { uploadPDFToBucket } from "./storage";

export async function generateDispatchPDF(dispatchId: number): Promise<{ url: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Fetch dispatch order with joins
    const [row] = await db
      .select()
      .from(schema.dispatchOrders)
      .leftJoin(schema.rentalFleet, and(eq(schema.dispatchOrders.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
      .leftJoin(schema.customers, and(eq(schema.dispatchOrders.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
      .leftJoin(schema.drivers, and(eq(schema.dispatchOrders.assignedDriverId, schema.drivers.id), isNull(schema.drivers.deletedAt)))
      .where(and(eq(schema.dispatchOrders.id, dispatchId), isNull(schema.dispatchOrders.deletedAt)))
      .limit(1);

    if (!row) throw new Error(`Dispatch order #${dispatchId} not found`);

    const dispatch = row.dispatch_orders;
    const fleet = row.rental_fleet;
    const customer = row.customers;
    const driver = row.drivers;

    const company = await getCompanyInfo();
    const pdfSettings = await getPDFSettingsInfo();

    const { default: PDFDocument } = await import("pdfkit");

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));

    const pdfPromise = new Promise<Buffer>((resolve) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
    });

    registerCJKFont(doc);

    const primaryColor = "#1a1a2e";
    const accentColor = pdfSettings.accentColor;
    const lightGray = "#f5f5f5";
    const borderColor = "#dddddd";

    // ── Header ──
    doc.fontSize(22).font("Helvetica-Bold").fillColor(accentColor).text("DISPATCH ORDER", 50, 50);

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
    doc.text(`Dispatch #: ${dispatch.id}`, 50, doc.y + 4);
    doc.text(`Type: ${dispatch.orderType === "delivery" ? "Delivery" : "Pickup"}`);
    doc.text(`Status: ${dispatch.status.toUpperCase()}`);
    doc.text(`Priority: ${(dispatch.priority || "normal").toUpperCase()}`);
    if (dispatch.scheduledDate) {
      doc.text(`Scheduled: ${new Date(dispatch.scheduledDate).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}`);
    }

    const afterLeftY = doc.y;

    // Customer info (right)
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Customer", rightX, detailsY);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    if (customer) {
      doc.text(customer.name, rightX, doc.y + 4);
      if (customer.company) doc.text(customer.company, rightX);
      if (customer.phone) doc.text(`Phone: ${customer.phone}`, rightX);
      if (customer.email) doc.text(customer.email, rightX);
    } else {
      doc.text("N/A", rightX, doc.y + 4);
    }

    doc.y = Math.max(afterLeftY, doc.y) + 20;

    // ── Equipment Information ──
    if (fleet) {
      doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Equipment Information", 50);
      doc.moveDown(0.5);

      const eqTop = doc.y;
      const eqFields: Array<[string, string]> = [
        ["Brand", fleet.brand],
        ["Model", fleet.model],
      ];
      if (fleet.category) eqFields.push(["Category", fleet.category]);
      if (fleet.assetNumber) eqFields.push(["Asset #", fleet.assetNumber]);

      // Draw background
      let tempY = eqTop + 5;
      for (const _ of eqFields) tempY += 14;
      doc.rect(50, eqTop, 495, tempY - eqTop + 5).fill(lightGray);

      // Draw text
      let eqY = eqTop + 5;
      doc.fontSize(9).fillColor("#333333");
      for (const [label, value] of eqFields) {
        doc.font("Helvetica-Bold").text(`${label}: `, 55, eqY, { continued: true });
        doc.font("Helvetica").text(value);
        eqY = doc.y + 2;
      }

      doc.y = eqY + 10;
    }

    // ── Addresses ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Addresses", 50);
    doc.moveDown(0.5);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");

    if (dispatch.pickupAddress) {
      doc.font("Helvetica-Bold").text("Pickup: ", 50, doc.y, { continued: true });
      doc.font("Helvetica").text(dispatch.pickupAddress);
    }
    if (dispatch.deliveryAddress) {
      doc.font("Helvetica-Bold").text("Delivery: ", 50, doc.y + 2, { continued: true });
      doc.font("Helvetica").text(dispatch.deliveryAddress);
    }
    if (dispatch.distance) {
      doc.text(`Distance: ${dispatch.distance} km`, 50, doc.y + 2);
    }

    doc.moveDown(1);

    // ── Driver Information ──
    if (driver) {
      doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Driver", 50);
      doc.moveDown(0.5);
      doc.fontSize(9).font("Helvetica").fillColor("#333333");
      doc.text(`Name: ${driver.name}`);
      doc.moveDown(1);
    }

    // ── Notes ──
    if (dispatch.notes) {
      doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Notes", 50);
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica").fillColor("#555555").text(dispatch.notes, 50, doc.y, { width: 495 });
      doc.moveDown(1);
    }

    // ── Shipping Cost ──
    if (dispatch.shippingCost && parseFloat(dispatch.shippingCost) > 0) {
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(borderColor).stroke();
      doc.moveDown(0.5);
      doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor);
      doc.text("Shipping Cost:", 380, doc.y, { width: 85, continued: true });
      doc.text(` $${Number(dispatch.shippingCost).toFixed(2)}`);
      doc.moveDown(1);
    }

    // ── Footer ──
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(borderColor).stroke();
    doc.moveDown(0.5);
    const footerText = pdfSettings.dispatchFooter || `Thank you for choosing ${company.companyName}.`;
    doc.fontSize(8).font("Helvetica").fillColor("#888888").text(footerText, 50, doc.y, { width: 495, align: "center" });

    doc.end();

    const pdfBuffer = await pdfPromise;
    const fileName = `dispatch-orders/dispatch-${dispatchId}-${Date.now()}.pdf`;

    const url = await uploadPDFToBucket(pdfBuffer, fileName, "dispatch-orders");

    await db.update(schema.dispatchOrders).set({
      pdfUrl: url,
      updatedAt: new Date(),
    }).where(eq(schema.dispatchOrders.id, dispatchId));

    logger.info("[DispatchPDF] Generated dispatch PDF", { dispatchId, url });
    return { url };
  } catch (error) {
    logger.error("[DispatchPDF] Failed to generate dispatch PDF", {
      dispatchId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to generate dispatch PDF", { cause: error });
  }
}
