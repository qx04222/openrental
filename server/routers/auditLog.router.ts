import { z } from "zod";
import { router, protectedProcedure, moduleGuard, superAdminProcedure } from "../_core/trpc";
import { getDb, eq, and, gte, lte, desc, sql, ilike, or, inArray } from "../db";
import * as schema from "../../drizzle/schema";

/**
 * Audit entities that hang off an order rather than being the order itself.
 * Their audit rows carry the owning order in metadata.rentalRequestId, which is
 * how getByRental pulls them onto the order's change-history tab. Add new
 * child-entity types here when a module starts writing audit rows for them —
 * otherwise the evidence is written but never shown.
 */
const RENTAL_CHILD_ENTITY_TYPES = [
  "rental_charge",
  "rental_prepayment",
  "damage_claim",
  "work_order_part",
  "work_order_labor",
  "downtime_record",
] as const;

export const auditLogRouter = router({
  list: protectedProcedure.use(moduleGuard('audit_log', 'read'))
    .input(z.object({
      entityType: z.string().optional(),
      userId: z.number().optional(),
      action: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().min(1).max(500).optional(),
      offset: z.number().min(0).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { logs: [], total: 0 };

      const conditions = [];
      if (input?.entityType) {
        conditions.push(eq(schema.auditLogs.entityType, input.entityType));
      }
      if (input?.userId) {
        conditions.push(eq(schema.auditLogs.userId, input.userId));
      }
      if (input?.action) {
        conditions.push(eq(schema.auditLogs.action, input.action));
      }
      if (input?.startDate) {
        conditions.push(gte(schema.auditLogs.createdAt, new Date(input.startDate)));
      }
      if (input?.endDate) {
        conditions.push(lte(schema.auditLogs.createdAt, new Date(input.endDate)));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const limit = input?.limit || 100;
      const offset = input?.offset || 0;

      const logs = await db
        .select({
          id: schema.auditLogs.id,
          userId: schema.auditLogs.userId,
          action: schema.auditLogs.action,
          entityType: schema.auditLogs.entityType,
          entityId: schema.auditLogs.entityId,
          changes: schema.auditLogs.changes,
          metadata: schema.auditLogs.metadata,
          ipAddress: schema.auditLogs.ipAddress,
          createdAt: schema.auditLogs.createdAt,
          userName: schema.users.name,
          userUsername: schema.users.username,
        })
        .from(schema.auditLogs)
        .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
        .where(where)
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(limit)
        .offset(offset);

      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.auditLogs)
        .where(where);

      return { logs, total: countResult?.count ?? 0 };
    }),

  search: superAdminProcedure
    .input(z.object({
      userId: z.number().optional(),
      entityType: z.string().optional(),
      action: z.string().optional(),
      entityId: z.number().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().min(1).max(200).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { rows: [], total: 0, facets: { users: [], actions: [], entityTypes: [] } };

      const conditions: unknown[] = [];
      if (input.userId !== undefined) {
        conditions.push(eq(schema.auditLogs.userId, input.userId));
      }
      if (input.entityType) {
        conditions.push(eq(schema.auditLogs.entityType, input.entityType));
      }
      if (input.action) {
        conditions.push(eq(schema.auditLogs.action, input.action));
      }
      if (input.entityId !== undefined) {
        conditions.push(eq(schema.auditLogs.entityId, input.entityId));
      }
      if (input.dateFrom) {
        conditions.push(gte(schema.auditLogs.createdAt, new Date(input.dateFrom)));
      }
      if (input.dateTo) {
        conditions.push(lte(schema.auditLogs.createdAt, new Date(input.dateTo)));
      }
      if (input.query) {
        const term = `%${input.query}%`;
        conditions.push(or(
          ilike(schema.auditLogs.ipAddress, term),
          ilike(schema.auditLogs.changes, term),
        ));
      }

      const where = conditions.length > 0 ? and(...(conditions as Parameters<typeof and>)) : undefined;

      const rows = await db
        .select({
          id: schema.auditLogs.id,
          userId: schema.auditLogs.userId,
          action: schema.auditLogs.action,
          entityType: schema.auditLogs.entityType,
          entityId: schema.auditLogs.entityId,
          changes: schema.auditLogs.changes,
          ipAddress: schema.auditLogs.ipAddress,
          createdAt: schema.auditLogs.createdAt,
          userName: schema.users.name,
          userUsername: schema.users.username,
        })
        .from(schema.auditLogs)
        .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
        .where(where)
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.auditLogs)
        .where(where);

      const total = countResult?.count ?? 0;

      // Facets: top 10 of each over the filtered set
      const userFacets = await db
        .select({
          id: schema.auditLogs.userId,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.auditLogs)
        .where(where)
        .groupBy(schema.auditLogs.userId)
        .orderBy(desc(sql`count(*)`))
        .limit(10);

      const actionFacets = await db
        .select({
          action: schema.auditLogs.action,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.auditLogs)
        .where(where)
        .groupBy(schema.auditLogs.action)
        .orderBy(desc(sql`count(*)`))
        .limit(10);

      const entityTypeFacets = await db
        .select({
          type: schema.auditLogs.entityType,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.auditLogs)
        .where(where)
        .groupBy(schema.auditLogs.entityType)
        .orderBy(desc(sql`count(*)`))
        .limit(10);

      return {
        rows,
        total,
        facets: {
          users: userFacets.map((u) => ({ id: u.id, count: u.count })),
          actions: actionFacets.map((a) => ({ action: a.action, count: a.count })),
          entityTypes: entityTypeFacets.map((e) => ({ type: e.type, count: e.count })),
        },
      };
    }),

  getByEntity: protectedProcedure.use(moduleGuard('audit_log', 'read'))
    .input(z.object({
      entityType: z.string(),
      entityId: z.number(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.auditLogs.id,
          userId: schema.auditLogs.userId,
          action: schema.auditLogs.action,
          entityType: schema.auditLogs.entityType,
          entityId: schema.auditLogs.entityId,
          changes: schema.auditLogs.changes,
          metadata: schema.auditLogs.metadata,
          ipAddress: schema.auditLogs.ipAddress,
          createdAt: schema.auditLogs.createdAt,
          userName: schema.users.name,
          userUsername: schema.users.username,
        })
        .from(schema.auditLogs)
        .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
        .where(and(
          eq(schema.auditLogs.entityType, input.entityType),
          eq(schema.auditLogs.entityId, input.entityId),
        ))
        .orderBy(desc(schema.auditLogs.createdAt));
    }),

  // Per-order change history: a rental's audit trail. Covers both entityType
  // spellings ("rental" and the legacy "rental_request" used by a couple of
  // older write sites) so no historical change is dropped from the view.
  getByRental: protectedProcedure.use(moduleGuard('audit_log', 'read'))
    .input(z.object({ rentalId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.auditLogs.id,
          userId: schema.auditLogs.userId,
          action: schema.auditLogs.action,
          entityType: schema.auditLogs.entityType,
          entityId: schema.auditLogs.entityId,
          changes: schema.auditLogs.changes,
          metadata: schema.auditLogs.metadata,
          ipAddress: schema.auditLogs.ipAddress,
          createdAt: schema.auditLogs.createdAt,
          userName: schema.users.name,
          userUsername: schema.users.username,
        })
        .from(schema.auditLogs)
        .leftJoin(schema.users, eq(schema.auditLogs.userId, schema.users.id))
        .where(and(
          or(
            // The order itself: keyed by entityId.
            and(
              inArray(schema.auditLogs.entityType, ["rental", "rental_request"]),
              eq(schema.auditLogs.entityId, input.rentalId),
            ),
            // Rows that belong to the order — charges, payments, work-order
            // lines. Their entityId is the child's own id, so they are matched
            // on the rentalRequestId their writer put in metadata. Without this
            // the audit rows exist but never reach the change-history tab, which
            // is where anyone actually looks for them.
            and(
              inArray(schema.auditLogs.entityType, RENTAL_CHILD_ENTITY_TYPES),
              sql`(${schema.auditLogs.metadata}::jsonb ->> 'rentalRequestId') = ${String(input.rentalId)}`,
            ),
          ),
        ))
        .orderBy(desc(schema.auditLogs.createdAt));
    }),
});
