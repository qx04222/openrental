import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enRental from "./locales/en/rental.json";
import enFleet from "./locales/en/fleet.json";
import enInspection from "./locales/en/inspection.json";
import enDispatch from "./locales/en/dispatch.json";
import enDashboard from "./locales/en/dashboard.json";
import enAdmin from "./locales/en/admin.json";
import enPublic from "./locales/en/public.json";
import enPortal from "./locales/en/portal.json";
import enQuotation from "./locales/en/quotation.json";

import zhCommon from "./locales/zh/common.json";
import zhRental from "./locales/zh/rental.json";
import zhFleet from "./locales/zh/fleet.json";
import zhInspection from "./locales/zh/inspection.json";
import zhDispatch from "./locales/zh/dispatch.json";
import zhDashboard from "./locales/zh/dashboard.json";
import zhAdmin from "./locales/zh/admin.json";
import zhPublic from "./locales/zh/public.json";
import zhPortal from "./locales/zh/portal.json";
import zhQuotation from "./locales/zh/quotation.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        rental: enRental,
        fleet: enFleet,
        inspection: enInspection,
        dispatch: enDispatch,
        dashboard: enDashboard,
        admin: enAdmin,
        public: enPublic,
        portal: enPortal,
        quotation: enQuotation,
      },
      zh: {
        common: zhCommon,
        rental: zhRental,
        fleet: zhFleet,
        inspection: zhInspection,
        dispatch: zhDispatch,
        dashboard: zhDashboard,
        admin: zhAdmin,
        public: zhPublic,
        portal: zhPortal,
        quotation: zhQuotation,
      },
    },
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
