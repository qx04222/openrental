import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  numeric,
  pgEnum,
  index,
  uniqueIndex,
  unique,
  json,
  jsonb,
  date,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Enums ─────────────────────────────────────────────────────
export const unifiedRoleEnum = pgEnum("unified_role", ["super_admin", "admin", "accountant", "user", "field_staff"]);
export const catalogSourceEnum = pgEnum("catalogSource", ["industrial", "powersports", "manual"]);
export const fleetStatusEnum = pgEnum("fleetStatus", ["available", "rented", "maintenance", "retired"]);
export const rentalStatusEnum = pgEnum("rentalStatus", [
  "pending", "approved", "rejected", "active", "completed", "cancelled", "overdue",
]);
export const paymentStatusEnum = pgEnum("paymentStatus", [
  "pending", "paid", "partial", "refunded", "failed",
]);
export const inspectionTypeEnum = pgEnum("inspectionType", ["dispatch", "return", "general"]);
export const conditionEnum = pgEnum("condition", ["excellent", "good", "fair", "poor"]);
export const dispatchStatusEnum = pgEnum("dispatchStatus", [
  "pending", "assigned", "in_transit", "delivered", "completed", "cancelled",
]);
export const dispatchOrderTypeEnum = pgEnum("dispatchOrderType", ["delivery", "pickup"]);
export const deliveryMethodEnum = pgEnum("deliveryMethod", ["pickup", "delivery", "delivery_and_return"]);
export const insuranceTypeEnum = pgEnum("insuranceType", ["none", "basic", "full"]);
export const settingCategoryEnum = pgEnum("settingCategory", ["insurance", "deposits", "pricing", "rental_rules"]);

// ─── Users ─────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 100 }).unique(),
  email: varchar("email", { length: 255 }).unique(),
  name: varchar("name", { length: 255 }),
  passwordHash: text("passwordHash"),
  phone: varchar("phone", { length: 20 }),
  role: unifiedRoleEnum("role").default("user").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  lastSignedIn: timestamp("lastSignedIn", { mode: "date" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  phoneIdx: index("users_phone_idx").on(table.phone),
}));

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Refresh Tokens ────────────────────────────────────────────
export const refreshTokens = pgTable("refresh_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("userId").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tokenHash: text("tokenHash").notNull(),
  authType: varchar("authType", { length: 50 }).notNull(),
  deviceName: varchar("deviceName", { length: 255 }),
  expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
});

// ─── Customer Source Enum ──────────────────────────────────────
export const customerSourceEnum = pgEnum("customerSource", ["website", "phone", "referral", "walk_in", "admin", "other"]);

// ─── Customers ─────────────────────────────────────────────────
export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  company: varchar("company", { length: 255 }),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  province: varchar("province", { length: 100 }),
  postalCode: varchar("postalCode", { length: 20 }),
  notes: text("notes"),
  // CRM fields
  tags: json("tags").$type<string[]>().default([]),
  source: customerSourceEnum("source").default("website"),
  // Denormalized counters (auto-maintained by rental create/status hooks)
  totalRentals: integer("totalRentals").default(0).notNull(),
  totalRevenue: numeric("totalRevenue", { precision: 12, scale: 2 }).default("0").notNull(),
  lastRentalDate: timestamp("lastRentalDate", { mode: "date" }),
  // Follow-up tracking
  nextFollowUp: timestamp("nextFollowUp", { mode: "date" }),
  followUpNotes: text("followUpNotes"),
  lastContactedAt: timestamp("lastContactedAt", { mode: "date" }),
  // Risk/credit
  riskScore: integer("riskScore").default(50),
  // Big-customer discount: a customer-level % applied to the rental fee on every
  // order for this customer (insurance/tax follow the discounted fee). Lowest
  // priority — explicit customer_pricing contract rows still win.
  discountPercent: numeric("discountPercent", { precision: 5, scale: 2 }).default("0").notNull(),
  // Credit limit & blacklist (migration 081)
  creditLimit: numeric("creditLimit", { precision: 12, scale: 2 }),
  isBlacklisted: boolean("isBlacklisted").default(false).notNull(),
  blacklistReason: text("blacklistReason"),
  blacklistedAt: timestamp("blacklistedAt", { mode: "date" }),
  // Referral binding
  referralCodeId: integer("referralCodeId"),
  referralBoundAt: timestamp("referralBoundAt", { mode: "date" }),
  // Birthday & greeting opt-in
  birthday: date("birthday", { mode: "string" }),
  greetingOptIn: boolean("greetingOptIn").default(true).notNull(),
  // Classification (migration 151). Vocabularies in shared/customerClassification.ts.
  // preferredLanguage is a communication language, deliberately not an ethnicity.
  // confirmedAt = a human reviewed the (possibly AI-suggested) values.
  industry: varchar("industry", { length: 40 }),
  // 副营 — the industries beyond the primary. Reports aggregate by `industry`
  // only (conservation: each dollar counted once); filters match either.
  // (migration 152)
  secondaryIndustries: text("secondaryIndustries").array().notNull().default(sql`'{}'::text[]`),
  preferredLanguage: varchar("preferredLanguage", { length: 20 }),
  classificationConfirmedAt: timestamp("classificationConfirmedAt", { mode: "date" }),
  classificationConfirmedBy: integer("classificationConfirmedBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  emailIdx: index("customers_email_idx").on(table.email),
  phoneIdx: index("customers_phone_idx").on(table.phone),
  followUpIdx: index("customers_follow_up_idx").on(table.nextFollowUp),
  referralIdx: index("customers_referral_idx").on(table.referralCodeId),
}));

export type Customer = typeof customers.$inferSelect;

// ─── Customer Interaction Type Enum ──────────────────────────
export const interactionTypeEnum = pgEnum("interactionType", ["call", "email", "note", "visit", "complaint", "follow_up"]);

// ─── Customer Interactions ───────────────────────────────────
export const customerInteractions = pgTable("customer_interactions", {
  id: serial("id").primaryKey(),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  type: interactionTypeEnum("type").notNull(),
  summary: text("summary").notNull(),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  customerIdx: index("interactions_customer_idx").on(table.customerId),
  createdAtIdx: index("interactions_created_at_idx").on(table.createdAt),
}));

export type CustomerInteraction = typeof customerInteractions.$inferSelect;

// ─── Warehouses ────────────────────────────────────────────────
export const warehouses = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  address: text("address"),
  city: varchar("city", { length: 100 }),
  province: varchar("province", { length: 100 }),
  postalCode: varchar("postalCode", { length: 20 }),
  phone: varchar("phone", { length: 50 }),
  isActive: boolean("isActive").default(true).notNull(),
  isPrimary: boolean("isPrimary").default(false).notNull(),
  contactName: varchar("contactName", { length: 255 }),
  contactPhone: varchar("contactPhone", { length: 50 }),
  contactEmail: varchar("contactEmail", { length: 255 }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
});

// ─── Tax Rates ────────────────────────────────────────────────
export const taxRates = pgTable("tax_rates", {
  id: serial("id").primaryKey(),
  province: varchar("province", { length: 2 }).notNull().unique(),
  provinceName: varchar("provinceName", { length: 100 }).notNull(),
  gstRate: numeric("gstRate", { precision: 5, scale: 4 }).default("0").notNull(),
  pstRate: numeric("pstRate", { precision: 5, scale: 4 }).default("0").notNull(),
  hstRate: numeric("hstRate", { precision: 5, scale: 4 }).default("0").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
});

// ─── Shipping Pricing Tiers ──────────────────────────────────
export const shippingPricingTiers = pgTable("shipping_pricing_tiers", {
  id: serial("id").primaryKey(),
  tierName: varchar("tierName", { length: 100 }).notNull(),
  baseFee: numeric("baseFee", { precision: 10, scale: 2 }).notNull(),
  includedKilometers: numeric("includedKilometers", { precision: 10, scale: 2 }).notNull(),
  pricePerKmAfter: numeric("pricePerKmAfter", { precision: 10, scale: 2 }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
});

// ─── Shipping Pricing Equipment Mapping ──────────────────────
export const shippingPricingEquipmentMapping = pgTable("shipping_pricing_equipment_mapping", {
  id: serial("id").primaryKey(),
  pricingTierId: integer("pricingTierId").references(() => shippingPricingTiers.id, { onDelete: "cascade" }).notNull(),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
});

// ─── Shipping Pricing Rules (by model/category) ──────────────
export const shippingPricingRules = pgTable("shipping_pricing_rules", {
  id: serial("id").primaryKey(),
  pricingTierId: integer("pricingTierId").references(() => shippingPricingTiers.id, { onDelete: "cascade" }).notNull(),
  equipmentModelId: integer("equipmentModelId").references(() => equipmentModels.id, { onDelete: "set null" }),
  category: varchar("category", { length: 255 }),
  priority: integer("priority").notNull().default(100),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  modelIdx: index("shipping_rules_model_idx").on(table.equipmentModelId),
  categoryIdx: index("shipping_rules_category_idx").on(table.category),
}));

// Equipment kind: machine | attachment. Defined here so catalog_cache (which
// owns the attachment-marking column) can reference it directly.
export const equipmentTypeEnum = pgEnum("equipment_type", ["machine", "attachment"]);

// ─── Catalog Cache (synced from TerraX) ────────────────────────
export const catalogCache = pgTable("catalog_cache", {
  id: serial("id").primaryKey(),
  sourceType: catalogSourceEnum("sourceType").notNull(),
  sourceId: integer("sourceId"),
  brand: varchar("brand", { length: 100 }).notNull(),
  model: varchar("model", { length: 200 }).notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  modelYear: integer("modelYear"),
  description: text("description"),
  specifications: text("specifications"),
  msrp: numeric("msrp", { precision: 10, scale: 2 }),
  imageUrl: text("imageUrl"),
  galleryImages: text("galleryImages"),
  // Engine/machine parameters (flattened for display)
  enginePower: varchar("enginePower", { length: 50 }),
  operatingWeight: varchar("operatingWeight", { length: 50 }),
  bucketCapacity: varchar("bucketCapacity", { length: 50 }),
  ratedLoad: varchar("ratedLoad", { length: 50 }),
  // Catalog management fields
  availabilityStatus: varchar("availabilityStatus", { length: 50 }).default("available"),
  leadTimeDays: integer("leadTimeDays"),
  displayOrder: integer("displayOrder").default(0),
  brochureUrl: text("brochureUrl"),
  videoUrl: text("videoUrl"),
  // checksum was originally used by the retired TerraX sync to detect
  // unchanged catalog rows. It's still nullable in the table for legacy
  // rows and only ever written as `null` from the admin CRUD path, so
  // we keep the column for now (cheap to keep, removing it requires a
  // visible UI change). The companion `sourceData` and `lastSyncedAt`
  // columns were dropped in migration 098.
  checksum: varchar("checksum", { length: 64 }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  // migration 093 — moved here from equipment_models. Catalog is the source
  // of truth for attachment marking now.
  equipmentType: equipmentTypeEnum("equipment_type").default("machine").notNull(),
}, (table) => ({
  sourceIdx: index("catalog_cache_source_idx").on(table.sourceType, table.sourceId),
  brandIdx: index("catalog_cache_brand_idx").on(table.brand),
}));

export type CatalogCache = typeof catalogCache.$inferSelect;

// ─── Equipment Categories (master list) ──────────────────────
export const equipmentCategories = pgTable("equipment_categories", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  description: text("description"),
  // migration 139 — machine vs attachment category split
  equipmentType: equipmentTypeEnum("equipment_type").default("machine").notNull(),
  displayOrder: integer("displayOrder").default(0),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
});

