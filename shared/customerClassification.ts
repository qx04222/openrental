import { z } from "zod";

/**
 * Fixed vocabularies for customer classification.
 *
 * Fixed on purpose: the unused json `tags` column proved free-form labels don't
 * get filled in, and free text would fork into 园艺/绿化/landscaping all meaning
 * the same thing. Adding a category is a one-line change here; every dropdown,
 * filter and report reads this file.
 *
 * i18n keys live in the admin namespace (`customers.industry.*` /
 * `customers.lang.*`) so the UI never hardcodes a label.
 */

export const CUSTOMER_INDUSTRIES = [
  "landscaping",        // 园艺/景观 — Landscaping, Artscapes, Interlocking, Pools
  "renovation",         // 装修/翻新 — Renovation, Roofing, Interior
  "general_contractor", // 总包/建筑 — Construction, Homes, Builders
  "mechanical",         // 机电/专业工程 — Mechanical, Electrical, HVAC
  "property",           // 地产/物业 — Real Estate, Property Services
  "individual",         // 个人自用 — homeowners, no company
  "other",
] as const;

export type CustomerIndustry = (typeof CUSTOMER_INDUSTRIES)[number];

/**
 * Communication language — what staff actually act on (which language to call,
 * greet and contract in). Deliberately NOT an ethnicity field.
 */
export const CUSTOMER_LANGUAGES = [
  "zh", // 中文
  "en", // English
  "other",
] as const;

export type CustomerLanguage = (typeof CUSTOMER_LANGUAGES)[number];

export const customerIndustrySchema = z.enum(CUSTOMER_INDUSTRIES);
export const customerLanguageSchema = z.enum(CUSTOMER_LANGUAGES);

// Typed to the vocabulary so the return type is the union of REAL i18n keys —
// with a plain `string` parameter it widens to `customers.industry.${string}`,
// which i18next's typed key union rejects, and every t() call site needs a
// cast. A caller holding a DB string narrows it once at the read site (values
// only enter through the zod-validated mutations, so the narrowing is honest).
export const industryI18nKey = (v: CustomerIndustry) => `customers.industry.${v}` as const;
export const languageI18nKey = (v: CustomerLanguage) => `customers.lang.${v}` as const;
