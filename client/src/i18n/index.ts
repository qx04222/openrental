import i18n, { type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import enCommon from "./locales/en/common.json";
import zhCommon from "./locales/zh/common.json";

// Keep the small shell dictionary available even offline. Load other languages
// and namespaces only when their route needs them; Vite emits hashed chunks.
const dictionaries = import.meta.glob<{ default: Record<string, string> }>(["./locales/*/*.json", "!./locales/*/common.json"]);
const backend: BackendModule = {
  type: "backend",
  init() {},
  read(language, namespace, callback) {
    const load = dictionaries[`./locales/${language}/${namespace}.json`];
    if (!load) { callback(new Error("Unknown translation dictionary"), false); return; }
    load().then(module => callback(null, module.default)).catch(error => callback(error, false));
  },
};

i18n.use(LanguageDetector).use(backend).use(initReactI18next).init({
  resources: { en: { common: enCommon }, zh: { common: zhCommon } },
  partialBundledLanguages: true,
  supportedLngs: ["en", "zh"],
  load: "languageOnly",
  ns: ["common"],
  fallbackLng: "en",
  defaultNS: "common",
  interpolation: { escapeValue: false },
  detection: { order: ["localStorage", "navigator"], caches: ["localStorage"] },
});

if (typeof document !== "undefined") {
  i18n.on("languageChanged", language => { document.documentElement.lang = language.startsWith("zh") ? "zh" : "en"; });
  document.documentElement.lang = i18n.language?.startsWith("zh") ? "zh" : "en";
}

export default i18n;