export type EquipmentCategory = typeof equipmentCategories.$inferSelect;

// ─── Equipment Models (aggregation layer) ─────────────────────
// Equipment kind enum is defined alongside catalog_cache (above) since the
// catalog is the source of truth for attachment marking after migration 093.
// equipment_models.equipmentType is retained as a derived/legacy field — code
// no longer reads it; future cleanup can drop the column.

export const equipmentModels = pgTable("equipment_models", {
  id: serial("id").primaryKey(),
  category: varchar("category", { length: 255 }).notNull(),
  brand: varchar("brand", { length: 255 }).notNull(),
  model: varchar("model", { length: 255 }).notNull(),
  displayName: varchar("displayName", { length: 500 }),
  imageUrl: text("imageUrl"),
  dailyRate: numeric("dailyRate", { precision: 12, scale: 2 }),
  weeklyRate: numeric("weeklyRate", { precision: 12, scale: 2 }),
  monthlyRate: numeric("monthlyRate", { precision: 12, scale: 2 }),
  twentyEightDayRate: numeric("twentyEightDayRate", { precision: 12, scale: 2 }),
  description: text("description"),
  specs: jsonb("specs"),
  // migration 089
  equipmentType: equipmentTypeEnum("equipment_type").default("machine").notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  categoryIdx: index("equipment_models_category_idx").on(table.category),
  brandModelIdx: index("equipment_models_brand_model_idx").on(table.brand, table.model),
  categoryBrandModelUnique: unique("equipment_models_category_brand_model_unique").on(table.category, table.brand, table.model),
}));

