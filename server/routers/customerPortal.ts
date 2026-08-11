import { z } from "zod";
import { router, publicProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, desc, sql, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { CUSTOMER_COOKIE_NAME } from "../../shared/const";
import { getCustomerSession } from "../services/customerSession";
import { hashDocument, extractClientMetadata } from "../services/signatureEvidence";
import { calculateDaysBetween } from "../services/pricingCalculation";
import type { TrpcContext } from "../_core/context";
import { logger } from "../_core/logger";

/**
 * Extract the authenticated customer ID from the session cookie.
 * Throws UNAUTHORIZED if not logged in.
 */
async function getCustomerId(ctx: TrpcContext): Promise<number> {
  const token = ctx.req.cookies[CUSTOMER_COOKIE_NAME];
  if (!token) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Please log in to your customer portal" });
  }

  const session = await getCustomerSession(token);
  if (!session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Session expired. Please log in again." });
  }

  return session.customerId;
}

export const customerPortalRouter = router({
  dashboard: publicProcedure.query(async ({ ctx }) => {
    const customerId = await getCustomerId(ctx);
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

    // Active rentals count
    const [activeResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.rentalRequests)
      .where(
        and(
          eq(schema.rentalRequests.customerId, customerId),
          eq(schema.rentalRequests.status, "active"),
          isNull(schema.rentalRequests.deletedAt)
        )
      );

    // Unpaid invoices count — from the invoices table by outstanding balance,
    // not the stale rental_requests.paymentStatus column. balanceDue is kept in
    // sync with applied prepayments by the invoice generator, so it's the
    // authoritative "still owing" signal.
    const [unpaidResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.invoices)
      .where(
        and(
          eq(schema.invoices.customerId, customerId),
          isNull(schema.invoices.deletedAt),
          sql`${schema.invoices.balanceDue}::numeric > 0`
        )
      );

    // Total deposit balance (sum of depositAmount where depositPaid = true and status is active)
    const [depositResult] = await db
      .select({ total: sql<string>`COALESCE(SUM(${schema.rentalRequests.depositAmount}::numeric), 0)` })
      .from(schema.rentalRequests)
      .where(
        and(
          eq(schema.rentalRequests.customerId, customerId),
          eq(schema.rentalRequests.depositPaid, true),
          eq(schema.rentalRequests.status, "active"),
          isNull(schema.rentalRequests.deletedAt)
        )
      );

    return {
      activeRentals: activeResult?.count ?? 0,
      unpaidInvoices: unpaidResult?.count ?? 0,
      depositBalance: depositResult?.total ?? "0",
    };
  }),

  orders: publicProcedure
    .input(z.object({
      status: z.enum(["pending", "approved", "rejected", "active", "completed", "cancelled", "overdue"]).optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const customerId = await getCustomerId(ctx);
      const db = await getDb();
      if (!db) return [];

      const conditions = [
        eq(schema.rentalRequests.customerId, customerId),
        isNull(schema.rentalRequests.deletedAt),
      ];
      if (input?.status) {
        conditions.push(eq(schema.rentalRequests.status, input.status));
      }

      return db
        .select()
        .from(schema.rentalRequests)
        .where(and(...conditions))
        .orderBy(desc(schema.rentalRequests.createdAt));
    }),

  orderDetail: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input, ctx }) => {
      const customerId = await getCustomerId(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(
          and(
            eq(schema.rentalRequests.id, input.id),
            eq(schema.rentalRequests.customerId, customerId),
            isNull(schema.rentalRequests.deletedAt)
          )
        )
        .limit(1);

      if (!rental) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
      }

      // Get extension requests for this rental
      const extensions = await db
        .select()
        .from(schema.extensionRequests)
        .where(
          and(
            eq(schema.extensionRequests.rentalRequestId, input.id),
            eq(schema.extensionRequests.customerId, customerId)
          )
        )
        .orderBy(desc(schema.extensionRequests.createdAt));

      // Line items joined with fleet + model (multi-item orders)
      const items = await db
        .select({
          line: schema.rentalLineItems,
          fleetBrand: schema.rentalFleet.brand,
          fleetModel: schema.rentalFleet.model,
          fleetCategory: schema.rentalFleet.category,
          fleetAssetNumber: schema.rentalFleet.assetNumber,
          modelBrand: schema.equipmentModels.brand,
          modelModel: schema.equipmentModels.model,
          modelCategory: schema.equipmentModels.category,
        })
        .from(schema.rentalLineItems)
        .leftJoin(schema.rentalFleet, and(eq(schema.rentalLineItems.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.equipmentModels, and(eq(schema.rentalLineItems.equipmentModelId, schema.equipmentModels.id), isNull(schema.equipmentModels.deletedAt)))
        .where(and(
          eq(schema.rentalLineItems.rentalRequestId, input.id),
          isNull(schema.rentalLineItems.deletedAt),
        ))
        .orderBy(schema.rentalLineItems.id);

      // Invoices for this rental
      const invoices = await db
        .select({
          id: schema.invoices.id,
          invoiceNumber: schema.invoices.invoiceNumber,
          status: schema.invoices.status,
          totalAmount: schema.invoices.totalAmount,
          balanceDue: schema.invoices.balanceDue,
          issueDate: schema.invoices.issueDate,
          dueDate: schema.invoices.dueDate,
          pdfUrl: schema.invoices.pdfUrl,
        })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.rentalId, input.id), isNull(schema.invoices.deletedAt)))
        .orderBy(desc(schema.invoices.createdAt));

      // Audit-log derived timeline (created / status changes / signature events)
      const events = await db
        .select({
          id: schema.auditLogs.id,
          action: schema.auditLogs.action,
          changes: schema.auditLogs.changes,
          metadata: schema.auditLogs.metadata,
          createdAt: schema.auditLogs.createdAt,
        })
        .from(schema.auditLogs)
        .where(and(
          eq(schema.auditLogs.entityType, "rental"),
          eq(schema.auditLogs.entityId, input.id),
        ))
        .orderBy(schema.auditLogs.createdAt);

      return { ...rental, extensionRequests: extensions, items, invoices, timeline: events };
    }),

  invoices: publicProcedure.query(async ({ ctx }) => {
    const customerId = await getCustomerId(ctx);
    const db = await getDb();
    if (!db) return [];

    // Read the real invoices table (with derived balance), not rental_requests:
    // the order isn't an invoice, and its stale paymentStatus doesn't reflect
    // the actual outstanding balance. balanceDue is kept in sync with applied
    // prepayments by the invoice generator.
    const rows = await db
      .select({
        id: schema.invoices.id,
        invoiceNumber: schema.invoices.invoiceNumber,
        status: schema.invoices.status,
        totalAmount: schema.invoices.totalAmount,
        amountPaid: schema.invoices.amountPaid,
        balanceDue: schema.invoices.balanceDue,
        issueDate: schema.invoices.issueDate,
        dueDate: schema.invoices.dueDate,
        pdfUrl: schema.invoices.pdfUrl,
        rentalId: schema.invoices.rentalId,
      })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.customerId, customerId), isNull(schema.invoices.deletedAt)))
      .orderBy(desc(schema.invoices.issueDate));

    return rows.map((r) => ({
      ...r,
      // `total` for the loosely-typed portal table; dates as plain strings so
      // the client renders them without choking on Date objects.
      total: r.totalAmount,
      issueDate: r.issueDate ? r.issueDate.toISOString().slice(0, 10) : null,
      dueDate: r.dueDate ? r.dueDate.toISOString().slice(0, 10) : null,
    }));
  }),

  deposits: publicProcedure.query(async ({ ctx }) => {
    const customerId = await getCustomerId(ctx);
    const db = await getDb();
    if (!db) return [];

    return db
      .select({
        id: schema.rentalRequests.id,
        equipmentDescription: schema.rentalRequests.equipmentDescription,
        startDate: schema.rentalRequests.startDate,
        endDate: schema.rentalRequests.endDate,
        status: schema.rentalRequests.status,
        depositAmount: schema.rentalRequests.depositAmount,
        depositPaid: schema.rentalRequests.depositPaid,
        createdAt: schema.rentalRequests.createdAt,
      })
      .from(schema.rentalRequests)
      .where(and(eq(schema.rentalRequests.customerId, customerId), isNull(schema.rentalRequests.deletedAt)))
      .orderBy(desc(schema.rentalRequests.createdAt));
  }),

  requestExtension: publicProcedure
    .input(z.object({
      rentalRequestId: z.number(),
      requestedEndDate: z.string().transform((s) => new Date(s)),
      reason: z.string().max(1000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const customerId = await getCustomerId(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Validate ownership and active status
      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(
          and(
            eq(schema.rentalRequests.id, input.rentalRequestId),
            eq(schema.rentalRequests.customerId, customerId),
            isNull(schema.rentalRequests.deletedAt)
          )
        )
        .limit(1);

      if (!rental) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });
      }

      if (rental.status !== "active") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only active rentals can be extended" });
      }

      if (input.requestedEndDate <= rental.endDate) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Requested end date must be after current end date" });
      }

      const [extension] = await db
        .insert(schema.extensionRequests)
        .values({
          rentalRequestId: input.rentalRequestId,
          customerId,
          requestedEndDate: input.requestedEndDate,
          reason: input.reason,
        })
        .returning();

      // Send extension_requested notification (notify admin)
      try {
        const { notifyOnEvent } = await import("../services/notifications");
        const [customer] = await db
          .select()
          .from(schema.customers)
          .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
          .limit(1);
        if (customer) {
          await notifyOnEvent("extension_requested", {
            customerName: customer.name,
            email: customer.email || "",
            phone: customer.phone || "",
            rentalId: String(input.rentalRequestId),
            requestedEndDate: input.requestedEndDate
              ? new Date(input.requestedEndDate).toLocaleDateString("en-CA")
              : "",
            extensionReason: input.reason || "",
            companyName: "OpenRental",
          });
        }
      } catch (err: unknown) {
        logger.error("[CustomerPortal] Extension notification failed", { error: err instanceof Error ? err.message : String(err) });
      }

      return extension;
    }),

  extensions: publicProcedure.query(async ({ ctx }) => {
    const customerId = await getCustomerId(ctx);
    const db = await getDb();
    if (!db) return [];

    return db
      .select()
      .from(schema.extensionRequests)
      .where(eq(schema.extensionRequests.customerId, customerId))
      .orderBy(desc(schema.extensionRequests.createdAt));
  }),

  // Customer self-signs the rental contract from the portal. Stores the
  // signature image, sets contractSignedAt (idempotent), and re-generates
  // the contract PDF with the signature embedded.
  signContract: publicProcedure
    .input(z.object({
      rentalId: z.number(),
      signature: z.string().min(50, "Signature is required"),
    }))
    .mutation(async ({ input, ctx }) => {
      const customerId = await getCustomerId(ctx);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select()
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.id, input.rentalId),
          eq(schema.rentalRequests.customerId, customerId),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });

      // Idempotent: once signed, do not overwrite the evidence. A re-sign (or an
      // accidental double-submit) would keep the original contractSignedAt via
      // COALESCE below while recomputing signatureContractHash from a NEW
      // timestamp — desyncing them so signatureEvidence.getForRental reports
      // hashMatch=false and the legal proof self-invalidates. The first signature
      // is the binding one; return it unchanged.
      if (rental.contractSignedAt) {
        return { signedAt: rental.contractSignedAt };
      }

      const now = new Date();

      // Tamper-evident signature evidence — the customer self-sign is the
      // legally most important signature, so it must carry the same IP / UA /
      // contract-hash evidence the admin (rep) sign path records. Without this
      // signatureEvidence.getForRental returns null IP/hash and hashMatch=false
      // for portal-signed contracts, leaving no defensible proof in a dispute.
      const meta = extractClientMetadata(ctx.req as { ip?: string; headers?: Record<string, string | string[] | undefined> });
      const contractHash = hashDocument(JSON.stringify({
        rentalId: rental.id,
        totalAmount: rental.totalAmount,
        customerName: rental.customerName,
        signedAt: now.toISOString(),
      }));

      // contractSignedAt is a plain assignment (not COALESCE) — the re-sign
      // guard above guarantees it is null here, so there is nothing to preserve.
      // The old `sql\`COALESCE(..., ${now})\`` also bound a JS Date inside a raw
      // sql fragment, which under postgres-js (prepare:false) serialized the Date
      // to a locale string and crashed the query, breaking ALL portal signing.
      await db.update(schema.rentalRequests).set({
        customerSignature: input.signature,
        contractSignedAt: now,
        signatureIp: meta.ip ?? undefined,
        signatureUserAgent: meta.userAgent ?? undefined,
        signatureContractHash: contractHash,
        updatedAt: now,
      }).where(eq(schema.rentalRequests.id, input.rentalId));

      // Re-generate the contract PDF with the new signature embedded.
      // Wrapped in try/catch so a PDF failure doesn't roll back the signature itself.
      try {
        const [fleet] = rental.rentalFleetId ? await db
          .select()
          .from(schema.rentalFleet)
          .where(and(eq(schema.rentalFleet.id, rental.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
          .limit(1) : [null];

        const { generateContractPDF } = await import("../services/contractPDF");
        const { loadContractLineItems } = await import("../services/contractLineItems");
        // Contract "Duration" text only — DST-safe so it matches the billed term.
        const days = calculateDaysBetween(rental.startDate, rental.endDate);
        const { url } = await generateContractPDF({
          rentalId: rental.id,
          rentalNumber: rental.rentalNumber,
          customerName: rental.customerName,
          customerEmail: rental.customerEmail || "",
          customerPhone: rental.customerPhone || "",
          companyName: rental.customerCompany || undefined,
          equipmentBrand: fleet?.brand || "",
          equipmentModel: fleet?.model || "",
          equipmentCategory: fleet?.category || "",
          startDate: rental.startDate,
          endDate: rental.endDate,
          rentalDays: days,
          rentalFee: rental.rentalFee || "0",
          freightCost: rental.freightCost || "0",
          insuranceCost: rental.insuranceCost || "0",
          taxAmount: rental.taxAmount || "0",
          depositAmount: rental.depositAmount || "0",
          totalCost: rental.totalAmount || "0",
          deliveryAddress: rental.deliveryAddress || "Customer pickup",
          projectDescription: rental.projectDescription || undefined,
          contractTemplateId: rental.contractTemplateId ?? undefined,
          customerSignature: input.signature,
          customerSignedAt: now,
          repSignature: rental.repSignature,
          repSignedAt: rental.repSignedAt,
          items: await loadContractLineItems(db, rental.id),
        });

        await db.update(schema.rentalRequests).set({
          contractUrl: url,
          contractGenerated: true,
          contractGeneratedAt: now,
          contractVersion: (rental.contractVersion || 0) + 1,
        }).where(eq(schema.rentalRequests.id, input.rentalId));
      } catch (err) {
        logger.error("[customerPortal.signContract] Failed to regenerate PDF", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Fire-and-forget admin notification
      try {
        const { notifyContractSigned } = await import("../services/smsNotify");
        await notifyContractSigned(rental.rentalNumber, rental.customerName, rental.id);
      } catch { /* notification is best-effort */ }

      return { signedAt: now };
    }),
});
