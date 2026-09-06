import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
const root = "dist/public";
const manifest = JSON.parse(readFileSync(join(root, ".vite/manifest.json"), "utf8"));
const seen = new Set();
function visit(key) { if (seen.has(key)) return; seen.add(key); for (const dependency of manifest[key].imports || []) visit(dependency); }
visit("index.html");
const files = [...seen].map(key => manifest[key].file);
const bytes = files.reduce((total, file) => total + gzipSync(readFileSync(join(root, file))).length, 0);
const heavy = files.filter(file => /charts-vendor|jspdf|html2canvas|DispatchCalendar/.test(file));
if (heavy.length) throw new Error(`Heavy optional features entered the initial load: ${heavy.join(", ")}`);
if (bytes > 175_000) throw new Error(`Initial gzip JS ${bytes} exceeds 175000-byte budget`);
const html = readFileSync(join(root, "index.html"), "utf8");
if (/fonts\.(googleapis|gstatic)\.com/.test(html)) throw new Error("Render-blocking third-party fonts returned");
const fonts = readdirSync(join(root, "assets")).filter(file => file.endsWith(".woff2"));
const fontBytes = fonts.reduce((total, file) => total + readFileSync(join(root, "assets", file)).length, 0);
if (fontBytes > 80_000) throw new Error(`Font payload ${fontBytes} exceeds 80000-byte budget`);
console.log(JSON.stringify({ initialJsGzipBytes: bytes, initialJsBudget: 175000, fontBytes, fontBudget: 80000, heavyFeaturesRemainLazy: true, thirdPartyFonts: false }));