// ─── Equipment Model Price Versions (effective-dated category pricing) ─────
// equipment_models rate columns are the "currently effective" cache; this table
// is the source of truth for price history + future-scheduled changes. See
// sql/129. Resolution/promotion lives in server/services/priceVersions.ts.
export const equipmentModelPriceVersions = pgTable("equipment_model_price_versions", {
  id: serial("id").primaryKey(),
  equipmentModelId: integer("equipment_model_id").references(() => equipmentModels.id, { onDelete: "cascade" }).notNull(),
  dailyRate: numeric("dailyRate", { precision: 12, scale: 2 }),
  weeklyRate: numeric("weeklyRate", { precision: 12, scale: 2 }),
  monthlyRate: numeric("monthlyRate", { precision: 12, scale: 2 }),
  twentyEightDayRate: numeric("twentyEightDayRate", { precision: 12, scale: 2 }),
  effectiveFrom: timestamp("effective_from", { mode: "date" }).notNull(),
  effectiveTo: timestamp("effective_to", { mode: "date" }), // NULL = open-ended tail
  source: varchar("source", { length: 50 }).default("manual").notNull(),
  note: text("note"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  supersededAt: timestamp("superseded_at", { mode: "date" }),
}, (table) => ({
  modelFromIdx: index("empv_model_from_idx").on(table.equipmentModelId, table.effectiveFrom),
}));

export type EquipmentModelPriceVersion = typeof equipmentModelPriceVersions.$inferSelect;

// N:N — which catalog items (machines) can mount which attachment.
// migration 089 created this against equipment_models; migration 093 moved
// it to reference catalog_cache so identity matches the master catalog.
export const attachmentCompatibility = pgTable("attachment_compatibility", {
  id: serial("id").primaryKey(),
  attachmentCatalogId: integer("attachmentCatalogId").notNull().references(() => catalogCache.id, { onDelete: "cascade" }),
  machineCatalogId: integer("machineCatalogId").notNull().references(() => catalogCache.id, { onDelete: "cascade" }),
  notes: text("notes"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  attachmentIdx: index("attachment_compatibility_attachment_catalog_idx").on(table.attachmentCatalogId),
  machineIdx: index("attachment_compatibility_machine_catalog_idx").on(table.machineCatalogId),
  pairUnique: unique("attachment_compatibility_unique").on(table.attachmentCatalogId, table.machineCatalogId),
}));

// Rental order line items — scaffold for Stage C cart flow. Stage A/B do not
// write here. Stage C: each rental_request acquires one+ line items, replacing
// the single rental_requests.rentalFleetId pointer for new rentals.
// migration 089
export const rentalLineItems = pgTable("rental_line_items", {
  id: serial("id").primaryKey(),
  rentalRequestId: integer("rentalRequestId").notNull().references(() => rentalRequests.id, { onDelete: "restrict" }),
  rentalFleetId: integer("rentalFleetId"),
  equipmentModelId: integer("equipmentModelId"),
  itemType: equipmentTypeEnum("itemType").default("machine").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  dailyRate: numeric("dailyRate", { precision: 12, scale: 2 }),
  weeklyRate: numeric("weeklyRate", { precision: 12, scale: 2 }),
  monthlyRate: numeric("monthlyRate", { precision: 12, scale: 2 }),
  customerEquipmentNote: text("customerEquipmentNote"),
  compatibilityAcknowledgedAt: timestamp("compatibilityAcknowledgedAt", { mode: "date" }),
  // migration 092 — per-line dates + pricing snapshots
  startDate: timestamp("startDate", { mode: "date" }),
  endDate: timestamp("endDate", { mode: "date" }),
  lineDeposit: numeric("lineDeposit", { precision: 12, scale: 2 }),
  lineSubtotal: numeric("lineSubtotal", { precision: 12, scale: 2 }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  rentalIdx: index("rental_line_items_rental_idx").on(table.rentalRequestId),
  fleetIdx: index("rental_line_items_fleet_idx").on(table.rentalFleetId),
  modelIdx: index("rental_line_items_model_idx").on(table.equipmentModelId),
}));

// ─── Rental Fleet ──────────────────────────────────────────────
export const rentalFleet = pgTable("rental_fleet", {
  id: serial("id").primaryKey(),
  catalogCacheId: integer("catalogCacheId").references(() => catalogCache.id, { onDelete: "set null" }),
  // Denormalized for display (in case cache is stale)
  brand: varchar("brand", { length: 100 }).notNull(),
  model: varchar("model", { length: 200 }).notNull(),
  category: varchar("category", { length: 100 }),
  year: integer("year"),
  serialNumber: varchar("serialNumber", { length: 100 }).unique(),
  assetNumber: varchar("assetNumber", { length: 50 }).unique(),
  vin: varchar("vin", { length: 17 }).unique(),
  internalId: varchar("internalId", { length: 100 }),
  currentStatus: fleetStatusEnum("currentStatus").default("available").notNull(),
  locationId: integer("locationId").references(() => warehouses.id, { onDelete: "set null" }),
  division: varchar("division", { length: 50 }),
  // Pricing
  dailyRate: numeric("dailyRate", { precision: 10, scale: 2 }),
  weeklyRate: numeric("weeklyRate", { precision: 10, scale: 2 }),
  monthlyRate: numeric("monthlyRate", { precision: 10, scale: 2 }),
  twentyEightDayRate: numeric("twentyEightDayRate", { precision: 10, scale: 2 }),
  // Purchase info
  purchaseDate: timestamp("purchaseDate", { mode: "date" }),
  purchaseCost: numeric("purchaseCost", { precision: 10, scale: 2 }),
  // Condition
  engineHours: integer("engineHours"),
  odometerReading: integer("odometerReading"),
  condition: conditionEnum("condition").default("good"),
  // Maintenance
  lastMaintenanceDate: timestamp("lastMaintenanceDate", { mode: "date" }),
  nextMaintenanceDate: timestamp("nextMaintenanceDate", { mode: "date" }),
  lastServiceHours: integer("lastServiceHours"),
  serviceInterval: integer("serviceInterval").default(250),
  maintenanceStatus: varchar("maintenanceStatus", { length: 20 }).default("ok"),
  notes: text("notes"),
  imageUrl: text("imageUrl"),
  fuelTankCapacityLitres: integer("fuelTankCapacityLitres"),
  equipmentModelId: integer("equipmentModelId").references(() => equipmentModels.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  statusIdx: index("rental_fleet_status_idx").on(table.currentStatus),
  locationIdx: index("rental_fleet_location_idx").on(table.locationId),
  equipmentModelIdx: index("rental_fleet_equipment_model_idx").on(table.equipmentModelId),
}));

export type RentalFleet = typeof rentalFleet.$inferSelect;

// ─── Rental Requests ───────────────────────────────────────────
export const rentalRequests = pgTable("rental_requests", {
  id: serial("id").primaryKey(),
  rentalNumber: varchar("rentalNumber", { length: 20 }).unique(),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  // Customer info (denormalized for form submissions)
  customerName: varchar("customerName", { length: 255 }).notNull(),
  customerEmail: varchar("customerEmail", { length: 255 }),
  customerPhone: varchar("customerPhone", { length: 50 }),
  customerCompany: varchar("customerCompany", { length: 255 }),
  // Equipment info
  equipmentDescription: text("equipmentDescription"),
  // Dates
  startDate: timestamp("startDate", { mode: "date" }).notNull(),
  endDate: timestamp("endDate", { mode: "date" }).notNull(),
  // Status
  status: rentalStatusEnum("status").default("pending").notNull(),
  // Nullable avoids a migration backfill. The lifecycle service treats NULL as
  // version 0 and writes version 1 on the next real transition.
  lifecycleVersion: integer("lifecycleVersion"),
  paymentStatus: paymentStatusEnum("paymentStatus").default("pending").notNull(),
  // Pricing
  totalAmount: numeric("totalAmount", { precision: 12, scale: 2 }),
  depositAmount: numeric("depositAmount", { precision: 12, scale: 2 }),
  // Stripe
  stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 255 }),
  stripeCheckoutSessionId: varchar("stripeCheckoutSessionId", { length: 255 }),
  // Delivery
  deliveryMethod: deliveryMethodEnum("deliveryMethod").default("pickup"),
  deliveryAddress: text("deliveryAddress"),
  deliveryNotes: text("deliveryNotes"),
  deliveryProvince: varchar("deliveryProvince", { length: 2 }),
  pickupProvince: varchar("pickupProvince", { length: 2 }),
  taxProvince: varchar("taxProvince", { length: 2 }),
  // Cost breakdown
  rentalFee: numeric("rentalFee", { precision: 12, scale: 2 }),
  freightCost: numeric("freightCost", { precision: 12, scale: 2 }),
  taxAmount: numeric("taxAmount", { precision: 12, scale: 2 }),
  taxBreakdown: text("taxBreakdown"),
  // Price match / manual override: when enabled, money fields are admin-entered
  // and NOT auto-recalculated from rate × days; captures why the price changed.
  priceMatchEnabled: boolean("priceMatchEnabled").default(false).notNull(),
  priceMatchCompetitor: varchar("priceMatchCompetitor", { length: 255 }),
  priceMatchAmount: numeric("priceMatchAmount", { precision: 12, scale: 2 }),
  priceMatchNote: text("priceMatchNote"),
  // When a price is overridden, the specific money components that diverge from
  // the system-computed price: { "<field>": { from: "<computed>", to: "<entered>" } }.
  // Lets the override badge say WHICH item changed (e.g. freight $335 → $285).
  priceMatchFields: jsonb("priceMatchFields").$type<Record<string, { from: string | null; to: string | null }>>(),
  // Customer-level discount % applied to this order's rental fee (recorded for
  // audit / invoice transparency; the fee already reflects it).
  customerDiscountPercent: numeric("customerDiscountPercent", { precision: 5, scale: 2 }),
  // One-way driving distance (km) warehouse → delivery address, captured at order
  // time from the freight calc. Enables delivery-distance reporting without dispatch.
  deliveryDistanceKm: numeric("deliveryDistanceKm", { precision: 10, scale: 2 }),
  // True when freight fell back to the lowest (≤30 km) bracket because the
  // driving distance could not be determined — staff should verify the real
  // distance before invoicing. Cleared once freight is recalculated/corrected.
  freightEstimated: boolean("freightEstimated").default(false).notNull(),
  // Insurance
  insuranceType: insuranceTypeEnum("insuranceType").default("none"),
  insuranceCost: numeric("insuranceCost", { precision: 12, scale: 2 }),
  insuranceDocsReceived: boolean("insuranceDocsReceived").default(false).notNull(),
  // Deposit
  depositPaid: boolean("depositPaid").default(false),
  // Contract
  contractUrl: text("contractUrl"),
  contractVersion: integer("contractVersion").default(1),
  contractSignedAt: timestamp("contractSignedAt", { mode: "date" }),
  contractGenerated: boolean("contractGenerated").default(false),
  contractGeneratedAt: timestamp("contractGeneratedAt", { mode: "date" }),
  // Order confirmation PDF
  orderConfirmationPdfUrl: text("orderConfirmationPdfUrl"),
  // Project
  projectDescription: text("projectDescription"),
  // Inspection tracking
  deliveryInspectionCompleted: boolean("deliveryInspectionCompleted").default(false).notNull(),
  returnInspectionCompleted: boolean("returnInspectionCompleted").default(false).notNull(),
  // FK to inspections.id — enforced at DB level via migration 030 (ON DELETE SET NULL).
  // Cannot use inline .references(() => inspections.id) due to circular table definition order.
  deliveryInspectionId: integer("deliveryInspectionId"),
  returnInspectionId: integer("returnInspectionId"),
  // Notes
  adminNotes: text("adminNotes"),
  customerNotes: text("customerNotes"),
  // Billing cycle & shift
  billingCycleType: varchar("billingCycleType", { length: 10 }).default("calendar"),
  shiftType: varchar("shiftType", { length: 10 }).default("single"),
  standardHoursPerDay: integer("standardHoursPerDay").default(8),
  overtimeHours: numeric("overtimeHours", { precision: 10, scale: 2 }).default("0"),
  overtimeCost: numeric("overtimeCost", { precision: 12, scale: 2 }).default("0"),
  shiftMultiplier: numeric("shiftMultiplier", { precision: 3, scale: 2 }).default("1.00"),
  // Fuel
  fuelPolicy: varchar("fuelPolicy", { length: 20 }).default("full_to_full"),
  fuelPricePerLitre: numeric("fuelPricePerLitre", { precision: 6, scale: 2 }),
  // Project & hire type
  projectId: integer("projectId").references(() => projects.id, { onDelete: "set null" }),
  equipmentModelId: integer("equipmentModelId").references(() => equipmentModels.id, { onDelete: "set null" }),
  hireType: varchar("hireType", { length: 10 }).default("dry"),
  contractTemplateId: integer("contractTemplateId").references(() => contractTemplates.id, { onDelete: "set null" }),
  // Scheduled times (HH:MM format)
  scheduledDeliveryTime: varchar("scheduledDeliveryTime", { length: 5 }),
  scheduledPickupTime: varchar("scheduledPickupTime", { length: 5 }),
  // Referral
  referralCodeId: integer("referralCodeId"),
  referralDiscount: numeric("referralDiscount", { precision: 12, scale: 2 }),
  // Renewal chain
  parentRentalId: integer("parentRentalId").references((): AnyPgColumn => rentalRequests.id, { onDelete: "set null" }),
  // Late fee tracking
  estimatedLateFee: numeric("estimatedLateFee", { precision: 12, scale: 2 }),
  lateFeeLastComputedAt: timestamp("lateFeeLastComputedAt", { mode: "date" }),
  // Signature evidence (migration 083)
  signatureIp: varchar("signatureIp", { length: 45 }),
  signatureUserAgent: text("signatureUserAgent"),
  signatureContractHash: varchar("signatureContractHash", { length: 64 }),
  // Customer signature image (migration 085) — populated by driver delivery confirm flow
  customerSignature: text("customerSignature"),
  // Company-rep signature (migration 088) — captured by admin "Sign as representative"
  repSignature: text("repSignature"),
  repSignedAt: timestamp("repSignedAt", { mode: "date" }),
  repSignedBy: integer("repSignedBy"),
  // Attachment-rental customer ack (migration 090) — migrates into rental_line_items in Stage C
  customerEquipmentNote: text("customerEquipmentNote"),
  compatibilityAcknowledgedAt: timestamp("compatibilityAcknowledgedAt", { mode: "date" }),
  // Credit (挂账) orders (migration 106) — open-ended, billed at swap/close time.
  // endDate stays NOT NULL; open period uses sentinel 2099-12-31 (see shared/creditOrders.ts).
  isCreditOrder: boolean("isCreditOrder").default(false).notNull(),
  creditFinalizedAt: timestamp("creditFinalizedAt", { mode: "date" }),
  creditFinalizedBy: integer("creditFinalizedBy").references(() => users.id, { onDelete: "set null" }),
  // Transportation Log finance-row match (migration 108).
  // financialOrderNumber = the external accounting-system order # (SOT#####/SOR#####),
  // manually entered; the export's 单号 prefers it over our auto rentalNumber.
  financialOrderNumber: varchar("financialOrderNumber", { length: 40 }),
  cardLast4: varchar("cardLast4", { length: 4 }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  statusIdx: index("rental_requests_status_idx").on(table.status),
  customerIdx: index("rental_requests_customer_idx").on(table.customerId),
  fleetIdx: index("rental_requests_fleet_idx").on(table.rentalFleetId),
  dateIdx: index("rental_requests_date_idx").on(table.startDate, table.endDate),
  projectIdx: index("rental_requests_project_idx").on(table.projectId),
  equipmentModelIdx: index("rental_requests_equipment_model_idx").on(table.equipmentModelId),
  referralIdx: index("rental_requests_referral_idx").on(table.referralCodeId),
  parentIdx: index("rental_requests_parent_idx").on(table.parentRentalId),
}));

export type RentalRequest = typeof rentalRequests.$inferSelect;

