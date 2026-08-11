import "i18next";
import common from "./locales/en/common.json";
import rental from "./locales/en/rental.json";
import fleet from "./locales/en/fleet.json";
import inspection from "./locales/en/inspection.json";
import dispatch from "./locales/en/dispatch.json";
import dashboard from "./locales/en/dashboard.json";
import admin from "./locales/en/admin.json";
import publicNs from "./locales/en/public.json";
import portal from "./locales/en/portal.json";
import quotation from "./locales/en/quotation.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
      rental: typeof rental;
      fleet: typeof fleet;
      inspection: typeof inspection;
      dispatch: typeof dispatch;
      dashboard: typeof dashboard;
      admin: typeof admin;
      public: typeof publicNs;
      portal: typeof portal;
      quotation: typeof quotation;
    };
  }
}
