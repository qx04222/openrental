/**
 * Work Order PDF Generation
 * Printable bilingual (EN/中文) work order mirroring the paper shop form:
 * header info, service requested, labor tracking, parts & materials, notes,
 * and blank hand-signature lines. Branded like the other company PDFs.
 */

import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { APP_TIMEZONE } from "../_core/dateUtils";
import { getCompanyInfo, getPDFSettingsInfo } from "./siteSettingsHelper";
import { registerCJKFont } from "./pdfFontHelper";
import { uploadPDFToBucket } from "./storage";

const SOURCE_LABELS: Record<string, string> = {
  own_fleet: "自有车队 Own Fleet",
  equipment: "机械 Own Equipment",
  other: "其他 Other",
};

const fmtDate = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : "";
const fmtDateTime = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIMEZONE, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d) : "";
const money = (v: string | null | undefined) => `$${(parseFloat(v || "0")).toFixed(2)}`;

export async function generateWorkOrderPDF(workOrderId: number): Promise<{ url: string }> {
  try {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const [row] = await db
      .select()
      .from(schema.workOrders)
      .leftJoin(schema.rentalFleet, and(eq(schema.workOrders.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
      .leftJoin(schema.users, and(eq(schema.workOrders.assignedTo, schema.users.id), isNull(schema.users.deletedAt)))
      .where(and(eq(schema.workOrders.id, workOrderId), isNull(schema.workOrders.deletedAt)))
      .limit(1);
    if (!row) throw new Error(`Work order #${workOrderId} not found`);

    const wo = row.work_orders;
    const fleet = row.rental_fleet;
    const assignee = row.users;

    const labor = await db.select().from(schema.workOrderLabor)
      .where(eq(schema.workOrderLabor.workOrderId, workOrderId))
      .orderBy(schema.workOrderLabor.startAt);
    const parts = await db.select().from(schema.workOrderParts)
      .where(eq(schema.workOrderParts.workOrderId, workOrderId))
      .orderBy(schema.workOrderParts.id);

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
    const hasCJK = (s: string) => /[一-鿿㐀-䶿]/.test(s);
    const cjkOk = (() => { try { doc.font("NotoSansSC"); doc.font("Helvetica"); return true; } catch { return false; } })();
    const fontFor = (text: string, bold = false) => {
      if (cjkOk && hasCJK(text)) return "NotoSansSC";
      return bold ? "Helvetica-Bold" : "Helvetica";
    };

    const primaryColor = "#1a1a2e";
    const accentColor = pdfSettings.accentColor;
    const lightGray = "#f5f5f5";
    const borderColor = "#dddddd";
    const LEFT = 50;
    const RIGHT = 545;
    const WIDTH = RIGHT - LEFT;

    const ensureRoom = (needed: number) => {
      if (doc.y + needed > 780) { doc.addPage(); doc.y = 50; }
    };

    // ── Header ──
    doc.fontSize(22).font("Helvetica-Bold").fillColor(accentColor).text("WORK ORDER", LEFT, 50);
    doc.fontSize(10).font(fontFor("维修工单")).fillColor("#555555").text("维修工单", LEFT, doc.y + 1);

    const rightX = 350;
    doc.fontSize(10).font("Helvetica-Bold").fillColor(primaryColor).text(company.companyName, rightX, 50, { align: "right", width: 195 });
    doc.fontSize(8).font("Helvetica").fillColor("#555555");
    if (company.address) doc.text(company.address, rightX, doc.y, { align: "right", width: 195 });
    if (company.phone) doc.text(`Phone: ${company.phone}`, rightX, doc.y, { align: "right", width: 195 });
    if (company.email) doc.text(`Email: ${company.email}`, rightX, doc.y, { align: "right", width: 195 });

    doc.y = Math.max(doc.y, 95) + 8;
    const lineY = doc.y;
    doc.moveTo(LEFT, lineY).lineTo(RIGHT, lineY).strokeColor(accentColor).lineWidth(2).stroke();
    doc.moveDown(1);

    // ── Info grid (two columns of label/value pairs) ──
    const infoPairs: Array<[string, string]> = [];
    infoPairs.push(["工单编号 Work Order #", wo.workOrderNumber]);
    infoPairs.push(["日期 Date", fmtDate(wo.scheduledDate || wo.createdAt)]);
    if (fleet) {
      infoPairs.push(["设备 Equipment", `${fleet.brand || ""} ${fleet.model || ""}`.trim() || "-"]);
      if (fleet.serialNumber) infoPairs.push(["序列号 Serial #", fleet.serialNumber]);
    }
    if (wo.plateNumber) infoPairs.push(["设备编号/车牌 Plate #", wo.plateNumber]);
    if (wo.meterKms != null) infoPairs.push(["公里数 KMS", String(wo.meterKms)]);
    if (wo.meterHours != null) infoPairs.push(["小时数 HRS", parseFloat(wo.meterHours).toFixed(1)]);
    if (wo.customerName) infoPairs.push(["客户名称 Customer", wo.customerName]);
    if (wo.customerPhone) infoPairs.push(["联系电话 Phone", wo.customerPhone]);
    if (wo.equipmentSource) {
      const src = SOURCE_LABELS[wo.equipmentSource] || wo.equipmentSource;
      infoPairs.push(["设备类型 Equipment Type", wo.equipmentSourceNote ? `${src}（${wo.equipmentSourceNote}）` : src]);
    }
    if (assignee?.name) infoPairs.push(["负责技师 Assigned To", assignee.name]);
    infoPairs.push(["状态 Status", wo.status.replace(/_/g, " ").toUpperCase()]);

    const gridTop = doc.y;
    const colW = WIDTH / 2;
    const rowH = 16;
    const gridRows = Math.ceil(infoPairs.length / 2);
    doc.rect(LEFT, gridTop, WIDTH, gridRows * rowH + 8).fill(lightGray);
    doc.fontSize(8.5);
    infoPairs.forEach(([label, value], i) => {
      const col = i % 2;
      const rowIdx = Math.floor(i / 2);
      const x = LEFT + 5 + col * colW;
      const y = gridTop + 5 + rowIdx * rowH;
      doc.font(fontFor(label, true)).fillColor(primaryColor).text(`${label}: `, x, y, { continued: true, width: colW - 10 });
      doc.font(fontFor(value)).fillColor("#333333").text(value);
    });
    doc.y = gridTop + gridRows * rowH + 18;

    // ── Section helper ──
    const sectionTitle = (zhEn: string) => {
      ensureRoom(60);
      doc.fontSize(11).font(fontFor(zhEn, true)).fillColor(accentColor).text(zhEn, LEFT);
      doc.moveDown(0.4);
    };

    // ── Service requested ──
    sectionTitle("故障描述与维修要求 Service Requested");
    doc.fontSize(9).font(fontFor(wo.description || "-")).fillColor("#333333")
      .text(wo.description || "-", LEFT, doc.y, { width: WIDTH });
    doc.moveDown(1);

    // ── Labor tracking table ──
    sectionTitle("工时记录 Labor Tracking");
    const laborCols = [
      { title: "技师 Tech", x: LEFT, w: 100 },
      { title: "工作内容 Work Detail", x: LEFT + 100, w: 195 },
      { title: "开始 Start", x: LEFT + 295, w: 75 },
      { title: "结束 End", x: LEFT + 370, w: 75 },
      { title: "工时 Hrs", x: LEFT + 445, w: 50 },
    ];
    const drawTableHeader = (cols: typeof laborCols) => {
      const y = doc.y;
      doc.rect(LEFT, y, WIDTH, 16).fill(primaryColor);
      doc.fontSize(8);
      for (const c of cols) {
        doc.font(fontFor(c.title, true)).fillColor("#ffffff").text(c.title, c.x + 4, y + 4, { width: c.w - 8 });
      }
      doc.y = y + 18;
    };
    drawTableHeader(laborCols);
    if (labor.length === 0) {
      // Blank rows so the printed sheet can be filled in by hand
      for (let i = 0; i < 3; i++) {
        const y = doc.y;
        doc.rect(LEFT, y, WIDTH, 16).strokeColor(borderColor).lineWidth(0.5).stroke();
        doc.y = y + 16;
      }
    } else {
      for (const entry of labor) {
        ensureRoom(20);
        const y = doc.y;
        const hrs = entry.endAt ? Math.max(0, (entry.endAt.getTime() - entry.startAt.getTime()) / 3_600_000) : null;
        const cells = [
          entry.technicianName,
          entry.workDetail || "",
          fmtDateTime(entry.startAt),
          fmtDateTime(entry.endAt),
          hrs != null ? hrs.toFixed(2) : "",
        ];
        doc.fontSize(8);
        let maxH = 14;
        cells.forEach((cell, i) => {
          const c = laborCols[i];
          doc.font(fontFor(cell)).fillColor("#333333").text(cell, c.x + 4, y + 3, { width: c.w - 8 });
          maxH = Math.max(maxH, doc.y - y + 3);
        });
        doc.rect(LEFT, y, WIDTH, maxH).strokeColor(borderColor).lineWidth(0.5).stroke();
        doc.y = y + maxH;
      }
    }
    const totalHoursLabel = `总工时 Total Hours: ${wo.actualHours ? parseFloat(wo.actualHours).toFixed(2) : "____"}`;
    doc.fontSize(9).font(fontFor(totalHoursLabel, true)).fillColor(primaryColor)
      .text(totalHoursLabel, LEFT, doc.y + 4, { width: WIDTH, align: "right" });
    doc.moveDown(1);

    // ── Parts & materials table ──
    sectionTitle("配件与耗材清单 Parts & Materials");
    const partCols = [
      { title: "零件号 P/N", x: LEFT, w: 110 },
      { title: "名称规格 Name / Size", x: LEFT + 110, w: 205 },
      { title: "数量 QTY", x: LEFT + 315, w: 55 },
      { title: "单价 Price", x: LEFT + 370, w: 60 },
      { title: "总额 Sum", x: LEFT + 430, w: 65 },
    ];
    drawTableHeader(partCols);
    if (parts.length === 0) {
      for (let i = 0; i < 3; i++) {
        const y = doc.y;
        doc.rect(LEFT, y, WIDTH, 16).strokeColor(borderColor).lineWidth(0.5).stroke();
        doc.y = y + 16;
      }
    } else {
      for (const p of parts) {
        ensureRoom(20);
        const y = doc.y;
        const cells = [
          p.partNumber || "",
          p.partName,
          parseFloat(p.quantity).toFixed(2).replace(/\.00$/, ""),
          money(p.unitCost),
          money(p.totalCost),
        ];
        doc.fontSize(8);
        let maxH = 14;
        cells.forEach((cell, i) => {
          const c = partCols[i];
          doc.font(fontFor(cell)).fillColor("#333333").text(cell, c.x + 4, y + 3, { width: c.w - 8 });
          maxH = Math.max(maxH, doc.y - y + 3);
        });
        doc.rect(LEFT, y, WIDTH, maxH).strokeColor(borderColor).lineWidth(0.5).stroke();
        doc.y = y + maxH;
      }
    }
    const partsTotalLabel = `材料汇总 Materials Total: ${money(wo.partsCost)}`;
    doc.fontSize(9).font(fontFor(partsTotalLabel, true)).fillColor(primaryColor)
      .text(partsTotalLabel, LEFT, doc.y + 4, { width: WIDTH, align: "right" });
    doc.moveDown(1);

    // ── Cost summary ──
    ensureRoom(60);
    const costY = doc.y;
    doc.moveTo(LEFT, costY).lineTo(RIGHT, costY).strokeColor(borderColor).stroke();
    doc.fontSize(9).fillColor(primaryColor);
    const costLines: Array<[string, string]> = [
      ["工时费 Labor Cost", money(wo.laborCost)],
      ["配件费 Parts Cost", money(wo.partsCost)],
      ["合计 Total", money(wo.totalCost)],
    ];
    let cy = costY + 6;
    for (const [label, value] of costLines) {
      doc.font(fontFor(label, true)).text(label, 350, cy, { width: 120 });
      doc.font("Helvetica-Bold").text(value, 470, cy, { width: 75, align: "right" });
      cy += 14;
    }
    doc.y = cy + 6;

    // ── Notes & recommendations ──
    const notesText = [wo.findings, wo.resolution, wo.notes].filter(Boolean).join("\n");
    sectionTitle("备注与建议 Notes & Recommendations");
    doc.fontSize(9).font(fontFor(notesText || "-")).fillColor("#333333")
      .text(notesText || "-", LEFT, doc.y, { width: WIDTH });
    doc.moveDown(2);

    // ── Hand-signature blanks ──
    ensureRoom(70);
    const sigY = doc.y + 20;
    doc.moveTo(LEFT, sigY).lineTo(LEFT + 200, sigY).strokeColor("#333333").lineWidth(0.8).stroke();
    doc.moveTo(320, sigY).lineTo(RIGHT, sigY).strokeColor("#333333").lineWidth(0.8).stroke();
    const sigLabelTech = "技师签名 Technician Signature / 日期 Date";
    const sigLabelApproval = "主管/客户签字 Approval Signature / 日期 Date";
    doc.fontSize(8).fillColor("#555555");
    doc.font(fontFor(sigLabelTech)).text(sigLabelTech, LEFT, sigY + 4, { width: 200 });
    doc.font(fontFor(sigLabelApproval)).text(sigLabelApproval, 320, sigY + 4, { width: 225 });
    doc.y = sigY + 30;

    // ── Footer ──
    doc.moveTo(LEFT, doc.y).lineTo(RIGHT, doc.y).strokeColor(borderColor).stroke();
    doc.moveDown(0.5);
    const footerText = `${company.companyName} — ${wo.workOrderNumber}`;
    doc.fontSize(8).font("Helvetica").fillColor("#888888").text(footerText, LEFT, doc.y, { width: WIDTH, align: "center" });

    doc.end();
    const pdfBuffer = await pdfPromise;
    const fileName = `work-orders/${wo.workOrderNumber}-${Date.now()}.pdf`;
    const url = await uploadPDFToBucket(pdfBuffer, fileName, "work-orders");

    logger.info("[WorkOrderPDF] Generated work order PDF", { workOrderId, url });
    return { url };
  } catch (error) {
    logger.error("[WorkOrderPDF] Failed to generate work order PDF", {
      workOrderId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to generate work order PDF", { cause: error });
  }
}