// ─── Rental Prepayments ────────────────────────────────────────
// migration 099 — ledger of advance payments received per rental.
// Lets staff balance refund/remaining at close-out without bolting more
// columns onto rental_requests.
export const rentalPrepayments = pgTable("rental_prepayments", {
  id: serial("id").primaryKey(),
  rentalRequestId: integer("rentalRequestId").notNull().references(() => rentalRequests.id, { onDelete: "restrict" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentMethod: varchar("paymentMethod", { length: 40 }),
  paymentDate: timestamp("paymentDate", { mode: "date" }).defaultNow().notNull(),
  // When a payment is recorded against a SPECIFIC invoice (an order can carry
  // several — credit monthly billing, renewal supplements), it's tagged here so
  // the ledger is allocated to the right invoice instead of every invoice. NULL =
  // a general order prepayment/deposit, distributed oldest-first. (migration 127)
  invoiceId: integer("invoiceId").references(() => invoices.id, { onDelete: "set null" }),
  notes: text("notes"),
  // 预付款转租金 (convert prepayment to rent). A prepayment is first only RECEIVED
  // (held); it does not settle the order's invoice until staff explicitly convert
  // it. appliedAt = when it was converted (NULL = held/未转). Only applied
  // prepayments count toward invoice settlement. Payments recorded directly on an
  // invoice ("录入收款") are applied immediately. (migration 132)
  appliedAt: timestamp("appliedAt", { mode: "date" }),
  appliedBy: integer("appliedBy").references(() => users.id, { onDelete: "set null" }),
  // Held deposit moved onto the customer's credit balance instead of being
  // converted to rent or refunded. Distinct from appliedAt on purpose: setting
  // appliedAt would make the row settle invoices, and on a fully-paid order the
  // money would come straight back out as an overpayment and be counted twice.
  // The row stays counted as collected and stays out of allocation. (migration 150)
  transferredToCreditAt: timestamp("transferredToCreditAt", { mode: "date" }),
  transferredToCreditBy: integer("transferredToCreditBy").references(() => users.id, { onDelete: "set null" }),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  rentalIdx: index("rental_prepayments_rental_idx").on(table.rentalRequestId),
  invoiceIdx: index("rental_prepayments_invoice_idx").on(table.invoiceId),
  deletedIdx: index("rental_prepayments_deleted_idx").on(table.deletedAt),
}));

export type RentalPrepayment = typeof rentalPrepayments.$inferSelect;

// ─── Rental Charges ────────────────────────────────────────────
// migration 106 — ledger for credit (挂账) orders. Carries both settlement
// modes: per-swap charges ('swap'), lump-sum final ('final'), manual
// ('adjustment'). invoiceId IS NULL means not yet billed. Deposit never enters
// this table (project billing rule). chargeType is a varchar constrained by zod
// (CHARGE_TYPES in shared/creditOrders.ts), not a pg enum.
export const rentalCharges = pgTable("rental_charges", {
  id: serial("id").primaryKey(),
  rentalRequestId: integer("rentalRequestId").notNull().references(() => rentalRequests.id, { onDelete: "restrict" }),
  chargeType: varchar("chargeType", { length: 20 }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).default("0").notNull(),
  description: text("description"),
  chargeDate: timestamp("chargeDate", { mode: "date" }).defaultNow().notNull(),
  oldRentalFleetId: integer("oldRentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  newRentalFleetId: integer("newRentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  invoiceId: integer("invoiceId").references(() => invoices.id, { onDelete: "set null" }),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  rentalIdx: index("rental_charges_rental_idx").on(table.rentalRequestId),
  invoiceIdx: index("rental_charges_invoice_idx").on(table.invoiceId),
  deletedIdx: index("rental_charges_deleted_idx").on(table.deletedAt),
}));

export type RentalCharge = typeof rentalCharges.$inferSelect;

// ─── Inspections ───────────────────────────────────────────────
export const inspections = pgTable("inspections", {
  id: serial("id").primaryKey(),
  type: inspectionTypeEnum("type").notNull(),
  rentalId: integer("rentalId").references(() => rentalRequests.id, { onDelete: "set null" }),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  equipmentSelected: text("equipmentSelected"),
  // Inspector
  inspectorName: varchar("inspectorName", { length: 255 }),
  inspectorId: integer("inspectorId").references(() => users.id, { onDelete: "set null" }),
  // Readings
  // numeric(10,1) (migration 108) — staff record decimal hour readings (e.g. 7.5, 164.9).
  engineHours: numeric("engineHours", { precision: 10, scale: 1 }),
  hourMeter: numeric("hourMeter", { precision: 10, scale: 1 }),
  fuelLevel: integer("fuelLevel"),
  fuelLevelPercent: integer("fuelLevelPercent"),
  fuelChargeAmount: numeric("fuelChargeAmount", { precision: 12, scale: 2 }),
  odometerReading: integer("odometerReading"),
  // Condition
  overallCondition: conditionEnum("overallCondition"),
  damageNotes: text("damageNotes"),
  damageSeverity: varchar("damageSeverity", { length: 20 }),
  // Location
  locationAddress: text("locationAddress"),
  latitude: numeric("latitude", { precision: 10, scale: 7 }),
  longitude: numeric("longitude", { precision: 10, scale: 7 }),
  // Photos
  photoFront: text("photoFront"),
  photoBack: text("photoBack"),
  photoLeft: text("photoLeft"),
  photoRight: text("photoRight"),
  photoAdditional: text("photoAdditional"),
  // Signature
  customerSignature: text("customerSignature"),
  customerSignedAt: timestamp("customerSignedAt", { mode: "date" }),
  // General
  notes: text("notes"),
  offlineId: text("offlineId"),
  syncedAt: timestamp("syncedAt", { mode: "date" }),
  pdfUrl: text("pdfUrl"),
  // Signature evidence (migration 083)
  signatureIp: varchar("signatureIp", { length: 45 }),
  signatureUserAgent: text("signatureUserAgent"),
  signatureDocumentHash: varchar("signatureDocumentHash", { length: 64 }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  rentalIdx: index("inspections_rental_idx").on(table.rentalId),
  fleetIdx: index("inspections_fleet_idx").on(table.rentalFleetId),
  typeIdx: index("inspections_type_idx").on(table.type),
}));

export type Inspection = typeof inspections.$inferSelect;

// ─── Inspection Tokens ─────────────────────────────────────────
export const inspectionTokens = pgTable("inspection_tokens", {
  id: serial("id").primaryKey(),
  tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
  rentalId: integer("rentalId").references(() => rentalRequests.id, { onDelete: "set null" }),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  inspectionType: inspectionTypeEnum("inspectionType").notNull(),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  isUsed: boolean("isUsed").default(false).notNull(),
  expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
});

// ─── Dispatch Orders ───────────────────────────────────────────
export const dispatchOrders = pgTable("dispatch_orders", {
  id: serial("id").primaryKey(),
  orderType: dispatchOrderTypeEnum("orderType").notNull(),
  rentalRequestId: integer("rentalRequestId").references(() => rentalRequests.id, { onDelete: "set null" }),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  assignedDriverId: integer("assignedDriverId").references(() => drivers.id, { onDelete: "set null" }),
  status: dispatchStatusEnum("status").default("pending").notNull(),
  scheduledDate: timestamp("scheduledDate", { mode: "date" }),
  completedDate: timestamp("completedDate", { mode: "date" }),
  // Structured addresses
  pickupAddress: text("pickupAddress"),
  pickupProvince: varchar("pickupProvince", { length: 100 }),
  deliveryAddress: text("deliveryAddress"),
  deliveryProvince: varchar("deliveryProvince", { length: 100 }),
  pickupWarehouseId: integer("pickupWarehouseId").references(() => warehouses.id, { onDelete: "set null" }),
  deliveryWarehouseId: integer("deliveryWarehouseId").references(() => warehouses.id, { onDelete: "set null" }),
  distance: numeric("distance", { precision: 10, scale: 2 }),
  scheduledTimeSlot: varchar("scheduledTimeSlot", { length: 50 }),
  priority: varchar("priority", { length: 20 }).default("normal"),
  // Pricing
  shippingCost: numeric("shippingCost", { precision: 10, scale: 2 }),
  // Driver/customer confirmation
  // Unguessable token for the public confirmation link (replaces the
  // enumerable integer id — see migration 104).
  confirmationToken: text("confirmationToken"),
  customerConfirmedAt: timestamp("customerConfirmedAt", { mode: "date" }),
  customerConfirmationSignature: text("customerConfirmationSignature"),
  driverConfirmedAt: timestamp("driverConfirmedAt", { mode: "date" }),
  // Notes
  notes: text("notes"),
  driverNotes: text("driverNotes"),
  pdfUrl: text("pdfUrl"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  statusIdx: index("dispatch_status_idx").on(table.status),
  driverIdx: index("dispatch_driver_idx").on(table.assignedDriverId),
  rentalIdx: index("dispatch_rental_idx").on(table.rentalRequestId),
  customerIdx: index("dispatch_customer_idx").on(table.customerId),
  fleetIdx: index("dispatch_fleet_idx").on(table.rentalFleetId),
  confirmationTokenIdx: uniqueIndex("dispatch_confirmation_token_idx").on(table.confirmationToken),
}));

// ─── Rental Asset Progress Events ─────────────────────────────
// Append-only operational evidence. Current progress is derived from the
// authoritative rental, inspection and dispatch rows rather than stored here.
export const rentalAssetProgressEvents = pgTable("rental_asset_progress_events", {
  id: serial("id").primaryKey(),
  eventKey: varchar("eventKey", { length: 255 }).notNull().unique(),
  rentalRequestId: integer("rentalRequestId").references(() => rentalRequests.id, { onDelete: "cascade" }),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "cascade" }),
  eventType: varchar("eventType", { length: 80 }).notNull(),
  fromStage: varchar("fromStage", { length: 40 }),
  toStage: varchar("toStage", { length: 40 }),
  source: varchar("source", { length: 30 }).notNull(),
  sourceEntityType: varchar("sourceEntityType", { length: 50 }),
  sourceEntityId: integer("sourceEntityId"),
  reason: text("reason"),
  actorUserId: integer("actorUserId").references(() => users.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  rentalFleetCreatedIdx: index("rental_asset_progress_rental_fleet_created_idx")
    .on(table.rentalRequestId, table.rentalFleetId, table.createdAt),
  fleetCreatedIdx: index("rental_asset_progress_fleet_created_idx")
    .on(table.rentalFleetId, table.createdAt),
}));

export type RentalAssetProgressEvent = typeof rentalAssetProgressEvents.$inferSelect;
export type InsertRentalAssetProgressEvent = typeof rentalAssetProgressEvents.$inferInsert;

// ─── Rolling Rental Terms ─────────────────────────────────────
// Commercial terms remain order-level. Physical collection is tracked per
// assigned unit below so multi-unit rentals cannot release early.
export const rentalRollingTerms = pgTable("rental_rolling_terms", {
  id: serial("id").primaryKey(),
  rentalRequestId: integer("rentalRequestId")
    .references(() => rentalRequests.id, { onDelete: "restrict" })
    .notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  cycleDays: integer("cycleDays").default(28).notNull(),
  confirmedAt: timestamp("confirmedAt", { mode: "date" }).notNull(),
  confirmedBy: integer("confirmedBy").references(() => users.id, { onDelete: "set null" }),
  billingStartedAt: timestamp("billingStartedAt", { mode: "date" }).notNull(),
  billedThroughDate: timestamp("billedThroughDate", { mode: "date" }).notNull(),
  nextSettlementDate: timestamp("nextSettlementDate", { mode: "date" }).notNull(),
  billingStopAt: timestamp("billingStopAt", { mode: "date" }),
  endedAt: timestamp("endedAt", { mode: "date" }),
  endedBy: integer("endedBy").references(() => users.id, { onDelete: "set null" }),
  endReason: text("endReason"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  rentalUnique: uniqueIndex("rental_rolling_terms_rental_unique").on(table.rentalRequestId),
  statusSettlementIdx: index("rental_rolling_terms_status_settlement_idx")
    .on(table.status, table.nextSettlementDate),
}));

export type RentalRollingTerm = typeof rentalRollingTerms.$inferSelect;
export type InsertRentalRollingTerm = typeof rentalRollingTerms.$inferInsert;

