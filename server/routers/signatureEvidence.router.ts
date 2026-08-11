/**
 * Signature Evidence Router
 * Exposes audit-trail endpoints for rental contract and inspection signatures.
 * Gated by audit_log read permission.
 */

import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { hashDocument } from "../services/signatureEvidence";
import { TRPCError } from "@trpc/server";

export const signatureEvidenceRouter = router({
  /**
   * Return the stored signature evidence for a rental contract.
   * Also recomputes the expected hash so callers can detect tampering.
   */
  getForRental: protectedProcedure.use(moduleGuard("audit_log", "read"))
    .input(z.object({ rentalId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [rental] = await db
        .select({
          id: schema.rentalRequests.id,
          customerName: schema.rentalRequests.customerName,
          totalAmount: schema.rentalRequests.totalAmount,
          contractSignedAt: schema.rentalRequests.contractSignedAt,
          signatureIp: schema.rentalRequests.signatureIp,
          signatureUserAgent: schema.rentalRequests.signatureUserAgent,
          signatureContractHash: schema.rentalRequests.signatureContractHash,
        })
        .from(schema.rentalRequests)
        .where(and(
          eq(schema.rentalRequests.id, input.rentalId),
          isNull(schema.rentalRequests.deletedAt),
        ))
        .limit(1);

      if (!rental) throw new TRPCError({ code: "NOT_FOUND", message: "Rental not found" });

      // Recompute the hash with the same inputs used at signing time
      let originalContractHash: string | null = null;
      if (rental.contractSignedAt) {
        const contractContent = JSON.stringify({
          rentalId: rental.id,
          totalAmount: rental.totalAmount,
          customerName: rental.customerName,
          signedAt: rental.contractSignedAt.toISOString(),
        });
        originalContractHash = hashDocument(contractContent);
      }

      return {
        signedAt: rental.contractSignedAt,
        signatureIp: rental.signatureIp,
        signatureUserAgent: rental.signatureUserAgent,
        signatureContractHash: rental.signatureContractHash,
        originalContractHash,
        hashMatch:
          rental.signatureContractHash !== null &&
          originalContractHash !== null &&
          rental.signatureContractHash === originalContractHash,
      };
    }),

  /**
   * Return the stored signature evidence for an inspection.
   * Also recomputes the expected hash so callers can detect tampering.
   */
  getForInspection: protectedProcedure.use(moduleGuard("audit_log", "read"))
    .input(z.object({ inspectionId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [inspection] = await db
        .select({
          id: schema.inspections.id,
          type: schema.inspections.type,
          rentalId: schema.inspections.rentalId,
          rentalFleetId: schema.inspections.rentalFleetId,
          offlineId: schema.inspections.offlineId,
          customerSignedAt: schema.inspections.customerSignedAt,
          signatureIp: schema.inspections.signatureIp,
          signatureUserAgent: schema.inspections.signatureUserAgent,
          signatureDocumentHash: schema.inspections.signatureDocumentHash,
        })
        .from(schema.inspections)
        .where(and(
          eq(schema.inspections.id, input.inspectionId),
          isNull(schema.inspections.deletedAt),
        ))
        .limit(1);

      if (!inspection) throw new TRPCError({ code: "NOT_FOUND", message: "Inspection not found" });

      // Recompute the hash with the same inputs used at signing time
      let originalDocumentHash: string | null = null;
      if (inspection.customerSignedAt) {
        const docContent = JSON.stringify({
          type: inspection.type,
          rentalId: inspection.rentalId ?? null,
          rentalFleetId: inspection.rentalFleetId ?? null,
          customerSignedAt: inspection.customerSignedAt.toISOString(),
          offlineId: inspection.offlineId ?? null,
        });
        originalDocumentHash = hashDocument(docContent);
      }

      return {
        signedAt: inspection.customerSignedAt,
        signatureIp: inspection.signatureIp,
        signatureUserAgent: inspection.signatureUserAgent,
        signatureDocumentHash: inspection.signatureDocumentHash,
        originalDocumentHash,
        hashMatch:
          inspection.signatureDocumentHash !== null &&
          originalDocumentHash !== null &&
          inspection.signatureDocumentHash === originalDocumentHash,
      };
    }),
});
