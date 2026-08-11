/**
 * Inspection Report PDF Generation
 * Generates professional equipment inspection report PDFs.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { getCompanyInfo, getPDFSettingsInfo } from "./siteSettingsHelper";
import { registerCJKFont } from "./pdfFontHelper";
import { uploadPDFToBucket } from "./storage";

const conditionLabels: Record<string, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

const severityLabels: Record<string, string> = {
  none: "None",
  minor: "Minor",
  moderate: "Moderate",
  severe: "Severe",
};

export async function generateInspectionPDF(inspectionId: number): Promise<{ url: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    // Fetch inspection with fleet info
    const [row] = await db
      .select()
      .from(schema.inspections)
      .leftJoin(schema.rentalFleet, and(eq(schema.inspections.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
      .leftJoin(schema.rentalRequests, and(eq(schema.inspections.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
      .where(and(eq(schema.inspections.id, inspectionId), isNull(schema.inspections.deletedAt)))
      .limit(1);

    if (!row) throw new Error(`Inspection #${inspectionId} not found`);

    const insp = row.inspections;
    const fleet = row.rental_fleet;
    const rental = row.rental_requests;

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
    doc.fontSize(22).font("Helvetica-Bold").fillColor(accentColor).text("EQUIPMENT INSPECTION REPORT", 50, 50);

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

    // ── Inspection details + inspector side by side ──
    const detailsY = doc.y;

    // Inspection details (left)
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Inspection Details", 50, detailsY);
    doc.fontSize(9).font("Helvetica").fillColor("#333333");
    doc.text(`Inspection #: ${insp.id}`, 50, doc.y + 4);
    doc.text(`Type: ${insp.type.charAt(0).toUpperCase() + insp.type.slice(1)}`);
    doc.text(`Date: ${insp.createdAt.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}`);
    if (insp.inspectorName) doc.text(`Inspector: ${insp.inspectorName}`);
    if (insp.rentalId) doc.text(`Rental #: ${rental?.rentalNumber || insp.rentalId}`);

    const afterLeftY = doc.y;

    // Customer info (right, from rental)
    if (rental) {
      doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text("Customer", rightX, detailsY);
      doc.fontSize(9).font("Helvetica").fillColor("#333333");
      doc.text(rental.customerName, rightX, doc.y + 4);
      if (rental.customerCompany) doc.text(rental.customerCompany, rightX);
    }

    doc.y = Math.max(afterLeftY, doc.y) + 20;

    // ── Equipment Information ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Equipment Information", 50);
    doc.moveDown(0.5);

    const eqFields: Array<[string, string]> = [];
    if (fleet) {
      eqFields.push(["Brand", fleet.brand]);
      eqFields.push(["Model", fleet.model]);
      if (fleet.serialNumber) eqFields.push(["Serial Number", fleet.serialNumber]);
      if (fleet.assetNumber) eqFields.push(["Asset #", fleet.assetNumber]);
      if (fleet.category) eqFields.push(["Category", fleet.category]);
    } else if (insp.equipmentSelected) {
      eqFields.push(["Equipment", insp.equipmentSelected]);
    }

    if (eqFields.length > 0) {
      const eqTop = doc.y;
      let tempY = eqTop + 5;
      for (const _ of eqFields) tempY += 14;
      doc.rect(50, eqTop, 495, tempY - eqTop + 5).fill(lightGray);

      let eqY = eqTop + 5;
      doc.fontSize(9).fillColor("#333333");
      for (const [label, value] of eqFields) {
        doc.font("Helvetica-Bold").text(`${label}: `, 55, eqY, { continued: true });
        doc.font("Helvetica").text(value);
        eqY = doc.y + 2;
      }
      doc.y = eqY + 10;
    }

    // ── Meter Readings ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Meter Readings", 50);
    doc.moveDown(0.5);

    const readingsTop = doc.y;
    const readings: Array<[string, string]> = [];
    if (insp.engineHours != null) readings.push(["Engine Hours", String(insp.engineHours)]);
    if (insp.hourMeter != null) readings.push(["Hour Meter", String(insp.hourMeter)]);
    if (insp.fuelLevel != null) readings.push(["Fuel Level", `${insp.fuelLevel}%`]);
    if (insp.odometerReading != null) readings.push(["Odometer", String(insp.odometerReading)]);

    if (readings.length > 0) {
      // 2-column grid
      const colWidth = 240;
      doc.fontSize(9).fillColor("#333333");
      let rdY = readingsTop;
      for (let i = 0; i < readings.length; i++) {
        const [label, value] = readings[i];
        const col = i % 2;
        const x = 55 + col * colWidth;
        if (col === 0 && i > 0) rdY += 16;

        doc.font("Helvetica-Bold").text(`${label}: `, x, rdY, { continued: true });
        doc.font("Helvetica").text(value);
      }
      doc.y = rdY + 20;
    } else {
      doc.fontSize(9).font("Helvetica").fillColor("#888888").text("No meter readings recorded.", 55);
      doc.moveDown(1);
    }

    // ── Overall Condition ──
    doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Condition Assessment", 50);
    doc.moveDown(0.5);

    const condTop = doc.y;
    // Condition badge
    const condLabel = conditionLabels[insp.overallCondition || ""] || "N/A";
    const condColor = insp.overallCondition === "excellent" ? "#059669" :
      insp.overallCondition === "good" ? "#2563eb" :
      insp.overallCondition === "fair" ? "#d97706" :
      insp.overallCondition === "poor" ? "#dc2626" : "#888888";

    doc.fontSize(12).font("Helvetica-Bold").fillColor(condColor).text(`Overall: ${condLabel}`, 55, condTop);
    doc.moveDown(0.3);

    // Damage assessment
    if (insp.damageSeverity && insp.damageSeverity !== "none") {
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#dc2626")
        .text(`Damage Severity: ${severityLabels[insp.damageSeverity] || insp.damageSeverity}`, 55);
    }

    if (insp.damageNotes) {
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica").fillColor("#555555")
        .text(`Damage Notes: ${insp.damageNotes}`, 55, doc.y, { width: 480 });
    }

    doc.moveDown(1);

    // ── Photos ──
    const photoFields: Array<[string, string | null]> = [
      ["Front", insp.photoFront],
      ["Back", insp.photoBack],
      ["Left", insp.photoLeft],
      ["Right", insp.photoRight],
      ["Additional", insp.photoAdditional],
    ];

    const photosWithUrls = photoFields.filter(([_, url]) => url && (url.startsWith("http://") || url.startsWith("https://")));

    if (photosWithUrls.length > 0) {
      doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Photos", 50);
      doc.moveDown(0.3);
      doc.fontSize(8).font("Helvetica").fillColor("#555555");
      for (const [label, url] of photosWithUrls) {
        doc.text(`${label}: `, 55, doc.y, { continued: true });
        doc.fillColor("#2563eb").text(url!, { link: url!, underline: true });
        doc.fillColor("#555555");
      }
      doc.moveDown(1);
    }

    // ── Customer Signature ──
    if (insp.customerSignedAt) {
      doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Customer Signature", 50);
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica").fillColor("#333333");
      doc.text(`Signed: ${new Date(insp.customerSignedAt).toLocaleString("en-CA")}`);
      if (insp.customerSignature && (insp.customerSignature.startsWith("http://") || insp.customerSignature.startsWith("https://"))) {
        doc.fontSize(8).fillColor("#2563eb").text(insp.customerSignature, { link: insp.customerSignature, underline: true });
      }
      doc.moveDown(1);
    }

    // ── Location ──
    if (insp.locationAddress || (insp.latitude && insp.longitude)) {
      doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Location", 50);
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica").fillColor("#333333");
      if (insp.locationAddress) doc.text(`Address: ${insp.locationAddress}`);
      if (insp.latitude && insp.longitude) doc.text(`GPS: ${insp.latitude}, ${insp.longitude}`);
      doc.moveDown(1);
    }

    // ── Notes ──
    if (insp.notes) {
      doc.fontSize(11).font("Helvetica-Bold").fillColor(primaryColor).text("Notes", 50);
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica").fillColor("#555555").text(insp.notes, 50, doc.y, { width: 495 });
      doc.moveDown(1);
    }

    // ── Footer ──
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(borderColor).stroke();
    doc.moveDown(0.5);
    const footerText = pdfSettings.inspectionFooter || `${company.companyName} — Equipment Inspection Report`;
    doc.fontSize(8).font("Helvetica").fillColor("#888888").text(footerText, 50, doc.y, { width: 495, align: "center" });

    doc.end();

    const pdfBuffer = await pdfPromise;
    const fileName = `inspections/inspection-${inspectionId}-${Date.now()}.pdf`;

    const url = await uploadPDFToBucket(pdfBuffer, fileName, "inspections");

    await db.update(schema.inspections).set({
      pdfUrl: url,
      updatedAt: new Date(),
    }).where(eq(schema.inspections.id, inspectionId));

    logger.info("[InspectionPDF] Generated inspection PDF", { inspectionId, url });
    return { url };
  } catch (error) {
    logger.error("[InspectionPDF] Failed to generate inspection PDF", {
      inspectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to generate inspection PDF", { cause: error });
  }
}