export const rentalAssetReturnOperations = pgTable("rental_asset_return_operations", {
  id: serial("id").primaryKey(),
  rentalRequestId: integer("rentalRequestId")
    .references(() => rentalRequests.id, { onDelete: "restrict" })
    .notNull(),
  rentalFleetId: integer("rentalFleetId")
    .references(() => rentalFleet.id, { onDelete: "restrict" })
    .notNull(),
  returnRequestedAt: timestamp("returnRequestedAt", { mode: "date" }).notNull(),
  customerReadyAt: timestamp("customerReadyAt", { mode: "date" }).notNull(),
  scheduledPickupAt: timestamp("scheduledPickupAt", { mode: "date" }),
  delayResponsibility: varchar("delayResponsibility", { length: 20 }).default("none").notNull(),
  billingStopAt: timestamp("billingStopAt", { mode: "date" }),
  pickedUpAt: timestamp("pickedUpAt", { mode: "date" }),
  readyRecordedBy: integer("readyRecordedBy").references(() => users.id, { onDelete: "set null" }),
  responsibilitySetBy: integer("responsibilitySetBy").references(() => users.id, { onDelete: "set null" }),
  pickedUpBy: integer("pickedUpBy").references(() => users.id, { onDelete: "set null" }),
  responsibilityReason: text("responsibilityReason"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  rentalFleetUnique: uniqueIndex("rental_asset_return_operations_rental_fleet_unique")
    .on(table.rentalRequestId, table.rentalFleetId),
  progressIdx: index("rental_asset_return_operations_progress_idx")
    .on(table.rentalRequestId, table.pickedUpAt, table.billingStopAt),
  fleetIdx: index("rental_asset_return_operations_fleet_idx")
    .on(table.rentalFleetId, table.pickedUpAt),
}));

export type RentalAssetReturnOperation = typeof rentalAssetReturnOperations.$inferSelect;
export type InsertRentalAssetReturnOperation = typeof rentalAssetReturnOperations.$inferInsert;

// Note: catalog_sync_log table was retired with the TerraX integration.
// The DB table itself is left in place (no FK dependencies, just orphan
// rows). A future migration can drop it once we're confident nothing
// reads it.

// ─── Site Settings ─────────────────────────────────────────────
export const siteSettings = pgTable("site_settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
});

// ─── Audit Logs ───────────────────────────────────────────────
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("userId").references(() => users.id, { onDelete: "set null" }),
  action: varchar("action", { length: 50 }).notNull(), // "create", "update", "delete", "status_change"
  entityType: varchar("entityType", { length: 50 }).notNull(), // "rental", "dispatch", "fleet", "customer", "user", "warehouse", "settings"
  entityId: integer("entityId"),
  changes: text("changes"), // JSON string of { field: { old, new } }
  metadata: text("metadata"), // JSON string for extra context
  ipAddress: varchar("ipAddress", { length: 45 }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  entityIdx: index("audit_logs_entity_idx").on(table.entityType, table.entityId),
  userIdx: index("audit_logs_user_idx").on(table.userId),
  createdAtIdx: index("audit_logs_created_at_idx").on(table.createdAt),
}));

// ─── Notification Settings ─────────────────────────────────────
export const notificationSettings = pgTable("notification_settings", {
  id: serial("id").primaryKey(),
  provider: varchar("provider", { length: 50 }).notNull(),
  configKey: varchar("configKey", { length: 100 }).notNull(),
  configValue: text("configValue").notNull(),
  isActive: boolean("isActive").default(true),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
});

// ─── Notification Templates ─────────────────────────────────
export const notificationTemplates = pgTable("notification_templates", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  channel: varchar("channel", { length: 20 }).notNull(),
  event: varchar("event", { length: 100 }).notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
});

// ─── Notification Log ─────────────────────────────────────────
/**
 * Reminders that were confirmed delivered. Written ONLY after the provider
 * accepted the message — a disabled channel or a failed send must leave no
 * row, because the absence of a row is what makes the reminder eligible again.
 */
export const reminderDeliveries = pgTable("reminder_deliveries", {
  id: serial("id").primaryKey(),
  entityType: varchar("entityType", { length: 30 }).notNull(),
  entityId: integer("entityId").notNull(),
  kind: varchar("kind", { length: 60 }).notNull(),
  channel: varchar("channel", { length: 20 }).notNull(),
  recipient: varchar("recipient", { length: 255 }),
  deliveredAt: timestamp("deliveredAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  uniqueDelivery: uniqueIndex("reminder_deliveries_unique").on(table.entityType, table.entityId, table.kind),
}));

export const notificationLog = pgTable("notification_log", {
  id: serial("id").primaryKey(),
  channel: varchar("channel", { length: 20 }).notNull(),
  recipient: varchar("recipient", { length: 255 }).notNull(),
  subject: text("subject"),
  event: varchar("event", { length: 100 }),
  status: varchar("status", { length: 20 }).notNull(),
  errorMessage: text("errorMessage"),
  relatedEntityType: varchar("relatedEntityType", { length: 50 }),
  relatedEntityId: integer("relatedEntityId"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  channelIdx: index("notification_log_channel_idx").on(table.channel),
  createdAtIdx: index("notification_log_created_at_idx").on(table.createdAt),
}));

// ─── Contact Inquiries ────────────────────────────────────────
// Public "Contact Us / quote request" form submissions from the standalone
// brand site. Unauthenticated insert (publicProcedure); staff triage via status.
export const contactInquiries = pgTable("contact_inquiries", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  company: varchar("company", { length: 255 }),
  equipmentInterest: varchar("equipmentInterest", { length: 255 }),
  message: text("message").notNull(),
  status: varchar("status", { length: 20 }).default("new").notNull(),
  source: varchar("source", { length: 50 }).default("website").notNull(),
  ipAddress: varchar("ipAddress", { length: 64 }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  statusIdx: index("contact_inquiries_status_idx").on(table.status),
  createdAtIdx: index("contact_inquiries_created_at_idx").on(table.createdAt),
}));

// ─── Sessions ─────────────────────────────────────────────────
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  sessionType: varchar("sessionType", { length: 20 }).notNull(), // "admin" | "field"
  userId: integer("userId").references(() => users.id, { onDelete: "cascade" }).notNull(),
  email: varchar("email", { length: 255 }),
  role: varchar("role", { length: 20 }),
  expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  tokenIdx: index("sessions_token_idx").on(table.token),
  expiresIdx: index("sessions_expires_idx").on(table.expiresAt),
}));

// ─── Login Sessions ───────────────────────────────────────────
export const loginSessions = pgTable("login_sessions", {
  id: serial("id").primaryKey(),
  // restrict so audit-trail records can't be silently wiped by a hard user delete
  userId: integer("userId").references(() => users.id, { onDelete: "restrict" }).notNull(),
  sessionToken: varchar("sessionToken", { length: 64 }),
  loginAt: timestamp("loginAt", { mode: "date" }).defaultNow().notNull(),
  logoutAt: timestamp("logoutAt", { mode: "date" }),
  lastActiveAt: timestamp("lastActiveAt", { mode: "date" }).defaultNow().notNull(),
  durationSeconds: integer("durationSeconds"),
  ipAddress: varchar("ipAddress", { length: 45 }),
  userAgent: text("userAgent"),
  browser: varchar("browser", { length: 100 }),
  os: varchar("os", { length: 100 }),
  deviceType: varchar("deviceType", { length: 20 }),
}, (table) => ({
  userIdx: index("login_sessions_user_idx").on(table.userId),
  loginAtIdx: index("login_sessions_login_at_idx").on(table.loginAt),
  sessionTokenIdx: index("login_sessions_session_token_idx").on(table.sessionToken),
}));

export type LoginSession = typeof loginSessions.$inferSelect;
export type InsertLoginSession = typeof loginSessions.$inferInsert;

// ─── OTP Codes ────────────────────────────────────────────────
export const otpCodes = pgTable("otp_codes", {
  id: serial("id").primaryKey(),
  phone: varchar("phone", { length: 20 }).notNull(),
  codeHash: varchar("codeHash", { length: 64 }).notNull(),
  expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  used: boolean("used").default(false).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  phoneIdx: index("otp_codes_phone_idx").on(table.phone),
  expiresIdx: index("otp_codes_expires_idx").on(table.expiresAt),
}));

export type OtpCode = typeof otpCodes.$inferSelect;
export type InsertOtpCode = typeof otpCodes.$inferInsert;

// ─── Customer Sessions ────────────────────────────────────────
export const customerSessions = pgTable("customer_sessions", {
  id: serial("id").primaryKey(),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "cascade" }).notNull(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expiresAt", { mode: "date" }).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  tokenIdx: index("customer_sessions_token_idx").on(table.token),
  customerIdx: index("customer_sessions_customer_idx").on(table.customerId),
}));

export type CustomerSession = typeof customerSessions.$inferSelect;
export type InsertCustomerSession = typeof customerSessions.$inferInsert;

// ─── Extension Requests ───────────────────────────────────────
export const extensionRequests = pgTable("extension_requests", {
  id: serial("id").primaryKey(),
  rentalRequestId: integer("rentalRequestId").references(() => rentalRequests.id, { onDelete: "set null" }),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  requestedEndDate: timestamp("requestedEndDate", { mode: "date" }).notNull(),
  reason: text("reason"),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  adminNotes: text("adminNotes"),
  reviewedBy: integer("reviewedBy").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewedAt", { mode: "date" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow(),
}, (table) => ({
  rentalIdx: index("ext_req_rental_idx").on(table.rentalRequestId),
  customerIdx: index("ext_req_customer_idx").on(table.customerId),
  statusIdx: index("ext_req_status_idx").on(table.status),
}));

export type ExtensionRequest = typeof extensionRequests.$inferSelect;
export type InsertExtensionRequest = typeof extensionRequests.$inferInsert;

// ─── Contract Templates ────────────────────────────────────────
export const contractTemplates = pgTable("contract_templates", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  content: text("content").notNull(),
  isDefault: boolean("isDefault").default(false).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
});

export type ContractTemplate = typeof contractTemplates.$inferSelect;
export type InsertContractTemplate = typeof contractTemplates.$inferInsert;

// ─── Rental Settings ───────────────────────────────────────────
export const rentalSettings = pgTable("rental_settings", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value").notNull(),
  description: text("description"),
  category: settingCategoryEnum("category"),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
});

// ─── Quotations ──────────────────────────────────────────────
export const quotationStatusEnum = pgEnum("quotationStatus", [
  "draft", "sent", "accepted", "rejected", "expired", "cancelled",
]);

