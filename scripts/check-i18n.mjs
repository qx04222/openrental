import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../client/src/i18n/locales/', import.meta.url));
function keys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, v]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return v && typeof v === 'object' ? keys(v, path) : [path];
  });
}
let errors = 0;
const files = new Set(['en', 'zh'].flatMap(lang => readdirSync(join(root, lang)).filter(f => f.endsWith('.json'))));
for (const file of files) {
  const catalogues = ['en', 'zh'].map(lang => {
    try { return new Set(keys(JSON.parse(readFileSync(join(root, lang, file), 'utf8')))); }
    catch { console.error(`Missing or invalid ${lang}/${file}`); errors++; return new Set(); }
  });
  for (const key of new Set([...catalogues[0], ...catalogues[1]])) {
    if (catalogues[0].has(key) !== catalogues[1].has(key)) {
      console.error(`${file}: ${key} missing in ${catalogues[0].has(key) ? 'zh' : 'en'}`); errors++;
    }
  }
}
console.log(`Locale parity: ${files.size} namespaces, ${errors} errors`);
process.exitCode = errors ? 1 : 0;
