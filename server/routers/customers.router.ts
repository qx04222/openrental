import { z } from "zod";
import { i18nError } from "../_core/i18nError";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, desc, and, or, isNull, isNotNull, ilike, sql, inArray, lte } from "../db";
import * as schema from "../../drizzle/schema";
import { customerIndustrySchema, customerLanguageSchema } from "../../shared/customerClassification";
import { logAudit } from "../services/auditLog";
import { computeTier, DEFAULT_SEGMENTATION_CONFIG } from "../services/customerSegmentation";
import type { CustomerTier } from "../services/customerSegmentation";
import { isFeatureEnabled } from "../services/featureFlags";
import { parseCalendarDate } from "../_core/dateUtils";
import { checkRateLimit, type RateLimitEntry } from "../../shared/rateLimiter";

// Rate limiter for the unauthenticated returning-customer email lookup, keyed
// on client IP — stops bulk harvesting of customer PII via an email list.
const emailLookupLimiter = new Map<string, RateLimitEntry>();
const EMAIL_LOOKUP_WINDOW_MS = 5 * 60 * 1000;
const EMAIL_LOOKUP_MAX = 15;

export const customersRouter = router({
  list: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({
      search: z.string().max(200).optional(),
      tags: z.array(z.string()).optional(),
      hasActiveRental: z.boolean().optional(),
      sortBy: z.enum(["name", "createdAt", "totalRentals", "totalRevenue", "lastRentalDate"]).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
      limit: z.number().min(1).max(500).optional(),
      tier: z.enum(["vip", "active", "at_risk", "churned"]).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [isNull(schema.customers.deletedAt)];

      // Server-side search across name, email, phone, company, city
      if (input?.search && input.search.trim()) {
        const q = `%${input.search.trim()}%`;
        conditions.push(
          or(
            ilike(schema.customers.name, q),
            ilike(schema.customers.email, q),
            ilike(schema.customers.phone, q),
            ilike(schema.customers.company, q),
            ilike(schema.customers.city, q),
          )!,
        );
      }

      // Sort
      const sortCol = input?.sortBy || "createdAt";
      const sortDirection = input?.sortDir || "desc";
      const orderCol = sortCol === "name" ? schema.customers.name
        : sortCol === "totalRentals" ? schema.customers.totalRentals
        : sortCol === "totalRevenue" ? schema.customers.totalRevenue
        : sortCol === "lastRentalDate" ? schema.customers.lastRentalDate
        : schema.customers.createdAt;

      const orderFn = sortDirection === "asc"
        ? sql`${orderCol} ASC NULLS LAST`
        : sql`${orderCol} DESC NULLS LAST`;

      const results = await db
        .select()
        .from(schema.customers)
        .where(and(...conditions))
        .orderBy(orderFn)
        .limit(input?.limit ?? 500);

      // Post-filter: tags (JSON array contains check)
      let filtered = results;
      if (input?.tags && input.tags.length > 0) {
        filtered = filtered.filter((c) => {
          const cTags = (c.tags as string[]) || [];
          return input.tags!.some((t) => cTags.includes(t));
        });
      }

      // Attach computed tier
      const withTier = filtered.map((c) => ({
        ...c,
        tier: computeTier(
          { totalRevenue: c.totalRevenue, lastRentalDate: c.lastRentalDate },
          DEFAULT_SEGMENTATION_CONFIG,
        ) as CustomerTier,
      }));

      // Post-filter: tier
      if (input?.tier) {
        return withTier.filter((c) => c.tier === input.tier);
      }

      return withTier;
    }),

  getById: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [c] = await db.select().from(schema.customers).where(and(eq(schema.customers.id, input.id), isNull(schema.customers.deletedAt))).limit(1);
      if (!c) return null;
      return {
        ...c,
        tier: computeTier(
          { totalRevenue: c.totalRevenue, lastRentalDate: c.lastRentalDate },
          DEFAULT_SEGMENTATION_CONFIG,
        ) as CustomerTier,
      };
    }),

  // Unified 360 profile — aggregates customer + rentals + invoices + interactions + stats
  getFullProfile: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [customer] = await db
        .select()
        .from(schema.customers)
        .where(and(eq(schema.customers.id, input.id), isNull(schema.customers.deletedAt)))
        .limit(1);
      if (!customer) return null;

      // Last 20 rentals, newest first, with fleet brand+model
      const rentals = await db
        .select({
          id: schema.rentalRequests.id,
          rentalNumber: schema.rentalRequests.rentalNumber,
          status: schema.rentalRequests.status,
          totalAmount: schema.rentalRequests.totalAmount,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
          fleetBrand: schema.rentalFleet.brand,
          fleetModel: schema.rentalFleet.model,
          createdAt: schema.rentalRequests.createdAt,
        })
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(and(
          eq(schema.rentalRequests.customerId, input.id),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(20);

      // Last 20 invoices for this customer
      const invoices = await db
        .select({
          id: schema.invoices.id,
          invoiceNumber: schema.invoices.invoiceNumber,
          status: schema.invoices.status,
          totalAmount: schema.invoices.totalAmount,
          amountPaid: schema.invoices.amountPaid,
          balanceDue: schema.invoices.balanceDue,
          issueDate: schema.invoices.issueDate,
          dueDate: schema.invoices.dueDate,
        })
        .from(schema.invoices)
        .where(and(
          eq(schema.invoices.customerId, input.id),
          isNull(schema.invoices.deletedAt),
        ))
        .orderBy(desc(schema.invoices.issueDate))
        .limit(20);

      // Last 10 interactions
      const interactions = await db
        .select({
          id: schema.customerInteractions.id,
          type: schema.customerInteractions.type,
          summary: schema.customerInteractions.summary,
          createdAt: schema.customerInteractions.createdAt,
          createdByName: schema.users.name,
        })
        .from(schema.customerInteractions)
        .leftJoin(schema.users, and(eq(schema.customerInteractions.createdBy, schema.users.id), isNull(schema.users.deletedAt)))
        .where(eq(schema.customerInteractions.customerId, input.id))
        .orderBy(desc(schema.customerInteractions.createdAt))
        .limit(10);

      // Stats: totalRentals, totalRevenue, avgRentalDays, outstandingBalance, lastInteractionAt
      const [rentalAgg] = await db
        .select({
          totalRentals: sql<number>`count(*)::int`,
          totalRevenue: sql<string>`coalesce(sum(${schema.rentalRequests.totalAmount}::numeric), 0)::text`,
          avgRentalDays: sql<number>`coalesce(avg(extract(epoch from (${schema.rentalRequests.endDate} - ${schema.rentalRequests.startDate})) / 86400), 0)::int`,
        })
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.customerId, input.id),
          isNull(schema.rentalRequests.deletedAt),
        ));

      const [invoiceAgg] = await db
        .select({
          outstandingBalance: sql<string>`coalesce(sum(${schema.invoices.balanceDue}::numeric) filter (where ${schema.invoices.status} not in ('paid', 'cancelled', 'credited')), 0)::text`,
        })
        .from(schema.invoices)
        .where(and(
          eq(schema.invoices.customerId, input.id),
          isNull(schema.invoices.deletedAt),
        ));

      const lastInteractionAt = interactions[0]?.createdAt ?? null;

      return {
        customer,
        rentals,
        invoices,
        interactions,
        stats: {
          totalRentals: rentalAgg?.totalRentals ?? 0,
          totalRevenue: rentalAgg?.totalRevenue ?? "0",
          avgRentalDays: rentalAgg?.avgRentalDays ?? 0,
          outstandingBalance: invoiceAgg?.outstandingBalance ?? "0",
          lastInteractionAt,
        },
      };
    }),

  // Full customer profile with rental history + interactions + stats
  getProfile: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [customer] = await db.select().from(schema.customers)
        .where(and(eq(schema.customers.id, input.id), isNull(schema.customers.deletedAt)))
        .limit(1);
      if (!customer) return null;

      // Recent rentals
      const rentals = await db
        .select({
          id: schema.rentalRequests.id,
          status: schema.rentalRequests.status,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
          totalAmount: schema.rentalRequests.totalAmount,
          deliveryMethod: schema.rentalRequests.deliveryMethod,
          equipmentDescription: schema.rentalRequests.equipmentDescription,
          fleetBrand: schema.rentalFleet.brand,
          fleetModel: schema.rentalFleet.model,
          fleetCategory: schema.rentalFleet.category,
          createdAt: schema.rentalRequests.createdAt,
        })
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(and(
          eq(schema.rentalRequests.customerId, input.id),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(50);

      // Recent interactions
      const interactions = await db
        .select({
          id: schema.customerInteractions.id,
          type: schema.customerInteractions.type,
          summary: schema.customerInteractions.summary,
          createdAt: schema.customerInteractions.createdAt,
          createdByName: schema.users.name,
        })
        .from(schema.customerInteractions)
        .leftJoin(schema.users, and(eq(schema.customerInteractions.createdBy, schema.users.id), isNull(schema.users.deletedAt)))
        .where(eq(schema.customerInteractions.customerId, input.id))
        .orderBy(desc(schema.customerInteractions.createdAt))
        .limit(50);

      // Compute stats from rentals
      const completedRentals = rentals.filter((r) => r.status === "completed");
      const avgOrderValue = completedRentals.length > 0
        ? completedRentals.reduce((sum, r) => sum + Number(r.totalAmount || 0), 0) / completedRentals.length
        : 0;

      // Most rented equipment category
      const categoryCounts: Record<string, number> = {};
      for (const r of rentals) {
        const cat = r.fleetCategory || "Unknown";
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }
      const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      return {
        customer,
        rentals,
        interactions,
        stats: {
          totalRentals: customer.totalRentals,
          totalRevenue: Number(customer.totalRevenue),
          avgOrderValue: Math.round(avgOrderValue * 100) / 100,
          activeRentals: rentals.filter((r) => ["pending", "approved", "active"].includes(r.status)).length,
          topCategory,
        },
      };
    }),

  // Public: lookup by email for returning customer recognition.
  // Returns only the fields the checkout auto-fill actually uses
  // (name/phone/company). The customer's saved home address (address/city/
  // province/postalCode) is deliberately NOT returned — it was unused exposure
  // that let anyone with an email list harvest customers' home addresses.
  // Rate-limited per IP to blunt bulk harvesting.
  lookupByEmail: publicProcedure
    .input(z.object({ email: z.string().email().max(255) }))
    .query(async ({ input, ctx }) => {
      const ip = ctx.req?.ip || "unknown";
      if (!checkRateLimit(emailLookupLimiter, ip, EMAIL_LOOKUP_WINDOW_MS, EMAIL_LOOKUP_MAX)) {
        throw i18nError({ code: "TOO_MANY_REQUESTS", message: "Too many lookups. Please wait a few minutes and try again.", i18nKey: "errors.customer.tooManyLookups" });
      }

      const db = await getDb();
      if (!db) return null;

      const [customer] = await db
        .select({
          id: schema.customers.id,
          name: schema.customers.name,
          phone: schema.customers.phone,
          company: schema.customers.company,
        })
        .from(schema.customers)
        .where(and(eq(schema.customers.email, input.email), isNull(schema.customers.deletedAt)))
        .limit(1);

      if (!customer) return null;

      // Get last rental info
      const [lastRental] = await db
        .select({
          id: schema.rentalRequests.id,
          deliveryAddress: schema.rentalRequests.deliveryAddress,
          deliveryMethod: schema.rentalRequests.deliveryMethod,
          fleetBrand: schema.rentalFleet.brand,
          fleetModel: schema.rentalFleet.model,
          fleetCategory: schema.rentalFleet.category,
          rentalFleetId: schema.rentalRequests.rentalFleetId,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
        })
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(and(
          eq(schema.rentalRequests.customerId, customer.id),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(1);

      return {
        customer,
        lastRental: lastRental || null,
      };
    }),

  searchByPhone: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({ phone: z.string().min(3).max(50) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      // Normalize: strip non-digits. Require at least 3 digits to avoid noise.
      const digits = input.phone.replace(/\D/g, "");
      if (digits.length < 3) return [];

      const rows = await db
        .select({
          id: schema.customers.id,
          name: schema.customers.name,
          email: schema.customers.email,
          phone: schema.customers.phone,
          company: schema.customers.company,
          address: schema.customers.address,
          province: schema.customers.province,
          isBlacklisted: schema.customers.isBlacklisted,
          discountPercent: schema.customers.discountPercent,
          creditLimit: schema.customers.creditLimit,
        })
        .from(schema.customers)
        .where(and(
          sql`regexp_replace(coalesce(${schema.customers.phone}, ''), '[^0-9]', '', 'g') LIKE ${'%' + digits + '%'}`,
          isNull(schema.customers.deletedAt),
        ))
        .orderBy(desc(schema.customers.createdAt))
        .limit(5);

      return rows;
    }),

  // Unified match search for the admin order form: matches by name, company, or
  // phone (digit substring) so the admin can pick an existing customer and avoid
  // creating a duplicate. Returns the same shape as searchByPhone.
  searchForOrder: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({ query: z.string().min(2).max(100) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const q = input.query.trim();
      if (q.length < 2) return [];
      const digits = q.replace(/\D/g, "");
      const like = `%${q}%`;

      const conditions = [
        ilike(schema.customers.name, like),
        ilike(schema.customers.company, like),
      ];
      // Only add the phone-digit match when the query actually has digits, else
      // an empty digit string would LIKE-match every row.
      if (digits.length >= 3) {
        conditions.push(sql`regexp_replace(coalesce(${schema.customers.phone}, ''), '[^0-9]', '', 'g') LIKE ${'%' + digits + '%'}`);
      }

      const rows = await db
        .select({
          id: schema.customers.id,
          name: schema.customers.name,
          email: schema.customers.email,
          phone: schema.customers.phone,
          company: schema.customers.company,
          address: schema.customers.address,
          province: schema.customers.province,
          isBlacklisted: schema.customers.isBlacklisted,
          discountPercent: schema.customers.discountPercent,
          creditLimit: schema.customers.creditLimit,
        })
        .from(schema.customers)
        .where(and(
          or(...conditions),
          isNull(schema.customers.deletedAt),
        ))
        .orderBy(desc(schema.customers.createdAt))
        .limit(5);

      return rows;
    }),

  lookupByPhone: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({ phone: z.string().min(7).max(50) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      // Normalize: strip non-digits, require 7+ digits to avoid false matches
      const digits = input.phone.replace(/\D/g, "");
      if (digits.length < 7) return null;

      const [customer] = await db
        .select({
          id: schema.customers.id,
          name: schema.customers.name,
          email: schema.customers.email,
          phone: schema.customers.phone,
          company: schema.customers.company,
          address: schema.customers.address,
          city: schema.customers.city,
          province: schema.customers.province,
          postalCode: schema.customers.postalCode,
          totalRentals: schema.customers.totalRentals,
          isBlacklisted: schema.customers.isBlacklisted,
        })
        .from(schema.customers)
        .where(and(
          sql`regexp_replace(coalesce(${schema.customers.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
          isNull(schema.customers.deletedAt),
        ))
        .orderBy(desc(schema.customers.createdAt))
        .limit(1);

      if (!customer) return null;

      const [lastRental] = await db
        .select({
          deliveryAddress: schema.rentalRequests.deliveryAddress,
          deliveryProvince: schema.rentalRequests.deliveryProvince,
          deliveryMethod: schema.rentalRequests.deliveryMethod,
        })
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.customerId, customer.id),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(1);

      return { customer, lastRental: lastRental || null };
    }),

  // Get customer stats (aggregated from rentals)
  getStats: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [stats] = await db
        .select({
          totalRentals: sql<number>`count(*)::int`,
          totalRevenue: sql<string>`coalesce(sum(${schema.rentalRequests.totalAmount}::numeric), 0)`,
          avgOrderValue: sql<string>`coalesce(avg(${schema.rentalRequests.totalAmount}::numeric), 0)`,
          lastRentalDate: sql<Date>`max(${schema.rentalRequests.createdAt})`,
        })
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.customerId, input.id),
          isNull(schema.rentalRequests.deletedAt),
        ));

      return stats || null;
    }),

  // Customers needing follow-up (for dashboard widget)
  getFollowUpList: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({
      limit: z.number().min(1).max(50).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.customers.id,
          name: schema.customers.name,
          email: schema.customers.email,
          phone: schema.customers.phone,
          company: schema.customers.company,
          nextFollowUp: schema.customers.nextFollowUp,
          followUpNotes: schema.customers.followUpNotes,
          totalRentals: schema.customers.totalRentals,
          totalRevenue: schema.customers.totalRevenue,
          lastRentalDate: schema.customers.lastRentalDate,
        })
        .from(schema.customers)
        .where(and(
          isNull(schema.customers.deletedAt),
          isNotNull(schema.customers.nextFollowUp),
          lte(schema.customers.nextFollowUp, new Date()),
        ))
        .orderBy(schema.customers.nextFollowUp)
        .limit(input?.limit ?? 20);
    }),

  // All unique tags across customers (for filter dropdowns)
  getAllTags: protectedProcedure.use(moduleGuard('customers', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select({ tags: schema.customers.tags })
      .from(schema.customers)
      .where(isNull(schema.customers.deletedAt));

    const tagSet = new Set<string>();
    for (const row of rows) {
      for (const tag of (row.tags as string[]) || []) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }),

  create: protectedProcedure.use(moduleGuard('customers', 'create'))
    .input(z.object({
      name: z.string().min(1).max(255),
      email: z.string().email().max(255).optional(),
      phone: z.string().max(50).optional(),
      company: z.string().max(255).optional(),
      address: z.string().max(1000).optional(),
      city: z.string().max(100).optional(),
      province: z.string().max(100).optional(),
      postalCode: z.string().max(20).optional(),
      notes: z.string().max(5000).optional(),
      tags: z.array(z.string().max(50)).max(20).optional(),
      source: z.enum(["website", "phone", "referral", "walk_in", "admin", "other"]).optional(),
      birthday: z.string().optional(),
      greetingOptIn: z.boolean().optional(),
      discountPercent: z.number().min(0).max(100).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Prevent duplicate email for active customers
      if (input.email) {
        const [existing] = await db.select({ id: schema.customers.id })
          .from(schema.customers)
          .where(and(
            eq(schema.customers.email, input.email),
            isNull(schema.customers.deletedAt)
          ))
          .limit(1);
        if (existing) {
          throw i18nError({ code: "CONFLICT", message: "Customer with this email already exists", i18nKey: "errors.customer.emailExists" });
        }
      }

      const [r] = await db.insert(schema.customers).values({
        ...input,
        tags: input.tags || [],
        source: (input.source || "admin") as typeof schema.customers.$inferInsert.source,
        discountPercent: input.discountPercent !== undefined ? String(input.discountPercent) : undefined,
      }).returning();
      return r;
    }),

  update: protectedProcedure.use(moduleGuard('customers', 'update'))
    .input(z.object({
      id: z.number(),
      name: z.string().max(255).optional(),
      email: z.string().email().max(255).optional(),
      phone: z.string().max(50).optional(),
      company: z.string().max(255).optional(),
      address: z.string().max(1000).optional(),
      city: z.string().max(100).optional(),
      province: z.string().max(100).optional(),
      postalCode: z.string().max(20).optional(),
      notes: z.string().max(5000).optional(),
      tags: z.array(z.string().max(50)).max(20).optional(),
      source: z.enum(["website", "phone", "referral", "walk_in", "admin", "other"]).optional(),
      riskScore: z.number().min(0).max(100).optional(),
      birthday: z.string().optional(),
      greetingOptIn: z.boolean().optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      industry: customerIndustrySchema.nullable().optional(),
      secondaryIndustries: z.array(customerIndustrySchema).max(6).optional(),
      preferredLanguage: customerLanguageSchema.nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const { id, discountPercent, industry, secondaryIndustries, preferredLanguage, ...data } = input;
      // Setting any classification field by hand IS the human review, so it
      // confirms in the same stroke — otherwise the review page would nag staff
      // about rows they just edited deliberately.
      const touchedClassification =
        industry !== undefined || preferredLanguage !== undefined || secondaryIndustries !== undefined;
      // The primary never repeats in the secondaries; dedupe while we are here.
      const cleanedSecondaries = secondaryIndustries !== undefined
        ? Array.from(new Set(secondaryIndustries)).filter((v) => v !== (industry ?? undefined))
        : undefined;
      const [r] = await db.update(schema.customers).set({
        ...data,
        source: data.source as typeof schema.customers.$inferInsert.source,
        discountPercent: discountPercent !== undefined ? String(discountPercent) : undefined,
        ...(industry !== undefined ? { industry } : {}),
        ...(cleanedSecondaries !== undefined ? { secondaryIndustries: cleanedSecondaries } : {}),
        ...(preferredLanguage !== undefined ? { preferredLanguage } : {}),
        ...(touchedClassification
          ? { classificationConfirmedAt: new Date(), classificationConfirmedBy: ctx.user?.id }
          : {}),
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, id)).returning();
      return r;
    }),

  /**
   * The classification review table: every live customer with its (possibly
   * AI-suggested) industry/language and whether a human has signed off.
   * Unconfirmed first, so the work floats to the top.
   */
  classificationList: protectedProcedure.use(moduleGuard('customers', 'read'))
    .query(async () => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select({
          id: schema.customers.id,
          name: schema.customers.name,
          company: schema.customers.company,
          phone: schema.customers.phone,
          totalRentals: schema.customers.totalRentals,
          totalRevenue: schema.customers.totalRevenue,
          industry: schema.customers.industry,
          secondaryIndustries: schema.customers.secondaryIndustries,
          preferredLanguage: schema.customers.preferredLanguage,
          classificationConfirmedAt: schema.customers.classificationConfirmedAt,
        })
        .from(schema.customers)
        .where(isNull(schema.customers.deletedAt))
        .orderBy(
          sql`${schema.customers.classificationConfirmedAt} IS NOT NULL`,
          desc(schema.customers.totalRevenue),
        );
      return rows.map((r) => ({
        ...r,
        totalRevenue: parseFloat(r.totalRevenue || "0"),
      }));
    }),

  /**
   * Staff sign-off from the review page. Rows are confirmed with the values
   * CURRENTLY on them — per-row edits go through `update` first, which already
   * self-confirms, so this batch only blesses untouched suggestions.
   */
  confirmClassification: protectedProcedure.use(moduleGuard('customers', 'update'))
    .input(z.object({ ids: z.array(z.number()).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const updated = await db
        .update(schema.customers)
        .set({
          classificationConfirmedAt: new Date(),
          classificationConfirmedBy: ctx.user?.id,
          updatedAt: new Date(),
        })
        .where(and(inArray(schema.customers.id, input.ids), isNull(schema.customers.deletedAt)))
        .returning({ id: schema.customers.id });
      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "customer",
        entityId: input.ids[0],
        metadata: { action: "confirm_classification", count: updated.length },
        ipAddress: ctx.req?.ip,
      });
      return { confirmed: updated.length };
    }),

  // Update follow-up tracking
  updateFollowUp: protectedProcedure.use(moduleGuard('customers', 'update'))
    .input(z.object({
      id: z.number(),
      nextFollowUp: z.string().nullable(), // ISO date string or null to clear
      followUpNotes: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [r] = await db.update(schema.customers).set({
        nextFollowUp: input.nextFollowUp ? parseCalendarDate(input.nextFollowUp) : null,
        followUpNotes: input.followUpNotes,
        lastContactedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, input.id)).returning();

      // Auto-create follow-up interaction
      if (input.followUpNotes) {
        await db.insert(schema.customerInteractions).values({
          customerId: input.id,
          type: "follow_up" as typeof schema.customerInteractions.$inferInsert.type,
          summary: input.followUpNotes,
          createdBy: ctx.user?.id,
        });
      }

      return r;
    }),

  // Add interaction record
  addInteraction: protectedProcedure.use(moduleGuard('customers', 'create'))
    .input(z.object({
      customerId: z.number(),
      type: z.enum(["call", "email", "note", "visit", "complaint", "follow_up"]),
      summary: z.string().min(1).max(5000),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [r] = await db.insert(schema.customerInteractions).values({
        customerId: input.customerId,
        type: input.type as typeof schema.customerInteractions.$inferInsert.type,
        summary: input.summary,
        createdBy: ctx.user?.id,
      }).returning();

      // Update lastContactedAt
      await db.update(schema.customers).set({
        lastContactedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, input.customerId));

      return r;
    }),

  // List interactions for a customer
  getInteractions: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({
      customerId: z.number(),
      limit: z.number().min(1).max(100).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.customerInteractions.id,
          type: schema.customerInteractions.type,
          summary: schema.customerInteractions.summary,
          createdAt: schema.customerInteractions.createdAt,
          createdByName: schema.users.name,
        })
        .from(schema.customerInteractions)
        .leftJoin(schema.users, and(eq(schema.customerInteractions.createdBy, schema.users.id), isNull(schema.users.deletedAt)))
        .where(eq(schema.customerInteractions.customerId, input.customerId))
        .orderBy(desc(schema.customerInteractions.createdAt))
        .limit(input.limit ?? 50);
    }),

  batchExport: protectedProcedure.use(moduleGuard('customers', 'read'))
    .input(z.object({
      ids: z.array(z.number()).min(1).max(500),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const rows = await db
        .select({
          id: schema.customers.id,
          name: schema.customers.name,
          email: schema.customers.email,
          phone: schema.customers.phone,
          company: schema.customers.company,
          city: schema.customers.city,
          totalRentals: schema.customers.totalRentals,
          totalRevenue: schema.customers.totalRevenue,
          lastRentalDate: schema.customers.lastRentalDate,
        })
        .from(schema.customers)
        .where(and(
          inArray(schema.customers.id, input.ids),
          isNull(schema.customers.deletedAt),
        ));

      return rows.map((r) => ({
        id: r.id,
        name: r.name ?? "",
        email: r.email ?? "",
        phone: r.phone ?? "",
        company: r.company ?? "",
        city: r.city ?? "",
        totalRentals: r.totalRentals ?? 0,
        totalRevenue: r.totalRevenue ?? "0",
        lastRentalDate: r.lastRentalDate ? (r.lastRentalDate instanceof Date ? r.lastRentalDate.toISOString() : String(r.lastRentalDate)) : "",
      }));
    }),

  // ─── Credit / Blacklist mutations (super_admin only) ─────────────────

  setBlacklist: protectedProcedure
    .input(z.object({
      id: z.number(),
      isBlacklisted: z.boolean(),
      reason: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user?.role !== "super_admin") {
        throw i18nError({ code: "FORBIDDEN", message: "Only super_admin can manage customer blacklist.", i18nKey: "errors.customer.blacklistSuperAdminOnly" });
      }
      if (!(await isFeatureEnabled("credit_limit"))) {
        throw i18nError({ code: "FORBIDDEN", message: "Credit limit feature is not enabled.", i18nKey: "errors.customer.creditLimitDisabled" });
      }
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [prev] = await db
        .select()
        .from(schema.customers)
        .where(and(eq(schema.customers.id, input.id), isNull(schema.customers.deletedAt)))
        .limit(1);
      if (!prev) throw i18nError({ code: "NOT_FOUND", message: "Customer not found.", i18nKey: "errors.customer.notFound" });

      const [r] = await db.update(schema.customers).set({
        isBlacklisted: input.isBlacklisted,
        blacklistReason: input.isBlacklisted ? (input.reason ?? null) : null,
        blacklistedAt: input.isBlacklisted ? new Date() : null,
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, input.id)).returning();

      await logAudit({
        userId: ctx.user.id,
        action: input.isBlacklisted ? "blacklist" : "unblacklist",
        entityType: "customer",
        entityId: input.id,
        changes: {
          isBlacklisted: { old: prev.isBlacklisted, new: input.isBlacklisted },
          blacklistReason: { old: prev.blacklistReason, new: input.reason ?? null },
        },
        ipAddress: ctx.req?.ip,
      });

      return r;
    }),

  setCreditLimit: protectedProcedure
    .input(z.object({
      id: z.number(),
      limit: z.number().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.user?.role !== "super_admin") {
        throw i18nError({ code: "FORBIDDEN", message: "Only super_admin can set credit limits.", i18nKey: "errors.customer.creditLimitSuperAdminOnly" });
      }
      if (!(await isFeatureEnabled("credit_limit"))) {
        throw i18nError({ code: "FORBIDDEN", message: "Credit limit feature is not enabled.", i18nKey: "errors.customer.creditLimitDisabled" });
      }
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [prev] = await db
        .select()
        .from(schema.customers)
        .where(and(eq(schema.customers.id, input.id), isNull(schema.customers.deletedAt)))
        .limit(1);
      if (!prev) throw i18nError({ code: "NOT_FOUND", message: "Customer not found.", i18nKey: "errors.customer.notFound" });

      const newLimit = input.limit !== null ? input.limit.toString() : null;
      const [r] = await db.update(schema.customers).set({
        creditLimit: newLimit,
        updatedAt: new Date(),
      }).where(eq(schema.customers.id, input.id)).returning();

      await logAudit({
        userId: ctx.user.id,
        action: "set_credit_limit",
        entityType: "customer",
        entityId: input.id,
        changes: {
          creditLimit: { old: prev.creditLimit, new: newLimit },
        },
        ipAddress: ctx.req?.ip,
      });

      return r;
    }),

  delete: protectedProcedure.use(moduleGuard('customers', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Check for active rentals
      const activeRentals = await db
        .select({ id: schema.rentalRequests.id })
        .from(schema.rentalRequests)
        .where(
          and(
            eq(schema.rentalRequests.customerId, input.id),
            inArray(schema.rentalRequests.status, ["pending", "approved", "active"]),
            isNull(schema.rentalRequests.deletedAt)
          )
        )
        .limit(1);

      if (activeRentals.length > 0) {
        throw i18nError({ code: "CONFLICT", message: "Cannot delete customer with active rentals. Complete or cancel them first.", i18nKey: "errors.customer.hasActiveRentals" });
      }

      await db.update(schema.customers).set({ deletedAt: new Date() }).where(eq(schema.customers.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "customer",
        entityId: input.id,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),
});
