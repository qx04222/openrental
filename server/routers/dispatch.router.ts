import { z } from "zod";
import { nanoid } from "nanoid";
import { TRPCError } from "@trpc/server";
import { checkRateLimit, type RateLimitEntry } from "../../shared/rateLimiter";
import { router, publicProcedure, fieldStaffProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { zMoneyOptional } from "../../shared/zodMoney";
import { getDb, eq, desc, and, isNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { logAudit } from "../services/auditLog";
import { recordAssetProgressEvent } from "../services/rentalAssetProgress";
import { assertFleetRentalPairUnambiguous } from "../services/rentalFleetConflict";

import { DISPATCH_VALID_TRANSITIONS } from "../../shared/dispatchTransitions";
import { parseCalendarDate } from "../_core/dateUtils";

// Rate-limit the unauthenticated delivery-confirmation endpoint (per token).
const confirmDeliveryRateLimit = new Map<string, RateLimitEntry>();

export const dispatchRouter = router({
  list: protectedProcedure.use(moduleGuard('dispatch', 'read'))
    .input(z.object({
      status: z.enum(["pending", "assigned", "in_transit", "delivered", "completed", "cancelled"]).optional(),
      limit: z.number().min(1).max(1000).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      // Select only columns the frontend actually uses
      const baseQuery = db
        .select({
          dispatch_orders: schema.dispatchOrders,
          customers: {
            id: schema.customers.id,
            name: schema.customers.name,
          },
          rental_fleet: {
            id: schema.rentalFleet.id,
            brand: schema.rentalFleet.brand,
            model: schema.rentalFleet.model,
          },
          driver: {
            id: schema.drivers.id,
            name: schema.drivers.name,
          },
          rental: {
            rentalNumber: schema.rentalRequests.rentalNumber,
          },
        })
        .from(schema.dispatchOrders)
        .leftJoin(schema.rentalFleet, and(eq(schema.dispatchOrders.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.customers, and(eq(schema.dispatchOrders.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.drivers, and(eq(schema.dispatchOrders.assignedDriverId, schema.drivers.id), isNull(schema.drivers.deletedAt)))
        .leftJoin(schema.rentalRequests, and(eq(schema.dispatchOrders.rentalRequestId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .orderBy(desc(schema.dispatchOrders.createdAt))
        .limit(input?.limit ?? 500);

      if (input?.status) {
        return baseQuery.where(and(isNull(schema.dispatchOrders.deletedAt), eq(schema.dispatchOrders.status, input.status)));
      }
      return baseQuery.where(isNull(schema.dispatchOrders.deletedAt));
    }),

  getByRentalId: protectedProcedure.use(moduleGuard('dispatch', 'read'))
    .input(z.object({ rentalId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select()
        .from(schema.dispatchOrders)
        .leftJoin(schema.drivers, and(eq(schema.dispatchOrders.assignedDriverId, schema.drivers.id), isNull(schema.drivers.deletedAt)))
        .where(and(eq(schema.dispatchOrders.rentalRequestId, input.rentalId), isNull(schema.dispatchOrders.deletedAt)))
        .orderBy(desc(schema.dispatchOrders.createdAt));
    }),

  create: protectedProcedure.use(moduleGuard('dispatch', 'create'))
    .input(z.object({
      orderType: z.enum(["delivery", "pickup"]),
      rentalRequestId: z.number().optional(),
      rentalLineItemId: z.number().optional(),
      rentalFleetId: z.number().optional(),
      customerId: z.number().optional(),
      assignedDriverId: z.number().optional(),
      scheduledDate: z.string().max(30).optional(),
      scheduledTimeSlot: z.string().max(50).optional(),
      pickupAddress: z.string().max(1000).optional(),
      deliveryAddress: z.string().max(1000).optional(),
      pickupWarehouseId: z.number().optional(),
      deliveryWarehouseId: z.number().optional(),
      shippingCost: zMoneyOptional(),
      notes: z.string().max(5000).optional(),
      distance: z.string().max(20).optional(),
      priority: z.string().max(20).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // If rentalRequestId provided, auto-fill from rental
      let fillRentalFleetId: number | null | undefined;
      let fillCustomerId: number | null | undefined;
      let fillPickupAddress: string | undefined;
      let fillDeliveryAddress: string | undefined;
      let fillDeliveryDistanceKm: string | null | undefined;
      if (input.rentalRequestId) {
        const [rental] = await db
          .select({
            customerId: schema.rentalRequests.customerId,
            deliveryAddress: schema.rentalRequests.deliveryAddress,
            deliveryDistanceKm: schema.rentalRequests.deliveryDistanceKm,
          })
          .from(schema.rentalRequests)
          .where(and(eq(schema.rentalRequests.id, input.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
          .limit(1);

        if (rental) {
          fillCustomerId = rental.customerId;
          // Reuse the order's already-computed warehouse↔customer distance (the
          // dispatch leg is the same distance for both delivery and pickup).
          fillDeliveryDistanceKm = rental.deliveryDistanceKm ?? undefined;
          const customerAddress = rental.deliveryAddress || undefined;

          // Resolve which fleet unit this dispatch is for. Multi-item orders
          // carry equipment in line items (parent rentalFleetId is null), so the
          // caller picks a unit via rentalLineItemId / rentalFleetId; single-item
          // orders fall back to the sole unit. The warehouse address comes from
          // the chosen unit's fleet location.
          const { getRentalFulfillmentUnits } = await import("../services/rentalLineItemSync");
          const units = await getRentalFulfillmentUnits(db, input.rentalRequestId);
          const chosen =
            (input.rentalLineItemId != null && units.find(u => u.lineItemId === input.rentalLineItemId)) ||
            (input.rentalFleetId != null && units.find(u => u.rentalFleetId === input.rentalFleetId)) ||
            (units.length === 1 ? units[0] : undefined);

          if (chosen?.rentalFleetId) fillRentalFleetId = chosen.rentalFleetId;
          let warehouseAddress: string | undefined;
          if (chosen?.locationId != null) {
            const [wh] = await db
              .select({ address: schema.warehouses.address })
              .from(schema.warehouses)
              .where(and(eq(schema.warehouses.id, chosen.locationId), isNull(schema.warehouses.deletedAt)))
              .limit(1);
            warehouseAddress = wh?.address || undefined;
          }

          if (input.orderType === "delivery") {
            // Delivery: pick up from warehouse, deliver to customer
            fillPickupAddress = warehouseAddress;
            fillDeliveryAddress = customerAddress;
          } else {
            // Pickup/Return: pick up from customer, deliver back to warehouse
            fillPickupAddress = customerAddress;
            fillDeliveryAddress = warehouseAddress;
          }
        }
      }

      // Auto-fill the trip distance (no manual entry needed): reuse the rental's
      // computed distance, else geocode the effective pickup → delivery leg.
      const effectivePickup = input.pickupAddress || fillPickupAddress;
      const effectiveDelivery = input.deliveryAddress || fillDeliveryAddress;
      let autoDistance: string | undefined;
      if (!input.distance) {
        if (fillDeliveryDistanceKm) {
          autoDistance = fillDeliveryDistanceKm;
        } else if (effectivePickup && effectiveDelivery) {
          const { getDrivingDistanceKm } = await import("../services/shipping");
          const km = await getDrivingDistanceKm(
            { addressLine1: effectivePickup, city: "", province: "", postalCode: "" },
            { addressLine1: effectiveDelivery, city: "", province: "", postalCode: "" },
          );
          if (km != null) autoDistance = km.toFixed(2);
        }
      }

      const [result] = await db.insert(schema.dispatchOrders).values({
        orderType: input.orderType,
        confirmationToken: nanoid(32),
        rentalRequestId: input.rentalRequestId,
        rentalFleetId: input.rentalFleetId || fillRentalFleetId,
        customerId: input.customerId || fillCustomerId,
        assignedDriverId: input.assignedDriverId,
        scheduledDate: input.scheduledDate ? parseCalendarDate(input.scheduledDate) : undefined,
        scheduledTimeSlot: input.scheduledTimeSlot,
        pickupAddress: input.pickupAddress || fillPickupAddress,
        deliveryAddress: input.deliveryAddress || fillDeliveryAddress,
        pickupWarehouseId: input.pickupWarehouseId,
        deliveryWarehouseId: input.deliveryWarehouseId,
        shippingCost: input.shippingCost,
        notes: input.notes,
        distance: input.distance ?? autoDistance,
        priority: input.priority || "normal",
      }).returning();

      return result;
    }),

  updateStatus: protectedProcedure.use(moduleGuard('dispatch', 'update'))
    .input(z.object({
      id: z.number(),
      status: z.enum(["pending", "assigned", "in_transit", "delivered", "completed", "cancelled"]),
      driverNotes: z.string().max(5000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Fetch current dispatch to validate transition
      const [current] = await db
        .select({ status: schema.dispatchOrders.status })
        .from(schema.dispatchOrders)
        .where(and(eq(schema.dispatchOrders.id, input.id), isNull(schema.dispatchOrders.deletedAt)))
        .limit(1);

      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Dispatch order not found" });

      const allowed = DISPATCH_VALID_TRANSITIONS[current.status];
      if (!allowed || !allowed.includes(input.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot transition from "${current.status}" to "${input.status}"`,
        });
      }

      const [result] = await db
        .update(schema.dispatchOrders)
        .set({
          status: input.status,
          updatedAt: new Date(),
          ...(input.driverNotes ? { driverNotes: input.driverNotes } : {}),
          ...((input.status === "completed" || input.status === "delivered") ? { completedDate: new Date() } : {}),
        })
        .where(eq(schema.dispatchOrders.id, input.id))
        .returning();

      if (result?.rentalRequestId && result.rentalFleetId) {
        try {
          await recordAssetProgressEvent(db, {
            eventKey: `dispatch:${result.id}:${result.status}`,
            rentalRequestId: result.rentalRequestId,
            rentalFleetId: result.rentalFleetId,
            eventType: `${result.orderType}_dispatch_${result.status}`,
            source: "dispatch",
            sourceEntityType: "dispatch",
            sourceEntityId: result.id,
            actorUserId: ctx.user?.id,
            createdAt: new Date(),
          });
        } catch (error) {
          logger.error("[Dispatch] Progress event write failed", {
            dispatchId: result.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Auto-update rental status based on dispatch completion
      if (result && result.rentalRequestId && (input.status === "completed" || input.status === "delivered")) {
        try {
          const [rental] = await db
            .select()
            .from(schema.rentalRequests)
            .where(and(eq(schema.rentalRequests.id, result.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
            .limit(1);

          if (rental) {
            // Delivery completed → set rental to active (if approved)
            if (result.orderType === "delivery" && rental.status === "approved") {
              const { transitionRentalStatus } = await import("./rentalRequests.router");
              await transitionRentalStatus(db, {
                rentalId: result.rentalRequestId,
                targetStatus: "active",
                actor: { id: ctx.user?.id, ip: ctx.req?.ip },
              });

              logger.info(`[Dispatch] Delivery completed → rental #${result.rentalRequestId} set to active`);
            }

            // Every pickup completion asks the lifecycle service to re-evaluate
            // the whole order. Multi-unit orders remain active until every
            // pickup and return inspection is complete.
            if (result.orderType === "pickup") {
              const { transitionRentalStatus } = await import("./rentalRequests.router");
              await transitionRentalStatus(db, {
                rentalId: result.rentalRequestId,
                targetStatus: "completed",
                earlyReturn: true,
                actor: { id: ctx.user?.id, ip: ctx.req?.ip },
              });

              logger.info(`[Dispatch] Pickup completed → rental #${result.rentalRequestId} lifecycle re-evaluated`);
            }
          }
        } catch (err) {
          logger.error("[Dispatch] Auto status update failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return result;
    }),

  assignDriver: protectedProcedure.use(moduleGuard('dispatch', 'update'))
    .input(z.object({
      id: z.number(),
      driverId: z.number(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Assigning a driver forces status -> 'assigned'; only allow that from a
      // non-terminal, pre-transit state. Without this guard a 'completed' or
      // 'cancelled' dispatch could be illegally revived (bypasses the state
      // machine that updateStatus enforces).
      const [current] = await db
        .select({ status: schema.dispatchOrders.status })
        .from(schema.dispatchOrders)
        .where(and(eq(schema.dispatchOrders.id, input.id), isNull(schema.dispatchOrders.deletedAt)))
        .limit(1);
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Dispatch order not found" });
      if (current.status !== "pending" && current.status !== "assigned") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot assign a driver to a "${current.status}" dispatch` });
      }

      const [result] = await db
        .update(schema.dispatchOrders)
        .set({
          assignedDriverId: input.driverId,
          status: "assigned",
          updatedAt: new Date(),
        })
        .where(and(eq(schema.dispatchOrders.id, input.id), isNull(schema.dispatchOrders.deletedAt)))
        .returning();

      return result;
    }),

  // Edit dispatch order details (only pending/assigned)
  update: protectedProcedure.use(moduleGuard('dispatch', 'update'))
    .input(z.object({
      id: z.number(),
      scheduledDate: z.string().max(30).optional(),
      scheduledTimeSlot: z.string().max(50).optional(),
      pickupAddress: z.string().max(1000).optional(),
      deliveryAddress: z.string().max(1000).optional(),
      assignedDriverId: z.number().nullable().optional(),
      notes: z.string().max(5000).optional(),
      priority: z.string().max(20).optional(),
      shippingCost: zMoneyOptional(),
      distance: z.string().max(20).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [current] = await db
        .select()
        .from(schema.dispatchOrders)
        .where(and(eq(schema.dispatchOrders.id, input.id), isNull(schema.dispatchOrders.deletedAt)))
        .limit(1);

      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Dispatch order not found" });

      // Only allow editing pending or assigned orders
      if (!["pending", "assigned"].includes(current.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot edit dispatch order in "${current.status}" status. Only pending or assigned orders can be modified.`,
        });
      }

      const { id, ...fields } = input;
      const updateData: Record<string, unknown> = { updatedAt: new Date() };

      if (fields.scheduledDate !== undefined) updateData.scheduledDate = parseCalendarDate(fields.scheduledDate);
      if (fields.scheduledTimeSlot !== undefined) updateData.scheduledTimeSlot = fields.scheduledTimeSlot;
      if (fields.pickupAddress !== undefined) updateData.pickupAddress = fields.pickupAddress;
      if (fields.deliveryAddress !== undefined) updateData.deliveryAddress = fields.deliveryAddress;
      if (fields.notes !== undefined) updateData.notes = fields.notes;
      if (fields.priority !== undefined) updateData.priority = fields.priority;
      if (fields.shippingCost !== undefined) updateData.shippingCost = fields.shippingCost;
      if (fields.distance !== undefined) updateData.distance = fields.distance;

      // Driver change: auto-assign status if setting a driver on pending order
      if (fields.assignedDriverId !== undefined) {
        updateData.assignedDriverId = fields.assignedDriverId;
        if (fields.assignedDriverId && current.status === "pending") {
          updateData.status = "assigned";
        }
      }

      const [result] = await db
        .update(schema.dispatchOrders)
        .set(updateData)
        .where(eq(schema.dispatchOrders.id, id))
        .returning();

      // Audit log
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      const trackFields = ["scheduledDate", "pickupAddress", "deliveryAddress", "assignedDriverId", "notes", "priority", "shippingCost", "distance", "scheduledTimeSlot"] as const;
      for (const field of trackFields) {
        if (fields[field] !== undefined && String(fields[field]) !== String(current[field] ?? "")) {
          changes[field] = { old: current[field], new: fields[field] };
        }
      }
      if (Object.keys(changes).length > 0) {
        await logAudit({
          userId: ctx.user?.id,
          action: "update",
          entityType: "dispatch",
          entityId: id,
          changes,
          metadata: { orderType: current.orderType },
          ipAddress: ctx.req?.ip,
        });
      }

      return result;
    }),

  generatePDF: protectedProcedure.use(moduleGuard('dispatch', 'read'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const { generateDispatchPDF } = await import("../services/dispatchPDF");
      return generateDispatchPDF(input.id);
    }),

  delete: protectedProcedure.use(moduleGuard('dispatch', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [order] = await db
        .select()
        .from(schema.dispatchOrders)
        .where(and(eq(schema.dispatchOrders.id, input.id), isNull(schema.dispatchOrders.deletedAt)))
        .limit(1);

      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Dispatch order not found" });

      if (order.status !== "completed" && order.status !== "cancelled") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Cannot delete active dispatch order. Only completed or cancelled orders can be deleted." });
      }

      await db.update(schema.dispatchOrders).set({ deletedAt: new Date() }).where(eq(schema.dispatchOrders.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "dispatch",
        entityId: input.id,
        metadata: { orderType: order.orderType },
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  // ── Field Staff endpoints ──────────────────────────────────────────

  myDeliveries: fieldStaffProcedure
    .input(z.object({
      status: z.enum(["pending", "assigned", "in_transit", "delivered", "completed", "cancelled"]).optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [];

      // Look up the driver record linked to this user
      const [myDriver] = await db.select({ id: schema.drivers.id })
        .from(schema.drivers)
        .where(and(eq(schema.drivers.userId, ctx.user.id), isNull(schema.drivers.deletedAt)))
        .limit(1);
      if (!myDriver) return [];

      const conditions = [
        isNull(schema.dispatchOrders.deletedAt),
        eq(schema.dispatchOrders.assignedDriverId, myDriver.id),
      ];
      if (input?.status) conditions.push(eq(schema.dispatchOrders.status, input.status));

      return db
        .select({
          dispatch_orders: schema.dispatchOrders,
          customers: { id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone },
          rental_fleet: { id: schema.rentalFleet.id, brand: schema.rentalFleet.brand, model: schema.rentalFleet.model },
          rental_request: {
            id: schema.rentalRequests.id,
            startDate: schema.rentalRequests.startDate,
            endDate: schema.rentalRequests.endDate,
            deliveryMethod: schema.rentalRequests.deliveryMethod,
          },
        })
        .from(schema.dispatchOrders)
        .leftJoin(schema.rentalFleet, and(eq(schema.dispatchOrders.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.customers, and(eq(schema.dispatchOrders.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .leftJoin(schema.rentalRequests, and(eq(schema.dispatchOrders.rentalRequestId, schema.rentalRequests.id), isNull(schema.rentalRequests.deletedAt)))
        .where(and(...conditions))
        .orderBy(desc(schema.dispatchOrders.createdAt));
    }),

  // ── Public endpoint for driver delivery confirmation (no auth) ────
  // Keyed on an unguessable confirmationToken, NOT the enumerable integer id,
  // so an attacker can't walk ids 1..N to forge customer signatures. Rate
  // limited to blunt token-guessing / replay.
  confirmDelivery: publicProcedure
    .input(z.object({
      token: z.string().min(16),
      customerSignature: z.string().min(1, "Signature is required"),
      driverNotes: z.string().max(5000).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      if (!checkRateLimit(confirmDeliveryRateLimit, input.token, 60_000, 5)) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many attempts, please wait a moment." });
      }

      const [current] = await db
        .select()
        .from(schema.dispatchOrders)
        .where(and(eq(schema.dispatchOrders.confirmationToken, input.token), isNull(schema.dispatchOrders.deletedAt)))
        .limit(1);

      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Dispatch order not found" });

      if (!["in_transit", "delivered"].includes(current.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Dispatch order is in "${current.status}" status and cannot be confirmed. Only in_transit or delivered orders can be confirmed.`,
        });
      }

      const now = new Date();
      const [result] = await db
        .update(schema.dispatchOrders)
        .set({
          customerConfirmedAt: now,
          customerConfirmationSignature: input.customerSignature,
          driverConfirmedAt: now,
          status: "completed",
          completedDate: now,
          updatedAt: now,
          ...(input.driverNotes ? { driverNotes: input.driverNotes } : {}),
        })
        // Guard the transition in the UPDATE itself: only a still-unconfirmed
        // (in_transit/delivered) order matches, so a concurrent double-submit of
        // the same token confirms exactly once and can't overwrite the first
        // confirmation's timestamps/signature.
        .where(and(
          eq(schema.dispatchOrders.id, current.id),
          sql`${schema.dispatchOrders.status} in ('in_transit','delivered')`,
        ))
        .returning();

      if (!result) {
        // A concurrent request already confirmed it — treat as success (idempotent).
        return { success: true, alreadyConfirmed: true };
      }

      // Update linked rental's deliveryInspectionCompleted if this is a delivery order
      if (result && result.rentalRequestId && result.orderType === "delivery") {
        try {
          // Load the rental first so we can preserve an existing signed time and
          // decide on activation below.
          const [rental] = await db
            .select()
            .from(schema.rentalRequests)
            .where(and(eq(schema.rentalRequests.id, result.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
            .limit(1);

          await db.update(schema.rentalRequests).set({
            deliveryInspectionCompleted: true,
            // Propagate customer signature to rental for contract PDF.
            // Keep the original contractSignedAt if already set (re-confirmations
            // must not overwrite it) — done in JS rather than a sql`COALESCE(..)`
            // fragment, because binding a JS Date inside raw sql serializes it to
            // a locale string under postgres-js (prepare:false) and crashes.
            customerSignature: input.customerSignature,
            contractSignedAt: rental?.contractSignedAt ?? now,
            updatedAt: now,
          }).where(eq(schema.rentalRequests.id, result.rentalRequestId));

          // Also activate rental if approved
          if (rental && rental.status === "approved") {
            const { transitionRentalStatus } = await import("./rentalRequests.router");
            await transitionRentalStatus(db, {
              rentalId: result.rentalRequestId,
              targetStatus: "active",
            });

            logger.info(`[Dispatch] Delivery confirmed → rental #${result.rentalRequestId} set to active`);
          }
        } catch (err) {
          logger.error("[Dispatch] Failed to update rental after delivery confirmation", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { success: true };
    }),

  // ── Public endpoint to get dispatch info for confirmation page ────
  getForConfirmation: publicProcedure
    .input(z.object({ token: z.string().min(16) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const [row] = await db
        .select({
          dispatch_orders: schema.dispatchOrders,
          customers: {
            id: schema.customers.id,
            name: schema.customers.name,
          },
          rental_fleet: {
            id: schema.rentalFleet.id,
            brand: schema.rentalFleet.brand,
            model: schema.rentalFleet.model,
          },
        })
        .from(schema.dispatchOrders)
        .leftJoin(schema.rentalFleet, and(eq(schema.dispatchOrders.rentalFleetId, schema.rentalFleet.id), isNull(schema.rentalFleet.deletedAt)))
        .leftJoin(schema.customers, and(eq(schema.dispatchOrders.customerId, schema.customers.id), isNull(schema.customers.deletedAt)))
        .where(and(eq(schema.dispatchOrders.confirmationToken, input.token), isNull(schema.dispatchOrders.deletedAt)))
        .limit(1);

      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Dispatch order not found" });

      return row;
    }),

  updateMyStatus: fieldStaffProcedure
    .input(z.object({
      id: z.number(),
      status: z.enum(["in_transit", "delivered", "completed"]),
      driverNotes: z.string().max(5000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Look up the driver record linked to this user
      const [myDriver] = await db.select({ id: schema.drivers.id })
        .from(schema.drivers)
        .where(and(eq(schema.drivers.userId, ctx.user.id), isNull(schema.drivers.deletedAt)))
        .limit(1);
      if (!myDriver) throw new TRPCError({ code: "NOT_FOUND", message: "No driver record linked to your account" });

      const [current] = await db
        .select()
        .from(schema.dispatchOrders)
        .where(and(eq(schema.dispatchOrders.id, input.id), eq(schema.dispatchOrders.assignedDriverId, myDriver.id), isNull(schema.dispatchOrders.deletedAt)))
        .limit(1);

      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Dispatch order not found or not assigned to you" });

      if (current.rentalRequestId && current.rentalFleetId) {
        await assertFleetRentalPairUnambiguous(db, current.rentalRequestId, current.rentalFleetId);
      }

      const allowed = DISPATCH_VALID_TRANSITIONS[current.status];
      if (!allowed || !allowed.includes(input.status)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Cannot transition from "${current.status}" to "${input.status}"` });
      }

      const [result] = await db
        .update(schema.dispatchOrders)
        .set({
          status: input.status,
          updatedAt: new Date(),
          ...(input.driverNotes ? { driverNotes: input.driverNotes } : {}),
          ...((input.status === "completed" || input.status === "delivered") ? { completedDate: new Date() } : {}),
        })
        // Re-assert driver ownership in the UPDATE itself (not just the SELECT
        // above) so a concurrent reassignment can't let a driver mutate a
        // dispatch that is no longer theirs (TOCTOU/IDOR).
        .where(and(eq(schema.dispatchOrders.id, input.id), eq(schema.dispatchOrders.assignedDriverId, myDriver.id)))
        .returning();

      if (!result) throw new TRPCError({ code: "CONFLICT", message: "Dispatch reassigned — refresh and try again" });

      if (result.rentalRequestId && result.rentalFleetId) {
        try {
          await recordAssetProgressEvent(db, {
            eventKey: `dispatch:${result.id}:${result.status}`,
            rentalRequestId: result.rentalRequestId,
            rentalFleetId: result.rentalFleetId,
            eventType: `${result.orderType}_dispatch_${result.status}`,
            source: "dispatch",
            sourceEntityType: "dispatch",
            sourceEntityId: result.id,
            actorUserId: ctx.user.id,
            createdAt: new Date(),
          });
        } catch (error) {
          logger.error("[Dispatch] Progress event write failed", {
            dispatchId: result.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Auto-update rental status based on dispatch completion
      if (result && result.rentalRequestId && (input.status === "completed" || input.status === "delivered")) {
        try {
          const [rental] = await db
            .select()
            .from(schema.rentalRequests)
            .where(and(eq(schema.rentalRequests.id, result.rentalRequestId), isNull(schema.rentalRequests.deletedAt)))
            .limit(1);

          if (rental) {
            if (result.orderType === "delivery" && rental.status === "approved") {
              const { transitionRentalStatus } = await import("./rentalRequests.router");
              await transitionRentalStatus(db, {
                rentalId: result.rentalRequestId,
                targetStatus: "active",
                actor: { id: ctx.user?.id, ip: ctx.req?.ip },
              });

              logger.info(`[Dispatch] Field delivery completed → rental #${result.rentalRequestId} set to active`);
            }

            if (result.orderType === "pickup") {
              const { transitionRentalStatus } = await import("./rentalRequests.router");
              await transitionRentalStatus(db, {
                rentalId: result.rentalRequestId,
                targetStatus: "completed",
                earlyReturn: true,
                actor: { id: ctx.user?.id, ip: ctx.req?.ip },
              });

              logger.info(`[Dispatch] Field pickup completed → rental #${result.rentalRequestId} lifecycle re-evaluated`);
            }
          }
        } catch (err) {
          logger.error("[Dispatch] Auto status update failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return result;
    }),
});