export const quotations = pgTable("quotations", {
  id: serial("id").primaryKey(),
  quotationNumber: varchar("quotationNumber", { length: 50 }).notNull().unique(),
  rentalId: integer("rentalId").references(() => rentalRequests.id, { onDelete: "set null" }),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  projectId: integer("projectId").references(() => projects.id, { onDelete: "set null" }),
  status: quotationStatusEnum("status").default("draft").notNull(),
  // Amounts
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).default("0").notNull(),
  taxAmount: numeric("taxAmount", { precision: 12, scale: 2 }).default("0").notNull(),
  taxBreakdown: text("taxBreakdown"),
  totalAmount: numeric("totalAmount", { precision: 12, scale: 2 }).default("0").notNull(),
  // Tax compliance
  gstHstNumber: varchar("gstHstNumber", { length: 20 }),
  taxProvince: varchar("taxProvince", { length: 2 }),
  // Dates
  issueDate: timestamp("issueDate", { mode: "date" }).defaultNow(),
  validUntil: timestamp("validUntil", { mode: "date" }),
  // PDF
  pdfUrl: text("pdfUrl"),
  // Notes
  notes: text("notes"),
  internalNotes: text("internalNotes"),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  rentalIdx: index("quotations_rental_idx").on(table.rentalId),
  customerIdx: index("quotations_customer_idx").on(table.customerId),
  statusIdx: index("quotations_status_idx").on(table.status),
  numberIdx: index("quotations_number_idx").on(table.quotationNumber),
  projectIdx: index("quotations_project_idx").on(table.projectId),
}));

export type Quotation = typeof quotations.$inferSelect;

export const quotationLineItems = pgTable("quotation_line_items", {
  id: serial("id").primaryKey(),
  quotationId: integer("quotationId").references(() => quotations.id, { onDelete: "restrict" }),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).default("1").notNull(),
  unitPrice: numeric("unitPrice", { precision: 12, scale: 2 }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  lineType: varchar("lineType", { length: 50 }),
  sortOrder: integer("sortOrder").default(0),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  quotationIdx: index("quotation_line_items_quotation_idx").on(table.quotationId),
}));

export type QuotationLineItem = typeof quotationLineItems.$inferSelect;

// ─── Invoice Enums ────────────────────────────────────────────
export const invoiceStatusEnum = pgEnum("invoiceStatus", [
  "draft", "sent", "paid", "partial", "overdue", "cancelled", "credited",
]);
export const invoiceTypeEnum = pgEnum("invoiceType", [
  "rental", "fuel_surcharge", "damage", "delivery", "credit_note", "manual",
]);
export const paymentMethodEnum = pgEnum("paymentMethod", [
  "cash", "cheque", "e_transfer", "credit_card", "bank_transfer", "other",
]);

// ─── Invoices ─────────────────────────────────────────────────
export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: varchar("invoiceNumber", { length: 50 }).notNull().unique(),
  // Deterministic idempotency key for newly generated invoices. Historical
  // invoices remain NULL; PostgreSQL permits multiple NULLs in a unique index.
  sourceKey: varchar("sourceKey", { length: 160 }),
  rentalId: integer("rentalId").references(() => rentalRequests.id, { onDelete: "set null" }),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  projectId: integer("projectId").references(() => projects.id, { onDelete: "set null" }),
  type: invoiceTypeEnum("type").default("rental").notNull(),
  status: invoiceStatusEnum("status").default("draft").notNull(),
  // Amounts
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).default("0").notNull(),
  taxAmount: numeric("taxAmount", { precision: 12, scale: 2 }).default("0").notNull(),
  taxBreakdown: text("taxBreakdown"),
  totalAmount: numeric("totalAmount", { precision: 12, scale: 2 }).default("0").notNull(),
  amountPaid: numeric("amountPaid", { precision: 12, scale: 2 }).default("0").notNull(),
  balanceDue: numeric("balanceDue", { precision: 12, scale: 2 }).default("0").notNull(),
  // Tax compliance
  gstHstNumber: varchar("gstHstNumber", { length: 20 }),
  taxProvince: varchar("taxProvince", { length: 2 }),
  // Dates
  issueDate: timestamp("issueDate", { mode: "date" }).defaultNow(),
  dueDate: timestamp("dueDate", { mode: "date" }),
  paidDate: timestamp("paidDate", { mode: "date" }),
  // Delivery fact, not bookkeeping state: set only after the email provider
  // accepted the invoice PDF. NULL = never emailed, whatever `status` says.
  emailSentAt: timestamp("emailSentAt", { mode: "date" }),
  // PDF
  pdfUrl: text("pdfUrl"),
  // Notes
  notes: text("notes"),
  internalNotes: text("internalNotes"),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  rentalIdx: index("invoices_rental_idx").on(table.rentalId),
  customerIdx: index("invoices_customer_idx").on(table.customerId),
  statusIdx: index("invoices_status_idx").on(table.status),
  numberIdx: index("invoices_number_idx").on(table.invoiceNumber),
  typeIdx: index("invoices_type_idx").on(table.type),
  projectIdx: index("invoices_project_idx").on(table.projectId),
  dueDateIdx: index("invoices_due_date_idx").on(table.dueDate),
  sourceKeyUnique: uniqueIndex("invoices_source_key_unique").on(table.sourceKey),
}));

export type Invoice = typeof invoices.$inferSelect;

// ─── Invoice Line Items ──────────────────────────────────────
export const invoiceLineItems = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoiceId").references(() => invoices.id, { onDelete: "restrict" }),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).default("1").notNull(),
  unitPrice: numeric("unitPrice", { precision: 12, scale: 2 }).notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  lineType: varchar("lineType", { length: 50 }),
  sortOrder: integer("sortOrder").default(0),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  invoiceIdx: index("invoice_line_items_invoice_idx").on(table.invoiceId),
}));

export type InvoiceLineItem = typeof invoiceLineItems.$inferSelect;

// ─── Customer credit ledger (客户余额账) ──────────────────────
//
// Money that belongs to the customer but is not settling an invoice: an
// overpayment, a deposit held past its rental, a refund owed. Before this
// existed, allocatePrepayments handed any leftover to the newest invoice — which
// is why 35 production invoices show amountPaid above their own total.
//
// A LEDGER, not a balance column. Entries sum to the balance. A stored balance
// is the exact failure mode this codebase kept producing: one write path forgets
// it and it drifts with no way to reconstruct the truth. A ledger also answers
// "where did this $700 come from", which a number cannot.
//
// Sign: positive = onto the customer's account (overpayment, deposit moved in);
// negative = off it (applied to an order, refunded out).
export const customerCreditEntries = pgTable("customer_credit_entries", {
  id: serial("id").primaryKey(),
  customerId: integer("customerId").notNull().references(() => customers.id, { onDelete: "restrict" }),
  // Both nullable — a manual adjustment originates from neither.
  rentalRequestId: integer("rentalRequestId").references(() => rentalRequests.id, { onDelete: "set null" }),
  invoiceId: integer("invoiceId").references(() => invoices.id, { onDelete: "set null" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  entryType: varchar("entryType", { length: 40 }).notNull(),
  // Idempotency key for entries that are RECOMPUTED rather than events. An
  // order's overpayment is recalculated every time its invoices or payments
  // change, so it maps to one row that gets updated; inserting each time would
  // compound the balance on every recalculation. Event-style entries (a refund,
  // a manual adjustment) leave this NULL and add a row, as an audit trail should.
  sourceKey: varchar("sourceKey", { length: 120 }),
  notes: text("notes"),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  sourceKeyUnique: uniqueIndex("customer_credit_entries_source_key_unique")
    .on(table.sourceKey)
    .where(sql`"sourceKey" IS NOT NULL`),
  customerIdx: index("customer_credit_entries_customer_idx").on(table.customerId),
  rentalIdx: index("customer_credit_entries_rental_idx").on(table.rentalRequestId),
}));

export type CustomerCreditEntry = typeof customerCreditEntries.$inferSelect;

// ─── Payments ─────────────────────────────────────────────────
//
// ⚠️ THIS IS NOT THE MONEY LEDGER. Read this before using it for anything.
//
// There are two payment tables and they are NOT interchangeable:
//
//   rental_prepayments  ← where essentially all money lives. Keyed on the
//                         ORDER, which is what 租赁管理 shows and what the
//                         office actually uses. Deposits sit here in a 待转
//                         state until converted to rent (appliedAt), and
//                         invoices derive amountPaid/balanceDue from it.
//
//   payments (this one) ← ONLY for a standalone invoice, i.e. one with no
//                         rentalId. There are currently zero such invoices in
//                         production, so this table is empty — empty because
//                         the branch has never been exercised, NOT because it
//                         is dead. Deleting it would break invoicing anything
//                         that is not a rental (parts sales, service fees).
//
// The split is decided in one place, invoices.recordPayment: an invoice with a
// rentalId records against the order's prepayment ledger so the payment shows
// up in BOTH views; only an order-less invoice falls through to here.
//
// So: for revenue, collections, payment-method breakdowns or "what has this
// customer paid" — query rental_prepayments. A report built on this table would
// truthfully return zero and look like the business collected nothing.
export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoiceId").references(() => invoices.id, { onDelete: "restrict" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  paymentMethod: paymentMethodEnum("paymentMethod").notNull(),
  paymentDate: timestamp("paymentDate", { mode: "date" }).notNull(),
  reference: varchar("reference", { length: 255 }),
  stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 255 }),
  notes: text("notes"),
  recordedBy: integer("recordedBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  invoiceIdx: index("payments_invoice_idx").on(table.invoiceId),
  dateIdx: index("payments_date_idx").on(table.paymentDate),
}));

export type Payment = typeof payments.$inferSelect;

// ─── Customer Pricing ─────────────────────────────────────────
export const customerPricing = pgTable("customer_pricing", {
  id: serial("id").primaryKey(),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "cascade" }).notNull(),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  category: varchar("category", { length: 100 }),
  dailyRate: numeric("dailyRate", { precision: 10, scale: 2 }),
  weeklyRate: numeric("weeklyRate", { precision: 10, scale: 2 }),
  monthlyRate: numeric("monthlyRate", { precision: 10, scale: 2 }),
  twentyEightDayRate: numeric("twentyEightDayRate", { precision: 10, scale: 2 }),
  discountPercent: numeric("discountPercent", { precision: 5, scale: 2 }),
  validFrom: timestamp("validFrom", { mode: "date" }).notNull(),
  validTo: timestamp("validTo", { mode: "date" }),
  isActive: boolean("isActive").default(true).notNull(),
  notes: text("notes"),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  customerIdx: index("customer_pricing_customer_idx").on(table.customerId),
  fleetIdx: index("customer_pricing_fleet_idx").on(table.rentalFleetId),
  categoryIdx: index("customer_pricing_category_idx").on(table.category),
}));

