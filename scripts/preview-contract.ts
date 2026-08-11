/**
 * Local contract preview — renders the default KD v2 template + typeset
 * signature to /tmp/sample-contract.pdf WITHOUT touching the DB or storage.
 * Mirrors the markdown render loop from contractPDF.ts for visual review.
 *
 *   npx tsx scripts/preview-contract.ts
 */
import PDFDocumentImport from "pdfkit";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { DEFAULT_CONTRACT_TEMPLATE_CONTENT } from "../server/services/contractTemplateSeed";
import { registerCJKFont, registerSignatureFont } from "../server/services/pdfFontHelper";

const PDFDocument = PDFDocumentImport as unknown as typeof import("pdfkit");

const BRAND_ACCENT = "#2563EB";
const DARK = "#000000";
const GRAY = "#444444";
const BORDER = "#e0e0e0";

// Sample signatory + deal data (for visual review only).
const company = { companyName: "OpenRental", repName: "Xin Qi", repTitle: "Authorized Representative" };
const variables: Record<string, string> = {
  companyName: company.companyName,
  customerName: "Acme Construction Ltd.",
  equipmentDescription: "SDLG E660F Excavator",
  equipmentSerial: "SDLGE660F-2024-0173",
  startDate: "June 5, 2026",
  endDate: "July 3, 2026",
  deliveryAddress: "120 Industrial Pkwy, Aurora, ON",
  dailyRate: "$280.00",
  weeklyRate: "$1,250.00",
  monthlyRate: "$3,300.00",
  deposit: "$2,000.00",
  totalAmount: "$8,450.00",
  agreementNumber: "RNT-2026-0042",
  effectiveDate: "June 1, 2026",
  signatureDate: "______________________________",
  renterSignature: "",
};

const M = 50;
const pageW = 612;
const contentW = pageW - M * 2;
const doc = new PDFDocument({ size: "LETTER", margins: { top: 40, bottom: 40, left: M, right: M } });
const chunks: Buffer[] = [];
doc.on("data", (c: Buffer) => chunks.push(c));
const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

registerCJKFont(doc);
const hasScriptFont = registerSignatureFont(doc);

const logoPath = resolve(process.cwd(), "client/public/logo.png");
try { doc.image(logoPath, M, 40, { height: 45 }); doc.y = 95; } catch { doc.y = 60; }
doc.moveTo(M, doc.y).lineTo(pageW - M, doc.y).lineWidth(2).strokeColor(BRAND_ACCENT).stroke();
doc.moveDown(0.6);

const subst = (s: string) => s.replace(/\{(\w+)\}/g, (m, k) => variables[k] ?? m);
const lines = subst(DEFAULT_CONTRACT_TEMPLATE_CONTENT).split("\n");

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) { doc.moveDown(0.15); continue; }

  if (trimmed === "[[LESSOR_SIGNATURE]]") {
    const sy = doc.y;
    if (company.repName) {
      if (hasScriptFont) doc.fontSize(26).font("Signature").fillColor(DARK).text(company.repName, M, sy);
      else doc.fontSize(18).font("Times-Italic").fillColor(DARK).text(company.repName, M, sy);
      const credit = company.repTitle ? `${company.repName}, ${company.repTitle}` : company.repName;
      doc.fontSize(8).font("Helvetica").fillColor(GRAY).text(`Per: ${credit}`, M, doc.y + 1);
    } else {
      doc.fontSize(8).font("Helvetica").fillColor(DARK).text("Signature: ______________________________", M, sy);
    }
    doc.moveDown(0.3);
    continue;
  }
  if (trimmed === "[[LESSEE_SIGNATURE]]") {
    doc.fontSize(8).font("Helvetica").fillColor(DARK).text("Signature: ______________________________", M, doc.y);
    doc.moveDown(0.3);
    continue;
  }
  if (/^# /.test(trimmed)) {
    doc.fontSize(13).font("Helvetica-Bold").fillColor(DARK).text(trimmed.replace(/^# /, ""), M, doc.y, { width: contentW, align: "center" });
    doc.moveDown(0.3); continue;
  }
  if (/^## /.test(trimmed)) {
    doc.moveDown(0.25);
    doc.fontSize(9.5).font("Helvetica-Bold").fillColor(BRAND_ACCENT).text(trimmed.replace(/^## /, ""), M, doc.y, { width: contentW });
    doc.moveTo(M, doc.y + 1).lineTo(M + contentW * 0.35, doc.y + 1).lineWidth(0.5).strokeColor(BRAND_ACCENT).stroke();
    doc.moveDown(0.15); continue;
  }
  if (/^### /.test(trimmed)) {
    doc.fontSize(8.5).font("Helvetica-Bold").fillColor(DARK).text(trimmed.replace(/^### /, ""), M, doc.y, { width: contentW });
    doc.moveDown(0.05); continue;
  }
  doc.fontSize(8).font("Helvetica").fillColor(DARK).text(trimmed.replace(/\*\*/g, ""), M, doc.y, { width: contentW, align: "justify" });
  doc.moveDown(0.05);
}

doc.end();
done.then((buf) => {
  writeFileSync("/tmp/sample-contract.pdf", buf);
  console.log(`Wrote /tmp/sample-contract.pdf (${buf.length} bytes), scriptFont=${hasScriptFont}`);
});
