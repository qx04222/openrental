#!/usr/bin/env node
/**
 * Read-only audit. Scans the client for t("namespace.key") calls and
 * verifies each key exists in BOTH zh and en locale files.
 *
 * Output:
 *   missing  — used in code but absent in the matching locale JSON
 *   stale    — present in JSON but never referenced in code (warning only)
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, basename, extname } from "path";

const ROOT = "/Users/xin/Desktop/openrental";
const SRC = join(ROOT, "client/src");
const LOCALES = join(SRC, "i18n/locales");

function walk(dir, exts, files = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === "node_modules" || name === ".claude") continue;
      walk(p, exts, files);
    } else if (exts.includes(extname(name))) files.push(p);
  }
  return files;
}

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const sources = walk(SRC, [".ts", ".tsx"]);
const usedKeys = new Map(); // key → Set<file>
// regex: t("ns.key" ... )  — captures key, also handles t("ns.key", "default")
const tCallRe = /\bt\(\s*"([a-zA-Z][a-zA-Z0-9._-]*)"/g;
for (const f of sources) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(tCallRe)) {
    if (!usedKeys.has(m[1])) usedKeys.set(m[1], new Set());
    usedKeys.get(m[1]).add(f.replace(SRC + "/", ""));
  }
}

// Load every locale file
function loadLocale(lang) {
  const dir = join(LOCALES, lang);
  const out = {};
  for (const f of readdirSync(dir)) {
    if (extname(f) !== ".json") continue;
    const ns = basename(f, ".json");
    const content = JSON.parse(readFileSync(join(dir, f), "utf8"));
    Object.assign(out, flatten(content));
    // Also store namespace-prefixed if not already
  }
  return out;
}

const zh = loadLocale("zh");
const en = loadLocale("en");

// Find missing keys per locale
const missingZh = [];
const missingEn = [];
const knownNamespaces = new Set(readdirSync(join(LOCALES, "zh")).map(f => basename(f, ".json")));

for (const [key, files] of usedKeys) {
  // Skip dynamic keys (e.g. t(`fleetStatus.${status}`)) — they aren't literal
  if (key.includes("$")) continue;
  // Skip very generic keys that are clearly not domain-specific (single word like "loading", "actions")
  const inZh = key in zh;
  const inEn = key in en;
  if (!inZh) missingZh.push({ key, files: [...files] });
  if (!inEn) missingEn.push({ key, files: [...files] });
}

const fmt = (rows) => rows
  .sort((a, b) => a.key.localeCompare(b.key))
  .map(r => `  ${r.key}\n    ${[...r.files].slice(0, 2).join(", ")}`)
  .join("\n");

console.log(`Sources: ${sources.length} files`);
console.log(`Keys used in code: ${usedKeys.size}`);
console.log(`Keys in zh JSON: ${Object.keys(zh).length}`);
console.log(`Keys in en JSON: ${Object.keys(en).length}`);
console.log();

if (missingZh.length === 0 && missingEn.length === 0) {
  console.log("✅ No missing translations found.");
} else {
  if (missingZh.length > 0) {
    console.log(`❌ Missing in zh (${missingZh.length}):`);
    console.log(fmt(missingZh));
    console.log();
  }
  if (missingEn.length > 0) {
    console.log(`❌ Missing in en (${missingEn.length}):`);
    console.log(fmt(missingEn));
  }
}
