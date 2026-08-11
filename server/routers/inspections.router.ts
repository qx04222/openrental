import { z } from "zod";
import { router, publicProcedure, fieldStaffProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, desc, and, gte, lte, isNull, or, inArray, sql } from "../db";
import { logAudit } from "../services/auditLog";
import * as schema from "../../drizzle/schema";
import { createHash, randomBytes } from "crypto";
import { logger } from "../_core/logger";
import { uploadInspectionPhotosToSupabase, isSupabaseStorageConfigured } from "../services/storage";
import { TRPCError } from "@trpc/server";
import { checkRateLimit, purgeExpiredEntries } from "../../shared/rateLimiter";
import type { RateLimitEntry } from "../../shared/rateLimiter";
import { hashDocument, extractClientMetadata } from "../services/signatureEvidence";
import { recordAssetProgressEvent } from "../services/rentalAssetProgress";
import { assertFleetRentalPairUnambiguous } from "../services/rentalFleetConflict";

// Rate limit for token-based public submissions: max 10 per IP per 15 min
const tokenSubmitLimiter = new Map<string, RateLimitEntry>();
const TOKEN_SUBMIT_WINDOW = 15 * 60 * 1000;
const TOKEN_SUBMIT_MAX = 10;

// Cleanup stale entries every 30 min
setInterval(() => {
  purgeExpiredEntries(tokenSubmitLimiter);
}, 30 * 60 * 1000).unref();

const MAX_PHOTO_SIZE = 10_000_000; // ~7.5MB base64

const inspectionInputSchema = z.object({
  type: z.enum(["dispatch", "return", "general"]),
  rentalId: z.number().optional(),
  rentalFleetId: z.number().optional(),
  equipmentSelected: z.string().max(500).optional(),
  inspectorName: z.string().max(255).optional(),
  inspectorId: z.number().optional(),
  engineHours: z.number().min(0).optional(),
  hourMeter: z.number().min(0).optional(),
  fuelLevel: z.number().min(0).max(100).optional(),
  fuelLevelPercent: z.number().min(0).max(100).optional(),
  fuelChargeAmount: z.number().min(0).optional(),
  odometerReading: z.number().min(0).optional(),
  overallCondition: z.enum(["excellent", "good", "fair", "poor"]).optional(),
  damageNotes: z.string().max(5000).optional(),
  damageSeverity: z.enum(["none", "minor", "moderate", "severe"]).optional(),
  locationAddress: z.string().max(1000).optional(),
  latitude: z.string().max(30).optional(),
  longitude: z.string().max(30).optional(),
  photoFront: z.string().max(MAX_PHOTO_SIZE).optional(),
  photoBack: z.string().max(MAX_PHOTO_SIZE).optional(),
  photoLeft: z.string().max(MAX_PHOTO_SIZE).optional(),
  photoRight: z.string().max(MAX_PHOTO_SIZE).optional(),
  photoAdditional: z.string().max(MAX_PHOTO_SIZE).optional(),
  customerSignature: z.string().max(MAX_PHOTO_SIZE).optional(),
  customerSignedAt: z.string().max(30).optional(),
  notes: z.string().max(5000).optional(),
  offlineId: z.string().max(100).optional(),
});

