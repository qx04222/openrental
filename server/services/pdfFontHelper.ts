/**
 * PDF Font Helper
 * Registers fonts for PDFKit documents:
 *  - NotoSansSC : CJK (Chinese) text support
 *  - Signature  : Great Vibes script face, used for the built-in typeset
 *                 company (Lessor) signature on contracts. OFL-1.1 licensed.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function locate(file: string): string {
  const candidates = [
    resolve(__dirname, `../assets/fonts/${file}`),
    resolve(__dirname, `../../server/assets/fonts/${file}`),
    resolve(process.cwd(), `server/assets/fonts/${file}`),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

const CJK_FONT_PATH = locate("NotoSansSC-Regular.ttf");
const SIGNATURE_FONT_PATH = locate("GreatVibes-Regular.ttf");

/**
 * Register the NotoSansSC CJK font on a PDFKit document.
 * After calling this, use doc.font("NotoSansSC") for Chinese text.
 */
export function registerCJKFont(doc: PDFKit.PDFDocument): void {
  try {
    doc.registerFont("NotoSansSC", CJK_FONT_PATH);
  } catch {
    // Font not found — skip CJK registration, Helvetica will be used as fallback
  }
}

/**
 * Register the script signature font. After calling this, use
 * doc.font("Signature") to render a typeset cursive signature.
 * Returns true if the font was registered (so callers can fall back to an
 * italic standard font when the asset is missing).
 */
export function registerSignatureFont(doc: PDFKit.PDFDocument): boolean {
  try {
    if (!existsSync(SIGNATURE_FONT_PATH)) return false;
    doc.registerFont("Signature", SIGNATURE_FONT_PATH);
    return true;
  } catch {
    return false;
  }
}