export type CustomerPricing = typeof customerPricing.$inferSelect;

// ─── Downtime Records ─────────────────────────────────────────
export const downtimeRecords = pgTable("downtime_records", {
  id: serial("id").primaryKey(),
  rentalId: integer("rentalId").references(() => rentalRequests.id, { onDelete: "set null" }),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  reportedAt: timestamp("reportedAt", { mode: "date" }).notNull(),
  resolvedAt: timestamp("resolvedAt", { mode: "date" }),
  totalCalendarDays: integer("totalCalendarDays").default(0),
  excludedDays: integer("excludedDays").default(0),
  workingDaysLost: integer("workingDaysLost").default(0),
  dailyRateAtTime: numeric("dailyRateAtTime", { precision: 10, scale: 2 }),
  creditAmount: numeric("creditAmount", { precision: 10, scale: 2 }).default("0"),
  status: varchar("status", { length: 20 }).default("open").notNull(),
  reason: text("reason"),
  resolution: text("resolution"),
  creditInvoiceId: integer("creditInvoiceId").references(() => invoices.id, { onDelete: "set null" }),
  reportedBy: integer("reportedBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  rentalIdx: index("downtime_records_rental_idx").on(table.rentalId),
  statusIdx: index("downtime_records_status_idx").on(table.status),
  fleetIdx: index("downtime_records_fleet_idx").on(table.rentalFleetId),
}));

export type DowntimeRecord = typeof downtimeRecords.$inferSelect;

// ─── Projects ─────────────────────────────────────────────────
export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  name: varchar("name", { length: 255 }).notNull(),
  poNumber: varchar("poNumber", { length: 100 }),
  siteAddress: text("siteAddress"),
  city: varchar("city", { length: 100 }),
  province: varchar("province", { length: 2 }),
  postalCode: varchar("postalCode", { length: 10 }),
  contactName: varchar("contactName", { length: 255 }),
  contactPhone: varchar("contactPhone", { length: 50 }),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  startDate: timestamp("startDate", { mode: "date" }),
  endDate: timestamp("endDate", { mode: "date" }),
  notes: text("notes"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  customerIdx: index("projects_customer_idx").on(table.customerId),
  statusIdx: index("projects_status_idx").on(table.status),
}));

export type Project = typeof projects.$inferSelect;

// ─── Work Orders ──────────────────────────────────────────────
export const workOrderStatusEnum = pgEnum("workOrderStatus", [
  "open", "assigned", "in_progress", "on_hold", "completed", "cancelled",
]);
export const workOrderTypeEnum = pgEnum("workOrderType", [
  "pm1_250h", "pm2_500h", "pm3_1000h", "pm4_2000h", "repair", "inspection", "other",
]);
export const workOrderPriorityEnum = pgEnum("workOrderPriority", [
  "low", "normal", "high", "urgent",
]);

export const workOrders = pgTable("work_orders", {
  id: serial("id").primaryKey(),
  workOrderNumber: varchar("workOrderNumber", { length: 50 }).notNull().unique(),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  damageClaimId: integer("damageClaimId").references(() => damageClaims.id, { onDelete: "set null" }),
  type: workOrderTypeEnum("type").default("other").notNull(),
  priority: workOrderPriorityEnum("priority").default("normal").notNull(),
  status: workOrderStatusEnum("status").default("open").notNull(),
  assignedTo: integer("assignedTo").references(() => users.id, { onDelete: "set null" }),
  estimatedHours: numeric("estimatedHours", { precision: 6, scale: 2 }),
  actualHours: numeric("actualHours", { precision: 6, scale: 2 }),
  laborRate: numeric("laborRate", { precision: 10, scale: 2 }),
  laborCost: numeric("laborCost", { precision: 10, scale: 2 }).default("0"),
  partsCost: numeric("partsCost", { precision: 10, scale: 2 }).default("0"),
  totalCost: numeric("totalCost", { precision: 10, scale: 2 }).default("0"),
  triggerEngineHours: integer("triggerEngineHours"),
  // External-customer service info (paper work order form); own-fleet WOs
  // leave these empty and identify the unit via rentalFleet.serialNumber.
  customerName: varchar("customerName", { length: 255 }),
  customerPhone: varchar("customerPhone", { length: 50 }),
  equipmentSource: varchar("equipmentSource", { length: 20 }), // own_fleet | equipment | other
  equipmentSourceNote: varchar("equipmentSourceNote", { length: 255 }),
  plateNumber: varchar("plateNumber", { length: 50 }),
  // Intake meter readings on the service day (not the PM trigger reading)
  meterKms: integer("meterKms"),
  meterHours: numeric("meterHours", { precision: 10, scale: 1 }),
  scheduledDate: timestamp("scheduledDate", { mode: "date" }),
  startedAt: timestamp("startedAt", { mode: "date" }),
  completedAt: timestamp("completedAt", { mode: "date" }),
  description: text("description"),
  findings: text("findings"),
  resolution: text("resolution"),
  notes: text("notes"),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  fleetIdx: index("work_orders_fleet_idx").on(table.rentalFleetId),
  statusIdx: index("work_orders_status_idx").on(table.status),
  assignedIdx: index("work_orders_assigned_idx").on(table.assignedTo),
}));

export type WorkOrder = typeof workOrders.$inferSelect;

export const workOrderParts = pgTable("work_order_parts", {
  id: serial("id").primaryKey(),
  workOrderId: integer("workOrderId").references(() => workOrders.id, { onDelete: "restrict" }),
  partName: varchar("partName", { length: 255 }).notNull(),
  partNumber: varchar("partNumber", { length: 100 }),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).default("1").notNull(),
  unitCost: numeric("unitCost", { precision: 10, scale: 2 }).notNull(),
  totalCost: numeric("totalCost", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  woIdx: index("work_order_parts_wo_idx").on(table.workOrderId),
}));

export type WorkOrderPart = typeof workOrderParts.$inferSelect;

export const workOrderLabor = pgTable("work_order_labor", {
  id: serial("id").primaryKey(),
  workOrderId: integer("workOrderId").notNull().references(() => workOrders.id, { onDelete: "cascade" }),
  technicianName: varchar("technicianName", { length: 120 }).notNull(),
  userId: integer("userId").references(() => users.id, { onDelete: "set null" }),
  workDetail: text("workDetail"),
  startAt: timestamp("startAt", { mode: "date" }).notNull(),
  endAt: timestamp("endAt", { mode: "date" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  woIdx: index("work_order_labor_wo_idx").on(table.workOrderId),
}));

export type WorkOrderLabor = typeof workOrderLabor.$inferSelect;

// ─── Operators (equipment operators) ─────────────────────────
export const operators = pgTable("operators", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  userId: integer("userId").references(() => users.id, { onDelete: "set null" }),
  certifications: jsonb("certifications").$type<Array<{ type: string; number: string; issuedAt?: string; expiresAt?: string }>>().default([]),
  dailyRate: numeric("dailyRate", { precision: 10, scale: 2 }),
  isActive: boolean("isActive").default(true).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  activeIdx: index("operators_active_idx").on(table.isActive),
  userIdx: index("operators_user_idx").on(table.userId),
}));

export type Operator = typeof operators.$inferSelect;

// ─── Drivers (delivery/transport drivers) ────────────────────
export const drivers = pgTable("drivers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  userId: integer("userId").references(() => users.id, { onDelete: "set null" }),
  licenseNumber: varchar("licenseNumber", { length: 100 }),
  licenseExpiry: timestamp("licenseExpiry", { mode: "date" }),
  vehicleInfo: text("vehicleInfo"),
  isActive: boolean("isActive").default(true).notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  activeIdx: index("drivers_active_idx").on(table.isActive),
  userIdx: index("drivers_user_idx").on(table.userId),
}));

export type Driver = typeof drivers.$inferSelect;

// ─── Damage Claims ────────────────────────────────────────────
export const damageClaims = pgTable("damage_claims", {
  id: serial("id").primaryKey(),
  inspectionId: integer("inspectionId").references(() => inspections.id, { onDelete: "set null" }),
  rentalId: integer("rentalId").references(() => rentalRequests.id, { onDelete: "set null" }),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  // Extra-charge reason: damage | fuel | cleaning | overtime | transport | other.
  chargeType: varchar("chargeType", { length: 20 }).default("damage").notNull(),
  repairEstimate: numeric("repairEstimate", { precision: 10, scale: 2 }),
  approvedAmount: numeric("approvedAmount", { precision: 10, scale: 2 }),
  // Direct amount for simple (non-damage) charges; damage uses repairEstimate→approvedAmount.
  amount: numeric("amount", { precision: 12, scale: 2 }),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  invoiceId: integer("invoiceId").references(() => invoices.id, { onDelete: "set null" }),
  customerResponse: text("customerResponse"),
  resolvedAt: timestamp("resolvedAt", { mode: "date" }),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  rentalIdx: index("damage_claims_rental_idx").on(table.rentalId),
  statusIdx: index("damage_claims_status_idx").on(table.status),
  customerIdx: index("damage_claims_customer_idx").on(table.customerId),
}));

export type DamageClaim = typeof damageClaims.$inferSelect;

// ─── Fleet Certificates ──────────────────────────────────────
export const fleetCertificates = pgTable("fleet_certificates", {
  id: serial("id").primaryKey(),
  rentalFleetId: integer("rentalFleetId").references(() => rentalFleet.id, { onDelete: "set null" }),
  certType: varchar("certType", { length: 50 }).notNull(),
  certNumber: varchar("certNumber", { length: 100 }),
  issueDate: timestamp("issueDate", { mode: "date" }),
  expiryDate: timestamp("expiryDate", { mode: "date" }),
  documentUrl: text("documentUrl"),
  reminderDays: integer("reminderDays").default(30),
  status: varchar("status", { length: 20 }).default("valid").notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  fleetIdx: index("fleet_certificates_fleet_idx").on(table.rentalFleetId),
  expiryIdx: index("fleet_certificates_expiry_idx").on(table.expiryDate),
}));

export type FleetCertificate = typeof fleetCertificates.$inferSelect;

// ─── Deposit Rules ────────────────────────────────────────────
export const depositRules = pgTable("deposit_rules", {
  id: serial("id").primaryKey(),
  category: varchar("category", { length: 255 }).notNull(),
  depositType: varchar("depositType", { length: 20 }).notNull().default("percentage"),
  value: numeric("value", { precision: 10, scale: 4 }).notNull(),
  minDeposit: numeric("minDeposit", { precision: 12, scale: 2 }).notNull().default("500"),
  maxDeposit: numeric("maxDeposit", { precision: 12, scale: 2 }),
  priority: integer("priority").notNull().default(100),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  categoryIdx: index("deposit_rules_category_idx").on(table.category),
}));