async function createInspectionCore(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  input: z.infer<typeof inspectionInputSchema>,
  req?: { ip?: string; headers?: Record<string, string | string[] | undefined> },
  // Only authenticated field staff may supply a manual fuel charge. On the
  // public token endpoint we must NEVER trust the client amount — we recompute
  // it server-side, else anyone with a token could invoice an arbitrary charge.
  trustClientFuelCharge = false,
  actor?: { id?: number; source: "pwa" | "admin_web" | "inspection" },
) {
  // Dedup by offlineId
  if (input.offlineId) {
    const [existing] = await db
      .select()
      .from(schema.inspections)
      .where(and(eq(schema.inspections.offlineId, input.offlineId), isNull(schema.inspections.deletedAt)))
      .limit(1);
    if (existing) {
      logger.info(`[Inspections] Duplicate offlineId: ${input.offlineId}`);
      return existing;
    }
  }

  if (input.type !== "general" && input.rentalId && input.rentalFleetId) {
    await assertFleetRentalPairUnambiguous(db, input.rentalId, input.rentalFleetId);
  }

  // Upload photos to Supabase Storage if configured
  let photoUrls = {
    photoFront: input.photoFront || null,
    photoBack: input.photoBack || null,
    photoLeft: input.photoLeft || null,
    photoRight: input.photoRight || null,
    photoAdditional: input.photoAdditional || null,
    customerSignature: input.customerSignature || null,
  };

  if (isSupabaseStorageConfigured()) {
    try {
      let equipmentIdentifier = "unknown";
      if (input.rentalFleetId) {
        const [fleet] = await db
          .select()
          .from(schema.rentalFleet)
          .where(and(eq(schema.rentalFleet.id, input.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
          .limit(1);
        if (fleet) {
          equipmentIdentifier = `${fleet.brand}-${fleet.model}`.replace(/\s+/g, "-");
        }
      }

      photoUrls = await uploadInspectionPhotosToSupabase(
        {
          photoFront: input.photoFront,
          photoBack: input.photoBack,
          photoLeft: input.photoLeft,
          photoRight: input.photoRight,
          photoAdditional: input.photoAdditional,
          customerSignature: input.customerSignature,
        },
        input.rentalId,
        input.type,
        equipmentIdentifier
      );
    } catch (err) {
      logger.error("[Inspections] Photo upload failed, storing raw data", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Calculate fuel charge for return inspections
  let calculatedFuelCharge: number | undefined = trustClientFuelCharge ? input.fuelChargeAmount : undefined;
  const fuelPercent = input.fuelLevelPercent ?? input.fuelLevel;

  if (input.type === "return" && input.rentalId && fuelPercent != null && fuelPercent < 100) {
    try {
      // Fetch fleet tank capacity and rental fuel price
      let tankCapacity = 0;
      let fuelPrice = 3.00; // default $/L (office sheet: 缺油升数 × $3/L)

      if (input.rentalFleetId) {
        const [fleet] = await db
          .select({ fuelTankCapacityLitres: schema.rentalFleet.fuelTankCapacityLitres })
          .from(schema.rentalFleet)
          .where(and(eq(schema.rentalFleet.id, input.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
          .limit(1);
        if (fleet?.fuelTankCapacityLitres) {
          tankCapacity = Number(fleet.fuelTankCapacityLitres);
        }
      }

      const [rental] = await db
        .select({ fuelPricePerLitre: schema.rentalRequests.fuelPricePerLitre })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
        .limit(1);
      if (rental?.fuelPricePerLitre) {
        fuelPrice = Number(rental.fuelPricePerLitre);
      }

      if (tankCapacity > 0 && calculatedFuelCharge === undefined) {
        calculatedFuelCharge = ((100 - fuelPercent) / 100) * tankCapacity * fuelPrice;
        calculatedFuelCharge = Math.round(calculatedFuelCharge * 100) / 100;
      }
    } catch (err) {
      logger.error("[Inspections] Fuel charge calculation failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Capture signature evidence when customer signature is present
  let signatureIp: string | null = null;
  let signatureUserAgent: string | null = null;
  let signatureDocumentHash: string | null = null;
  if (input.customerSignature && req) {
    const meta = extractClientMetadata(req);
    signatureIp = meta.ip;
    signatureUserAgent = meta.userAgent;
    const docContent = JSON.stringify({
      type: input.type,
      rentalId: input.rentalId ?? null,
      rentalFleetId: input.rentalFleetId ?? null,
      customerSignedAt: input.customerSignedAt ?? null,
      offlineId: input.offlineId ?? null,
    });
    signatureDocumentHash = hashDocument(docContent);
  }

  const [result] = await db.insert(schema.inspections).values({
    type: input.type,
    rentalId: input.rentalId,
    rentalFleetId: input.rentalFleetId,
    equipmentSelected: input.equipmentSelected,
    inspectorName: input.inspectorName,
    inspectorId: input.inspectorId,
    engineHours: input.engineHours != null ? String(input.engineHours) : undefined,
    hourMeter: input.hourMeter != null ? String(input.hourMeter) : undefined,
    fuelLevel: input.fuelLevel,
    fuelLevelPercent: fuelPercent,
    fuelChargeAmount: calculatedFuelCharge != null ? calculatedFuelCharge.toFixed(2) : undefined,
    odometerReading: input.odometerReading,
    overallCondition: input.overallCondition,
    damageNotes: input.damageNotes,
    damageSeverity: input.damageSeverity,
    locationAddress: input.locationAddress,
    latitude: input.latitude,
    longitude: input.longitude,
    photoFront: photoUrls.photoFront,
    photoBack: photoUrls.photoBack,
    photoLeft: photoUrls.photoLeft,
    photoRight: photoUrls.photoRight,
    photoAdditional: photoUrls.photoAdditional,
    customerSignature: photoUrls.customerSignature,
    customerSignedAt: input.customerSignedAt ? new Date(input.customerSignedAt) : undefined,
    notes: input.notes,
    offlineId: input.offlineId,
    syncedAt: input.offlineId ? new Date() : undefined,
    signatureIp: signatureIp ?? undefined,
    signatureUserAgent: signatureUserAgent ?? undefined,
    signatureDocumentHash: signatureDocumentHash ?? undefined,
  }).returning();

  // Update rental inspection status
  if (result && input.rentalId) {
    if (input.type === "dispatch") {
      await db.update(schema.rentalRequests).set({
        deliveryInspectionCompleted: true,
        deliveryInspectionId: result.id,
        updatedAt: new Date(),
      }).where(eq(schema.rentalRequests.id, input.rentalId));
    } else if (input.type === "return") {
      // Guard: only mark the ORDER as return-inspected when the inspected unit
      // is (still) part of the order. After a mid-rental swap, the replaced
      // unit comes back for its own return inspection while the order keeps
      // running on the new unit — that inspection must not flip the order's
      // return-completed flag. No-unit inspections keep the legacy behavior.
      let unitBelongsToOrder = true;
      if (input.rentalFleetId) {
        const belongs = await db.execute(sql`
          SELECT 1 FROM rental_requests r
          WHERE r.id = ${input.rentalId} AND r."deletedAt" IS NULL
            AND ( r."rentalFleetId" = ${input.rentalFleetId}
              OR EXISTS (SELECT 1 FROM rental_line_items li
                WHERE li."rentalRequestId" = r.id AND li."deletedAt" IS NULL
                  AND li."rentalFleetId" = ${input.rentalFleetId}) )
          LIMIT 1
        `);
        unitBelongsToOrder = belongs.length > 0;
      }
      if (unitBelongsToOrder) {
        await db.update(schema.rentalRequests).set({
          returnInspectionCompleted: true,
          returnInspectionId: result.id,
          updatedAt: new Date(),
        }).where(eq(schema.rentalRequests.id, input.rentalId));
      }
    }
  }

  if (result && input.rentalId && input.rentalFleetId && input.type !== "general") {
    try {
      await recordAssetProgressEvent(db, {
        eventKey: `inspection:${result.id}:completed`,
        rentalRequestId: input.rentalId,
        rentalFleetId: input.rentalFleetId,
        eventType: `${input.type}_inspection_completed`,
        fromStage: input.type === "dispatch" ? "entry_pending" : "return_pending",
        toStage: input.type === "dispatch" ? "entry_ready" : "return_ready",
        source: actor?.source ?? "inspection",
        sourceEntityType: "inspection",
        sourceEntityId: result.id,
        actorUserId: actor?.id,
        createdAt: new Date(),
      });
    } catch (error) {
      logger.error("[Inspections] Progress event write failed", {
        inspectionId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Post-creation: auto-create fuel extra-charge + damage claim for return inspections
  if (result && input.type === "return" && input.rentalId) {
    // --- Fuel deficit → unified extra charge (merges into the order invoice at
    // close, instead of a separate fuel_surcharge invoice) ---
    if (calculatedFuelCharge && calculatedFuelCharge > 0) {
      try {
        const [rental] = await db
          .select({ customerId: schema.rentalRequests.customerId, fuelPricePerLitre: schema.rentalRequests.fuelPricePerLitre })
          .from(schema.rentalRequests)
          .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
          .limit(1);

        const deficitPct = 100 - (fuelPercent ?? 0);
        let tankCapStr = "?";
        if (input.rentalFleetId) {
          const [fleet] = await db
            .select({ fuelTankCapacityLitres: schema.rentalFleet.fuelTankCapacityLitres })
            .from(schema.rentalFleet)
            .where(and(eq(schema.rentalFleet.id, input.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
            .limit(1);
          if (fleet?.fuelTankCapacityLitres) tankCapStr = String(fleet.fuelTankCapacityLitres);
        }
        const priceStr = rental?.fuelPricePerLitre ? String(rental.fuelPricePerLitre) : "?";
        const desc = `Fuel deficit: ${deficitPct}% × ${tankCapStr} L × $${priceStr}/L`;

        await db.insert(schema.damageClaims).values({
          inspectionId: result.id,
          rentalId: input.rentalId,
          customerId: rental?.customerId,
          chargeType: "fuel",
          description: desc,
          amount: calculatedFuelCharge.toFixed(2),
          approvedAmount: calculatedFuelCharge.toFixed(2),
          status: "accepted", // simple charge → ready to bill on the order invoice
        });

        logger.info(`[Inspections] Auto-created fuel extra-charge for inspection #${result.id}, amount: $${calculatedFuelCharge.toFixed(2)}`);
      } catch (err) {
        logger.error("[Inspections] Failed to auto-create fuel extra-charge", {
          inspectionId: result.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // --- Auto-create damage claim for moderate/severe damage ---
    const sev = input.damageSeverity;
    if (sev === "moderate" || sev === "severe") {
      try {
        const [rental] = await db
          .select({ customerId: schema.rentalRequests.customerId })
          .from(schema.rentalRequests)
          .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
          .limit(1);

        const description = input.damageNotes || `${sev} damage detected during return inspection #${result.id}`;

        await db.insert(schema.damageClaims).values({
          inspectionId: result.id,
          rentalId: input.rentalId,
          customerId: rental?.customerId,
          description,
          status: "pending",
        }).returning({ id: schema.damageClaims.id });

        logger.info(`[Inspections] Auto-created damage claim for inspection #${result.id}, severity: ${sev}`);
      } catch (err) {
        logger.error("[Inspections] Failed to auto-create damage claim", {
          inspectionId: result.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return result;
}

export const inspectionsRouter = router({
  list: protectedProcedure.use(moduleGuard('inspections', 'read'))
    .input(z.object({
      type: z.enum(["dispatch", "return", "general"]).optional(),
      condition: z.enum(["excellent", "good", "fair", "poor"]).optional(),
      startDate: z.string().optional(),
      limit: z.number().min(1).max(200).optional(),
      offset: z.number().min(0).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [isNull(schema.inspections.deletedAt)];
      if (input?.type) {
        conditions.push(eq(schema.inspections.type, input.type));
      }
      if (input?.condition) {
        conditions.push(eq(schema.inspections.overallCondition, input.condition));
      }
      if (input?.startDate) {
        conditions.push(gte(schema.inspections.createdAt, new Date(input.startDate)));
      }

      const where = and(...conditions);

      return db
        .select({
          inspections: schema.inspections,
          rental_fleet: {
            id: schema.rentalFleet.id,
            brand: schema.rentalFleet.brand,
            model: schema.rentalFleet.model,
            serialNumber: schema.rentalFleet.serialNumber,
          },
          rental_requests: {
            id: schema.rentalRequests.id,
            rentalNumber: schema.rentalRequests.rentalNumber,
            customerName: schema.rentalRequests.customerName,
          },
        })
        .from(schema.inspections)
        .leftJoin(schema.rentalFleet, and(eq(schema.inspections.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.rentalRequests, and(eq(schema.inspections.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .where(where)
        .orderBy(desc(schema.inspections.createdAt))
        .limit(input?.limit || 100)
        .offset(input?.offset || 0);
    }),

  getById: protectedProcedure.use(moduleGuard('inspections', 'read'))
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [result] = await db
        .select()
        .from(schema.inspections)
        .leftJoin(schema.rentalFleet, and(eq(schema.inspections.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .where(and(eq(schema.inspections.id, input.id), isNull(schema.inspections.deletedAt)))
        .limit(1);

      return result || null;
    }),

  getByRentalId: protectedProcedure.use(moduleGuard('inspections', 'read'))
    .input(z.object({ rentalId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select()
        .from(schema.inspections)
        .where(and(eq(schema.inspections.rentalId, input.rentalId), isNull(schema.inspections.deletedAt)))
        .orderBy(desc(schema.inspections.createdAt));
    }),

  // Get all inspections for a specific fleet/equipment item (both direct and through rentals)
  getByFleetId: protectedProcedure.use(moduleGuard('inspections', 'read'))
    .input(z.object({ fleetId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      // Get rental IDs that used this equipment
      const rentalsWithEquipment = await db
        .select({ id: schema.rentalRequests.id })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.rentalFleetId, input.fleetId), isNull(schema.rentalRequests.deletedAt)));

      const rentalIds = rentalsWithEquipment.map((r) => r.id);

      // Build conditions: direct fleetId OR through rental
      const conditions = [isNull(schema.inspections.deletedAt)];

      if (rentalIds.length > 0) {
        conditions.push(
          or(
            eq(schema.inspections.rentalFleetId, input.fleetId),
            inArray(schema.inspections.rentalId, rentalIds)
          )!
        );
      } else {
        conditions.push(eq(schema.inspections.rentalFleetId, input.fleetId));
      }

      return db
        .select({
          inspections: schema.inspections,
          rental_requests: {
            id: schema.rentalRequests.id,
            rentalNumber: schema.rentalRequests.rentalNumber,
            customerName: schema.rentalRequests.customerName,
          },
        })
        .from(schema.inspections)
        .leftJoin(schema.rentalRequests, and(eq(schema.inspections.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .where(and(...conditions))
        .orderBy(desc(schema.inspections.createdAt));
    }),

  // Summary stats + trend data for a fleet item's inspection history
  getFleetInspectionSummary: protectedProcedure.use(moduleGuard('inspections', 'read'))
    .input(z.object({ fleetId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      // Get all rental IDs for this fleet
      const rentalsWithEquipment = await db
        .select({ id: schema.rentalRequests.id })
        .from(schema.rentalRequests)
        .where(and(eq(schema.rentalRequests.rentalFleetId, input.fleetId), isNull(schema.rentalRequests.deletedAt)));

      const rentalIds = rentalsWithEquipment.map((r) => r.id);

      // Build conditions
      const conditions = [isNull(schema.inspections.deletedAt)];
      if (rentalIds.length > 0) {
        conditions.push(
          or(
            eq(schema.inspections.rentalFleetId, input.fleetId),
            inArray(schema.inspections.rentalId, rentalIds)
          )!
        );
      } else {
        conditions.push(eq(schema.inspections.rentalFleetId, input.fleetId));
      }

      // Fetch all inspections for this fleet (limited to most recent 50 for trends)
      const inspections = await db
        .select({
          id: schema.inspections.id,
          type: schema.inspections.type,
          createdAt: schema.inspections.createdAt,
          overallCondition: schema.inspections.overallCondition,
          engineHours: schema.inspections.engineHours,
          fuelLevel: schema.inspections.fuelLevel,
          odometerReading: schema.inspections.odometerReading,
          damageSeverity: schema.inspections.damageSeverity,
          damageNotes: schema.inspections.damageNotes,
        })
        .from(schema.inspections)
        .where(and(...conditions))
        .orderBy(desc(schema.inspections.createdAt))
        .limit(50);

      const total = inspections.length;
      const byType = { dispatch: 0, return: 0, general: 0 };
      const damageCount = { none: 0, minor: 0, moderate: 0, severe: 0 };
      const trendData: { date: string; engineHours: number | null; fuelLevel: number | null; odometerReading: number | null; condition: string | null }[] = [];

      for (const insp of inspections) {
        if (insp.type in byType) byType[insp.type as keyof typeof byType]++;
        const sev = (insp.damageSeverity || "none") as keyof typeof damageCount;
        if (sev in damageCount) damageCount[sev]++;

        trendData.push({
          date: insp.createdAt.toISOString(),
          engineHours: insp.engineHours != null ? parseFloat(String(insp.engineHours)) : null,
          fuelLevel: insp.fuelLevel ? parseInt(String(insp.fuelLevel)) : null,
          odometerReading: insp.odometerReading,
          condition: insp.overallCondition,
        });
      }

      // Reverse for chronological order in charts
      trendData.reverse();

      return {
        total,
        byType,
        damageCount,
        trendData,
        lastInspection: inspections[0]?.createdAt ?? null,
      };
    }),

  // Authenticated create — for field staff / admin / SW offline sync
  create: fieldStaffProcedure
    .input(inspectionInputSchema)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      // Authenticated field staff may supply a manual fuel charge override.
      return createInspectionCore(
        db,
        input,
        ctx.req as { ip?: string; headers?: Record<string, string | string[] | undefined> },
        true,
        { id: ctx.user.id, source: ctx.user.role === "field_staff" ? "pwa" : "admin_web" },
      );
    }),

  // Token-gated public create — for StaffInspection (external link)
  createWithToken: publicProcedure
    .input(inspectionInputSchema.extend({ token: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      // Rate limit by IP
      const ip = ctx.req?.ip || "unknown";
      if (!checkRateLimit(tokenSubmitLimiter, ip, TOKEN_SUBMIT_WINDOW, TOKEN_SUBMIT_MAX)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many submissions. Try again later." });
      }

      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const { token, ...inspectionInput } = input;
      const tokenHash = createHash("sha256").update(token).digest("hex");

      // Validate token + create inspection + mark used atomically
      return await db.transaction(async (tx) => {
        const [tokenRecord] = await tx
          .select()
          .from(schema.inspectionTokens)
          .where(eq(schema.inspectionTokens.tokenHash, tokenHash))
          .limit(1);

        if (!tokenRecord) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Invalid inspection token." });
        }
        if (tokenRecord.isUsed) {
          throw new TRPCError({ code: "CONFLICT", message: "This token has already been used." });
        }
        if (new Date() > tokenRecord.expiresAt) {
          throw new TRPCError({ code: "FORBIDDEN", message: "This token has expired." });
        }

        // Validate token constraints match submission
        if (tokenRecord.inspectionType !== inspectionInput.type) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Inspection type does not match token." });
        }
        if (tokenRecord.rentalId != null && tokenRecord.rentalId !== inspectionInput.rentalId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Rental ID does not match token." });
        }
        if (tokenRecord.rentalFleetId != null && tokenRecord.rentalFleetId !== inspectionInput.rentalFleetId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Fleet ID does not match token." });
        }

        // Mark token used first (prevents replay if createInspectionCore somehow fails and retries)
        await tx
          .update(schema.inspectionTokens)
          .set({ isUsed: true })
          .where(eq(schema.inspectionTokens.tokenHash, tokenHash));

        // Create the inspection (uses the transaction connection via db-level calls, but
        // photo upload is external so we pass the outer db for that; the insert uses tx)
        const result = await createInspectionCore(
          tx as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>,
          inspectionInput,
          ctx.req as { ip?: string; headers?: Record<string, string | string[] | undefined> },
        );
        return result;
      });
    }),

  // Edit an existing inspection — used by admin to add missing photos /
  // correct readings when the driver couldn't (or wouldn't) use the PWA.
  // Photos passed as base64 data URLs are uploaded to Supabase storage; HTTP
  // URLs already in the field are kept as-is (don't re-upload an existing photo).
  update: fieldStaffProcedure
    .input(z.object({
      id: z.number(),
      inspectorName: z.string().max(255).optional(),
      engineHours: z.number().min(0).optional(),
      hourMeter: z.number().min(0).optional(),
      fuelLevel: z.number().min(0).max(100).optional(),
      fuelLevelPercent: z.number().min(0).max(100).optional(),
      odometerReading: z.number().min(0).optional(),
      overallCondition: z.enum(["excellent", "good", "fair", "poor"]).optional(),
      damageNotes: z.string().max(5000).optional(),
      damageSeverity: z.enum(["none", "minor", "moderate", "severe"]).optional(),
      locationAddress: z.string().max(1000).optional(),
      photoFront: z.string().max(MAX_PHOTO_SIZE).nullable().optional(),
      photoBack: z.string().max(MAX_PHOTO_SIZE).nullable().optional(),
      photoLeft: z.string().max(MAX_PHOTO_SIZE).nullable().optional(),
      photoRight: z.string().max(MAX_PHOTO_SIZE).nullable().optional(),
      photoAdditional: z.string().max(MAX_PHOTO_SIZE).nullable().optional(),
      customerSignature: z.string().max(MAX_PHOTO_SIZE).nullable().optional(),
      notes: z.string().max(5000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.inspections)
        .where(and(eq(schema.inspections.id, input.id), isNull(schema.inspections.deletedAt)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Inspection not found" });

      const updates: Record<string, unknown> = { updatedAt: new Date() };

      const scalarFields = [
        "inspectorName", "engineHours", "hourMeter", "fuelLevel", "fuelLevelPercent",
        "odometerReading", "overallCondition", "damageNotes", "damageSeverity",
        "locationAddress", "notes",
      ] as const;
      for (const f of scalarFields) {
        if (input[f] === undefined) continue;
        // engineHours/hourMeter are numeric(10,1) — Drizzle expects a string.
        updates[f] = (f === "engineHours" || f === "hourMeter") && input[f] != null
          ? String(input[f])
          : input[f];
      }

      // Photo / signature uploads — only re-upload base64 data URLs. http(s) URLs
      // are returning unchanged; null explicitly clears the field.
      const photoKeys = ["photoFront", "photoBack", "photoLeft", "photoRight", "photoAdditional", "customerSignature"] as const;
      const pendingUploads: Partial<Record<typeof photoKeys[number], string>> = {};
      for (const k of photoKeys) {
        const v = input[k];
        if (v === undefined) continue;
        if (v === null) {
          updates[k] = null;
          continue;
        }
        if (v.startsWith("data:")) {
          pendingUploads[k] = v;
        } else {
          // Already a URL — keep as-is
          updates[k] = v;
        }
      }

      if (Object.keys(pendingUploads).length > 0 && isSupabaseStorageConfigured()) {
        try {
          let equipmentIdentifier = "unknown";
          if (existing.rentalFleetId) {
            const [fleet] = await db
              .select()
              .from(schema.rentalFleet)
              .where(and(eq(schema.rentalFleet.id, existing.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
              .limit(1);
            if (fleet) {
              equipmentIdentifier = `${fleet.brand}-${fleet.model}`.replace(/\s+/g, "-");
            }
          }
          const uploaded = await uploadInspectionPhotosToSupabase(
            pendingUploads,
            existing.rentalId ?? undefined,
            existing.type,
            equipmentIdentifier,
          );
          for (const k of photoKeys) {
            const got = (uploaded as Record<string, string | null>)[k];
            if (got != null) updates[k] = got;
          }
        } catch (err) {
          logger.error("[Inspections] Admin update: photo upload failed; persisting base64", {
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall back to base64 — better than losing the photo
          for (const k of photoKeys) {
            if (pendingUploads[k]) updates[k] = pendingUploads[k];
          }
        }
      } else if (Object.keys(pendingUploads).length > 0) {
        for (const k of photoKeys) {
          if (pendingUploads[k]) updates[k] = pendingUploads[k];
        }
      }

      const [result] = await db
        .update(schema.inspections)
        .set(updates)
        .where(eq(schema.inspections.id, input.id))
        .returning();

      const photoFieldsTouched = Object.keys(pendingUploads).filter((k) => updates[k]);
      const explicitlyCleared = photoKeys.filter((k) => input[k] === null);
      await logAudit({
        userId: ctx.user?.id,
        action: "update",
        entityType: "inspection",
        entityId: input.id,
        metadata: {
          source: "admin_edit",
          rentalId: existing.rentalId,
          rentalFleetId: existing.rentalFleetId,
          photosUploaded: photoFieldsTouched,
          photosCleared: explicitlyCleared,
        },
        ipAddress: ctx.req?.ip,
      });

      return result;
    }),

  // Inspection token management
  createToken: protectedProcedure.use(moduleGuard('inspections', 'create'))
    .input(z.object({
      rentalId: z.number().optional(),
      rentalFleetId: z.number().optional(),
      inspectionType: z.enum(["dispatch", "return", "general"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

      await db.insert(schema.inspectionTokens).values({
        tokenHash,
        rentalId: input.rentalId,
        rentalFleetId: input.rentalFleetId,
        inspectionType: input.inspectionType,
        createdBy: ctx.user?.id,
        expiresAt,
      });

      return { token, expiresAt };
    }),

  verifyToken: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      const [tokenRecord] = await db
        .select()
        .from(schema.inspectionTokens)
        .where(eq(schema.inspectionTokens.tokenHash, tokenHash))
        .limit(1);

      if (!tokenRecord) return null;
      if (tokenRecord.isUsed) return null;
      if (new Date() > tokenRecord.expiresAt) return null;

      let equipment = null;
      if (tokenRecord.rentalFleetId) {
        const [fleet] = await db
          .select()
          .from(schema.rentalFleet)
          .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
          .where(and(eq(schema.rentalFleet.id, tokenRecord.rentalFleetId), isNull(schema.rentalFleet.deletedAt)))
          .limit(1);
        equipment = fleet;
      }

      // Fetch rentalNumber if rental is linked
      let rentalNumber: string | null = null;
      if (tokenRecord.rentalId) {
        const [rental] = await db
          .select({ rentalNumber: schema.rentalRequests.rentalNumber })
          .from(schema.rentalRequests)
          .where(and(eq(schema.rentalRequests.id, tokenRecord.rentalId), isNull(schema.rentalRequests.deletedAt)))
          .limit(1);
        rentalNumber = rental?.rentalNumber ?? null;
      }

      return {
        inspectionType: tokenRecord.inspectionType,
        rentalId: tokenRecord.rentalId,
        rentalFleetId: tokenRecord.rentalFleetId,
        rentalNumber,
        equipment,
      };
    }),

  markTokenUsed: protectedProcedure.use(moduleGuard('inspections', 'update'))
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      await db
        .update(schema.inspectionTokens)
        .set({ isUsed: true })
        .where(eq(schema.inspectionTokens.tokenHash, tokenHash));

      return { success: true };
    }),

  listTokens: protectedProcedure.use(moduleGuard('inspections', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];

    const tokens = await db
      .select({
        id: schema.inspectionTokens.id,
        inspectionType: schema.inspectionTokens.inspectionType,
        rentalId: schema.inspectionTokens.rentalId,
        rentalFleetId: schema.inspectionTokens.rentalFleetId,
        isUsed: schema.inspectionTokens.isUsed,
        expiresAt: schema.inspectionTokens.expiresAt,
        createdAt: schema.inspectionTokens.createdAt,
        createdBy: schema.inspectionTokens.createdBy,
        rentalCustomerName: schema.rentalRequests.customerName,
        rentalNumber: schema.rentalRequests.rentalNumber,
        fleetBrand: schema.rentalFleet.brand,
        fleetModel: schema.rentalFleet.model,
      })
      .from(schema.inspectionTokens)
      .leftJoin(schema.rentalRequests, and(eq(schema.inspectionTokens.rentalId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
      .leftJoin(schema.rentalFleet, and(eq(schema.inspectionTokens.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
      .orderBy(desc(schema.inspectionTokens.createdAt));

    // Cleanup expired tokens older than 7 days (fire and forget)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    db.delete(schema.inspectionTokens)
      .where(and(
        eq(schema.inspectionTokens.isUsed, true),
        lte(schema.inspectionTokens.expiresAt, sevenDaysAgo),
      ))
      .then(() => {})
      .catch(() => {});

    return tokens;
  }),

  getComparisonForRental: protectedProcedure.use(moduleGuard('inspections', 'read'))
    .input(z.object({ rentalId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { dispatch: null, return: null };

      const allInspections = await db
        .select()
        .from(schema.inspections)
        .where(and(eq(schema.inspections.rentalId, input.rentalId), isNull(schema.inspections.deletedAt)))
        .orderBy(desc(schema.inspections.createdAt));

      const dispatchInsp = allInspections.find(i => i.type === "dispatch") || null;
      const returnInsp = allInspections.find(i => i.type === "return") || null;

      return { dispatch: dispatchInsp, return: returnInsp };
    }),

  getFleetForInspection: fieldStaffProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    return db
      .select({
        rental_fleet: {
          id: schema.rentalFleet.id,
          brand: schema.rentalFleet.brand,
          model: schema.rentalFleet.model,
          category: schema.rentalFleet.category,
          serialNumber: schema.rentalFleet.serialNumber,
          assetNumber: schema.rentalFleet.assetNumber,
          currentStatus: schema.rentalFleet.currentStatus,
          imageUrl: schema.rentalFleet.imageUrl,
        },
        catalog_cache: {
          id: schema.catalogCache.id,
          imageUrl: schema.catalogCache.imageUrl,
        },
      })
      .from(schema.rentalFleet)
      .leftJoin(schema.catalogCache, eq(schema.rentalFleet.catalogCacheId, schema.catalogCache.id))
      .where(isNull(schema.rentalFleet.deletedAt))
      .orderBy(schema.rentalFleet.brand, schema.rentalFleet.model);
  }),

  // Get fuel data for a rental+fleet combo (used by inspection forms for real-time charge calc)
  getFuelData: publicProcedure
    .input(z.object({
      rentalId: z.number().optional(),
      fleetId: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { fuelTankCapacityLitres: null, fuelPricePerLitre: null };

      let fuelTankCapacityLitres: number | null = null;
      let fuelPricePerLitre: number | null = null;

      if (input.fleetId) {
        const [fleet] = await db
          .select({ fuelTankCapacityLitres: schema.rentalFleet.fuelTankCapacityLitres })
          .from(schema.rentalFleet)
          .where(and(eq(schema.rentalFleet.id, input.fleetId), isNull(schema.rentalFleet.deletedAt)))
          .limit(1);
        if (fleet?.fuelTankCapacityLitres) {
          fuelTankCapacityLitres = Number(fleet.fuelTankCapacityLitres);
        }
      }

      if (input.rentalId) {
        const [rental] = await db
          .select({ fuelPricePerLitre: schema.rentalRequests.fuelPricePerLitre })
          .from(schema.rentalRequests)
          .where(and(eq(schema.rentalRequests.id, input.rentalId), isNull(schema.rentalRequests.deletedAt)))
          .limit(1);
        if (rental?.fuelPricePerLitre) {
          fuelPricePerLitre = Number(rental.fuelPricePerLitre);
        }
      }

      return { fuelTankCapacityLitres, fuelPricePerLitre };
    }),

  getActiveRentalsForInspection: fieldStaffProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    const statusFilter = or(
      eq(schema.rentalRequests.status, "pending"),
      eq(schema.rentalRequests.status, "approved"),
      eq(schema.rentalRequests.status, "active"),
      // Overdue rentals (auto-flipped from "active" by overdueCron once past the
      // grace period) are still on-hire and must be returnable — field staff need
      // to find them to do the check-out inspection. Matches the return/close
      // paths in rentalRequests.router.ts which all treat overdue as on-hire.
      eq(schema.rentalRequests.status, "overdue"),
    );

    // Single-asset orders: equipment is on the parent rentalFleetId pointer.
    // Restrict to rentalFleetId IS NOT NULL so multi-item orders (handled below)
    // aren't pulled in here without their per-line fleet metadata.
    const singleRows = await db
      .select({
        id: schema.rentalRequests.id,
        rentalNumber: schema.rentalRequests.rentalNumber,
        customerName: schema.rentalRequests.customerName,
        status: schema.rentalRequests.status,
        startDate: schema.rentalRequests.startDate,
        endDate: schema.rentalRequests.endDate,
        deliveryMethod: schema.rentalRequests.deliveryMethod,
        deliveryAddress: schema.rentalRequests.deliveryAddress,
        lineItemId: sql<number | null>`NULL`,
        fleetId: schema.rentalRequests.rentalFleetId,
        fleetBrand: schema.rentalFleet.brand,
        fleetModel: schema.rentalFleet.model,
        fleetSerialNumber: schema.rentalFleet.serialNumber,
      })
      .from(schema.rentalRequests)
      .innerJoin(schema.rentalFleet, eq(schema.rentalRequests.rentalFleetId, schema.rentalFleet.id))
      .where(and(statusFilter, isNull(schema.rentalRequests.deletedAt), isNull(schema.rentalFleet.deletedAt)));

    // Multi-item orders: parent rentalFleetId is NULL; equipment lives in
    // rental_line_items. Emit one selectable row per fleet unit so field staff
    // can inspect each asset on a multi-item order individually.
    const multiRows = await db
      .select({
        id: schema.rentalRequests.id,
        rentalNumber: schema.rentalRequests.rentalNumber,
        customerName: schema.rentalRequests.customerName,
        status: schema.rentalRequests.status,
        startDate: schema.rentalRequests.startDate,
        endDate: schema.rentalRequests.endDate,
        deliveryMethod: schema.rentalRequests.deliveryMethod,
        deliveryAddress: schema.rentalRequests.deliveryAddress,
        lineItemId: schema.rentalLineItems.id,
        fleetId: schema.rentalLineItems.rentalFleetId,
        fleetBrand: schema.rentalFleet.brand,
        fleetModel: schema.rentalFleet.model,
        fleetSerialNumber: schema.rentalFleet.serialNumber,
      })
      .from(schema.rentalLineItems)
      .innerJoin(
        schema.rentalRequests,
        and(
          eq(schema.rentalLineItems.rentalRequestId, schema.rentalRequests.id),
          isNull(schema.rentalRequests.rentalFleetId),
          isNull(schema.rentalRequests.deletedAt),
        ),
      )
      .innerJoin(schema.rentalFleet, eq(schema.rentalLineItems.rentalFleetId, schema.rentalFleet.id))
      .where(and(statusFilter, isNull(schema.rentalLineItems.deletedAt), isNull(schema.rentalFleet.deletedAt)));

    return [...singleRows, ...multiRows].sort(
      (a, b) => (b.startDate?.getTime() ?? 0) - (a.startDate?.getTime() ?? 0),
    );
  }),

  generatePDF: protectedProcedure.use(moduleGuard('inspections', 'read'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const { generateInspectionPDF } = await import("../services/inspectionPDF");
      return generateInspectionPDF(input.id);
    }),

  deleteToken: protectedProcedure.use(moduleGuard('inspections', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [existing] = await db
        .select()
        .from(schema.inspectionTokens)
        .where(eq(schema.inspectionTokens.id, input.id))
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Token not found" });

      await db.delete(schema.inspectionTokens).where(eq(schema.inspectionTokens.id, input.id));
      return { success: true };
    }),

  deleteTokens: protectedProcedure.use(moduleGuard('inspections', 'delete'))
    .input(z.object({ ids: z.array(z.number()).min(1).max(100) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      await db.delete(schema.inspectionTokens).where(inArray(schema.inspectionTokens.id, input.ids));
      return { success: true, deleted: input.ids.length };
    }),

  bulkDelete: protectedProcedure.use(moduleGuard('inspections', 'delete'))
    .input(z.object({ ids: z.array(z.number()).min(1).max(100) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const existing = await db
        .select({ id: schema.inspections.id, type: schema.inspections.type })
        .from(schema.inspections)
        .where(and(inArray(schema.inspections.id, input.ids), isNull(schema.inspections.deletedAt)));

      if (existing.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No inspections found" });
      }

      const foundIds = existing.map((e) => e.id);

      await db
        .update(schema.inspections)
        .set({ deletedAt: new Date() })
        .where(inArray(schema.inspections.id, foundIds));

      // Log audit for each deletion
      for (const insp of existing) {
        await logAudit({
          userId: ctx.user?.id,
          action: "delete",
          entityType: "inspection",
          entityId: insp.id,
          metadata: { type: insp.type, bulk: true },
          ipAddress: ctx.req?.ip,
        });
      }

      return { success: true as const, deleted: foundIds.length };
    }),

  delete: protectedProcedure.use(moduleGuard('inspections', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [existing] = await db
        .select()
        .from(schema.inspections)
        .where(and(eq(schema.inspections.id, input.id), isNull(schema.inspections.deletedAt)))
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Inspection not found" });

      await db.update(schema.inspections).set({ deletedAt: new Date() }).where(eq(schema.inspections.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "inspection",
        entityId: input.id,
        metadata: { type: existing.type },
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),
});
