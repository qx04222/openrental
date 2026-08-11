import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, ilike, or, and, isNull, desc, sql, eq } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * Unified search router — provides fast keyword search across customers, fleet, and rentals.
 * When pgvector + embeddings are set up, semantic search can be layered on top.
 * For now, uses server-side ILIKE for reliable cross-table search.
 */
export const searchRouter = router({
  /**
   * Global search across customers, fleet, and rentals.
   * Used by Cmd+K search bar in admin layout.
   */
  global: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(z.object({
      query: z.string().min(1).max(200),
      limit: z.number().min(1).max(20).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { customers: [], fleet: [], rentals: [], invoices: [], projects: [] };

      const q = `%${input.query.trim()}%`;
      const limit = input.limit ?? 5;

      // Search customers
      const customers = await db
        .select({
          id: schema.customers.id,
          name: schema.customers.name,
          email: schema.customers.email,
          company: schema.customers.company,
          phone: schema.customers.phone,
          city: schema.customers.city,
          totalRentals: schema.customers.totalRentals,
          industry: schema.customers.industry,
          secondaryIndustries: schema.customers.secondaryIndustries,
          preferredLanguage: schema.customers.preferredLanguage,
        })
        .from(schema.customers)
        .where(and(
          isNull(schema.customers.deletedAt),
          or(
            ilike(schema.customers.name, q),
            ilike(schema.customers.email, q),
            ilike(schema.customers.phone, q),
            ilike(schema.customers.company, q),
            ilike(schema.customers.city, q),
          ),
        ))
        .orderBy(desc(schema.customers.totalRentals))
        .limit(limit);

      // Search fleet
      const fleet = await db
        .select({
          id: schema.rentalFleet.id,
          brand: schema.rentalFleet.brand,
          model: schema.rentalFleet.model,
          category: schema.rentalFleet.category,
          serialNumber: schema.rentalFleet.serialNumber,
          currentStatus: schema.rentalFleet.currentStatus,
        })
        .from(schema.rentalFleet)
        .where(and(
          isNull(schema.rentalFleet.deletedAt),
          or(
            ilike(schema.rentalFleet.brand, q),
            ilike(schema.rentalFleet.model, q),
            ilike(schema.rentalFleet.category, q),
            ilike(schema.rentalFleet.serialNumber, q),
            ilike(schema.rentalFleet.assetNumber, q),
          ),
        ))
        .limit(limit);

      // Search rentals (by ID, customer name, email)
      const rentalConditions = [
        isNull(schema.rentalRequests.deletedAt),
        or(
          ilike(schema.rentalRequests.customerName, q),
          ilike(schema.rentalRequests.customerEmail, q),
          ilike(schema.rentalRequests.customerCompany, q),
          // Human-readable order numbers (rentalNumber, e.g. R0012; and the
          // financial order number, e.g. SOR00042 / SOT12721).
          ilike(schema.rentalRequests.rentalNumber, q),
          ilike(schema.rentalRequests.financialOrderNumber, q),
          // Check if query is numeric → search by ID
          ...(input.query.match(/^\d+$/) ? [sql`${schema.rentalRequests.id} = ${Number(input.query)}`] : []),
        ),
      ];

      const rentals = await db
        .select({
          id: schema.rentalRequests.id,
          rentalNumber: schema.rentalRequests.rentalNumber,
          financialOrderNumber: schema.rentalRequests.financialOrderNumber,
          customerName: schema.rentalRequests.customerName,
          status: schema.rentalRequests.status,
          totalAmount: schema.rentalRequests.totalAmount,
          startDate: schema.rentalRequests.startDate,
          endDate: schema.rentalRequests.endDate,
          fleetBrand: schema.rentalFleet.brand,
          fleetModel: schema.rentalFleet.model,
        })
        .from(schema.rentalRequests)
        .leftJoin(schema.rentalFleet, sql`${schema.rentalRequests.rentalFleetId} = ${schema.rentalFleet.id} AND ${schema.rentalFleet.deletedAt} IS NULL`)
        .where(and(...rentalConditions))
        .orderBy(desc(schema.rentalRequests.createdAt))
        .limit(limit);

      // Search invoices (by invoiceNumber; join customers for name + email)
      const invoices = await db
        .select({
          id: schema.invoices.id,
          invoiceNumber: schema.invoices.invoiceNumber,
          status: schema.invoices.status,
          totalAmount: schema.invoices.totalAmount,
          dueDate: schema.invoices.dueDate,
          customerName: schema.customers.name,
          customerEmail: schema.customers.email,
        })
        .from(schema.invoices)
        .leftJoin(schema.customers, and(eq(schema.invoices.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .where(and(
          isNull(schema.invoices.deletedAt),
          or(
            ilike(schema.invoices.invoiceNumber, q),
            ilike(schema.customers.name, q),
            ilike(schema.customers.email, q),
          ),
        ))
        .orderBy(desc(schema.invoices.createdAt))
        .limit(limit);

      // Search projects (by name, siteAddress, city)
      const projects = await db
        .select({
          id: schema.projects.id,
          name: schema.projects.name,
          status: schema.projects.status,
          siteAddress: schema.projects.siteAddress,
          city: schema.projects.city,
          contactName: schema.projects.contactName,
        })
        .from(schema.projects)
        .where(and(
          isNull(schema.projects.deletedAt),
          or(
            ilike(schema.projects.name, q),
            ilike(schema.projects.siteAddress, q),
            ilike(schema.projects.city, q),
            ilike(schema.projects.contactName, q),
          ),
        ))
        .orderBy(desc(schema.projects.createdAt))
        .limit(limit);

      return { customers, fleet, rentals, invoices, projects };
    }),
});