export type DepositRule = typeof depositRules.$inferSelect;

// ─── User Permissions ─────────────────────────────────────────
export const userPermissions = pgTable("user_permissions", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  canManageUsers: boolean("canManageUsers").default(false).notNull(),
  canManageRentals: boolean("canManageRentals").default(true).notNull(),
  canManageInvoices: boolean("canManageInvoices").default(true).notNull(),
  canEditPricing: boolean("canEditPricing").default(false).notNull(),
  canManageCustomers: boolean("canManageCustomers").default(true).notNull(),
  canManageFleet: boolean("canManageFleet").default(true).notNull(),
  canViewReports: boolean("canViewReports").default(true).notNull(),
  canManageSettings: boolean("canManageSettings").default(false).notNull(),
  canExportData: boolean("canExportData").default(false).notNull(),
  canDeleteRecords: boolean("canDeleteRecords").default(false).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
});

export type UserPermission = typeof userPermissions.$inferSelect;

// ─── Role Permissions (CRUD matrix) ──────────────────────────
export const rolePermissions = pgTable("role_permissions", {
  id: serial("id").primaryKey(),
  role: unifiedRoleEnum("role").notNull(),
  module: varchar("module", { length: 50 }).notNull(),
  canCreate: boolean("canCreate").default(false).notNull(),
  canRead: boolean("canRead").default(false).notNull(),
  canUpdate: boolean("canUpdate").default(false).notNull(),
  canDelete: boolean("canDelete").default(false).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  roleModuleUnique: uniqueIndex("role_permissions_role_module_idx").on(table.role, table.module),
}));

export type RolePermission = typeof rolePermissions.$inferSelect;

// ─── User Permission Overrides (NULL = inherit from role) ────
export const userPermissionOverrides = pgTable("user_permission_overrides", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  module: varchar("module", { length: 50 }).notNull(),
  canCreate: boolean("canCreate"),
  canRead: boolean("canRead"),
  canUpdate: boolean("canUpdate"),
  canDelete: boolean("canDelete"),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  userModuleUnique: uniqueIndex("user_perm_overrides_user_module_idx").on(table.userId, table.module),
}));

export type UserPermissionOverride = typeof userPermissionOverrides.$inferSelect;

// ─── Promotions ─────────────────────────────────────────────
export const promotions = pgTable("promotions", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull().default("driver_referral"),
  discountPercent: numeric("discountPercent", { precision: 5, scale: 2 }).notNull().default("5.00"),
  commissionPercent: numeric("commissionPercent", { precision: 5, scale: 2 }).notNull().default("5.00"),
  commissionBase: varchar("commissionBase", { length: 50 }).notNull().default("rental_fee"),
  startDate: timestamp("startDate", { mode: "date" }).notNull(),
  endDate: timestamp("endDate", { mode: "date" }).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  maxUsesPerCode: integer("maxUsesPerCode"),
  description: text("description"),
  createdBy: integer("createdBy").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
  deletedAt: timestamp("deletedAt", { mode: "date" }),
}, (table) => ({
  typeIdx: index("promotions_type_idx").on(table.type),
  activeIdx: index("promotions_active_idx").on(table.isActive),
  datesIdx: index("promotions_dates_idx").on(table.startDate, table.endDate),
}));

export type Promotion = typeof promotions.$inferSelect;

// ─── Referral Codes ─────────────────────────────────────────
export const referralCodes = pgTable("referral_codes", {
  id: serial("id").primaryKey(),
  // restrict so commission/ledger history is preserved — admins must explicitly
  // clean up referral codes before hard-deleting a promotion or driver
  promotionId: integer("promotionId").references(() => promotions.id, { onDelete: "restrict" }).notNull(),
  driverId: integer("driverId").references(() => drivers.id, { onDelete: "restrict" }).notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  totalUses: integer("totalUses").default(0).notNull(),
  totalCommission: numeric("totalCommission", { precision: 12, scale: 2 }).default("0").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  promotionIdx: index("referral_codes_promotion_idx").on(table.promotionId),
  driverIdx: index("referral_codes_driver_idx").on(table.driverId),
}));

export type ReferralCode = typeof referralCodes.$inferSelect;

// ─── Referral Ledger ────────────────────────────────────────
export const referralLedger = pgTable("referral_ledger", {
  id: serial("id").primaryKey(),
  referralCodeId: integer("referralCodeId").references(() => referralCodes.id, { onDelete: "cascade" }).notNull(),
  rentalRequestId: integer("rentalRequestId").references(() => rentalRequests.id, { onDelete: "set null" }),
  customerId: integer("customerId").references(() => customers.id, { onDelete: "set null" }),
  driverId: integer("driverId").references(() => drivers.id, { onDelete: "set null" }),
  rentalFee: numeric("rentalFee", { precision: 12, scale: 2 }).notNull().default("0"),
  discountAmount: numeric("discountAmount", { precision: 12, scale: 2 }).notNull().default("0"),
  commissionAmount: numeric("commissionAmount", { precision: 12, scale: 2 }).notNull().default("0"),
  commissionStatus: varchar("commissionStatus", { length: 20 }).notNull().default("pending"),
  paidAt: timestamp("paidAt", { mode: "date" }),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  codeIdx: index("referral_ledger_code_idx").on(table.referralCodeId),
  rentalIdx: index("referral_ledger_rental_idx").on(table.rentalRequestId),
  driverIdx: index("referral_ledger_driver_idx").on(table.driverId),
  statusIdx: index("referral_ledger_status_idx").on(table.commissionStatus),
}));

export type ReferralLedgerEntry = typeof referralLedger.$inferSelect;

// ─── Feature Flags ──────────────────────────────────────────────
export const featureFlags = pgTable("feature_flags", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  enabled: boolean("enabled").default(false).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  keyIdx: index("feature_flags_key_idx").on(table.key),
}));

export type FeatureFlag = typeof featureFlags.$inferSelect;

// ─── Greeting Templates ─────────────────────────────────────
export const greetingTemplates = pgTable("greeting_templates", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 40 }).notNull(),      // 'birthday' | 'christmas' | 'new_year'
  language: varchar("language", { length: 8 }).notNull(), // 'en' | 'zh'
  subject: varchar("subject", { length: 255 }).notNull(),
  body: text("body").notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("createdAt", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date" }).defaultNow().notNull(),
}, (table) => ({
  typeLanguageUnique: unique("greeting_templates_type_lang_unique").on(table.type, table.language),
  typeIdx: index("greeting_templates_type_idx").on(table.type),
}));

export type GreetingTemplate = typeof greetingTemplates.$inferSelect;
export type InsertGreetingTemplate = typeof greetingTemplates.$inferInsert;

// ─── Greeting Log ────────────────────────────────────────────
export const greetingLog = pgTable("greeting_log", {
  id: serial("id").primaryKey(),
  customerId: integer("customerId").notNull().references(() => customers.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 40 }).notNull(),
  sentAt: timestamp("sentAt", { mode: "date" }).defaultNow().notNull(),
  sentForDate: date("sentForDate", { mode: "string" }).notNull(), // avoids double-sending for the same day
}, (table) => ({
  greetingLogUnique: uniqueIndex("greeting_log_unique").on(table.customerId, table.type, table.sentForDate),
}));

export type GreetingLog = typeof greetingLog.$inferSelect;
export type InsertGreetingLog = typeof greetingLog.$inferInsert;

// ─── Rental lifecycle effects ─────────────────────────────────
// Additive durable ledger for post-commit work planned by a rental status
// command. No historical business row is backfilled into this table.
export const rentalLifecycleEffects = pgTable("rental_lifecycle_effects", {
  id: serial("id").primaryKey(),
  commandKey: varchar("commandKey", { length: 220 }).notNull(),
  rentalRequestId: integer("rentalRequestId").notNull().references(() => rentalRequests.id, { onDelete: "restrict" }),
  effectType: varchar("effectType", { length: 50 }).notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("nextAttemptAt", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completedAt", { mode: "date", withTimezone: true }),
  lastError: text("lastError"),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  commandEffectUnique: uniqueIndex("rental_lifecycle_effects_command_effect_unique").on(table.commandKey, table.effectType),
  pendingIdx: index("rental_lifecycle_effects_pending_idx").on(table.status, table.nextAttemptAt),
  rentalIdx: index("rental_lifecycle_effects_rental_idx").on(table.rentalRequestId, table.createdAt),
}));

export type RentalLifecycleEffect = typeof rentalLifecycleEffects.$inferSelect;
export type InsertRentalLifecycleEffect = typeof rentalLifecycleEffects.$inferInsert;

// ─── MailPulse Outbox ─────────────────────────────────────────
// Durable local queue for events pushed to MailPulse (external CRM/marketing
// tool). Enqueue is synchronous with the business write (best-effort, never
// throws); delivery is an async flush (cron + fire-and-forget on enqueue)
// with exponential backoff. See server/services/mailpulseConnector.ts.
export const mailpulseOutbox = pgTable("mailpulse_outbox", {
  id: serial("id").primaryKey(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("nextAttemptAt", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp("deliveredAt", { mode: "date", withTimezone: true }),
  lastError: text("lastError"),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pendingIdx: index("mailpulse_outbox_pending_idx").on(table.deliveredAt, table.nextAttemptAt),
}));

export type MailpulseOutboxRow = typeof mailpulseOutbox.$inferSelect;
export type InsertMailpulseOutboxRow = typeof mailpulseOutbox.$inferInsert;

// ─── Workshop Outbox ──────────────────────────────────────────
// Outbound queue for "real damage found" events posted to the workshop system
// (openrental-repairshop). Mirrors mailpulse_outbox. See sql/142 +
// server/services/workshopConnector.ts.
export const workshopOutbox = pgTable("workshop_outbox", {
  id: serial("id").primaryKey(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("nextAttemptAt", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp("deliveredAt", { mode: "date", withTimezone: true }),
  lastError: text("lastError"),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pendingIdx: index("workshop_outbox_pending_idx").on(table.deliveredAt, table.nextAttemptAt),
}));

export type WorkshopOutboxRow = typeof workshopOutbox.$inferSelect;
export type InsertWorkshopOutboxRow = typeof workshopOutbox.$inferInsert;
