import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, superAdminProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, isNotNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { i18nError } from "../_core/i18nError";

const entityTypeEnum = z.enum([
  "user", "customer", "warehouse", "fleet", "rental", "inspection", "dispatch", "invoice", "quotation",
]);

type EntityType = z.infer<typeof entityTypeEnum>;

// Map entity types to their SQL table names (all controlled, no injection risk)
const TABLE_NAME_MAP: Record<EntityType, string> = {
  user: "users",
  customer: "customers",
  warehouse: "warehouses",
  fleet: "rental_fleet",
  rental: "rental_requests",
  inspection: "inspections",
  dispatch: "dispatch_orders",
  invoice: "invoices",
  quotation: "quotations",
};

// Child rows that must be hard-deleted before the parent.
// Migration 095 swapped these FKs from CASCADE to RESTRICT, so the recycle-bin
// purge has to clean them up explicitly. Each entry: { table, fkColumn }.
//
// This map is deliberately NOT exhaustive over every RESTRICT FK. Tables that
// hold financial or audit history (payments, login_sessions, rental_prepayments,
// rental_charges, …) are RESTRICT precisely so they are NOT purged — listing
// them here would make the purge destroy the very records the constraint
// protects. When one of them blocks a delete, that is the design working; the
// 23503 is translated into a readable reason below instead.
export const CHILD_PURGE_MAP: Partial<Record<EntityType, Array<{ table: string; fkColumn: string }>>> = {
  rental: [{ table: "rental_line_items", fkColumn: "rentalRequestId" }],
  quotation: [{ table: "quotation_line_items", fkColumn: "quotationId" }],
  invoice: [{ table: "invoice_line_items", fkColumn: "invoiceId" }],
};

/** Postgres foreign-key violation (SQLSTATE 23503), as surfaced by postgres-js. */
type PgFkViolation = { code: string; table_name?: string; constraint_name?: string; detail?: string };
export function isForeignKeyViolation(err: unknown): err is PgFkViolation {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23503";
}

// Why each RESTRICT-protected child blocks a purge, in words an operator can act
// on. Keyed by the referencing table. An unlisted table still degrades to a
// message naming the table rather than leaking a raw SQLSTATE at the user.
const BLOCKER_REASONS: Record<string, string> = {
  rental_prepayments: "recorded customer payments",
  rental_charges: "credit-order charges",
  payments: "recorded payments",
  login_sessions: "login history",
  rental_lifecycle_effects: "lifecycle audit records",
  rental_rolling_terms: "rolling-rental terms",
  rental_asset_return_operations: "asset return operations",
  invoice_line_items: "invoice line items",
  rental_line_items: "rental line items",
  quotation_line_items: "quotation line items",
  work_order_parts: "work-order parts",
};

// English wording for the thing being deleted. Kept in lockstep with the
// errors.purgeSubject.* keys in zh/en common.json — the English message is the
// fallback for clients that get no translation hint, so the two must agree.
const SUBJECT_LABELS: Record<EntityType | "all", string> = {
  user: "this user",
  customer: "this customer",
  warehouse: "this warehouse",
  fleet: "this asset",
  rental: "this rental",
  inspection: "this inspection",
  dispatch: "this dispatch order",
  invoice: "this invoice",
  quotation: "this quotation",
  all: "everything in the recycle bin",
};

/** Resolve the blocking child table from whichever fields postgres-js populated. */
function blockerTable(err: PgFkViolation): string | undefined {
  if (err.table_name && BLOCKER_REASONS[err.table_name]) return err.table_name;
  // Constraint names are conventionally "<table>_<column>_fkey".
  if (err.constraint_name) {
    const hit = Object.keys(BLOCKER_REASONS).find((t) => err.constraint_name!.startsWith(`${t}_`));
    if (hit) return hit;
  }
  return err.table_name || undefined;
}

/**
 * Turn a RESTRICT 23503 into a reason a human can act on.
 *
 * Failure path only: this runs after the database has already refused the
 * delete, so it cannot block an operation that would otherwise have succeeded.
 * Anything that is not a 23503 is rethrown untouched.
 */
export function rethrowAsReadable(err: unknown, subject: EntityType | "all"): never {
  if (!isForeignKeyViolation(err)) throw err;
  const table = blockerTable(err);
  const reason = table ? BLOCKER_REASONS[table] : undefined;
  const what = reason && table ? `${reason} (${table})` : table ? `linked records in ${table}` : "linked records";
  const message =
    `Cannot permanently delete ${SUBJECT_LABELS[subject]}: it still has ${what}. ` +
    `Records that carry financial or audit history are protected from permanent deletion.`;

  // Only claim a translation when both halves are actually translatable. An
  // unknown blocker (a RESTRICT FK added later, not yet listed above) has no
  // errors.purgeBlocker.* key, and i18next would render the key itself rather
  // than words — worse than the English fallback. So: hint only when known.
  if (table && reason) {
    throw i18nError({
      code: "PRECONDITION_FAILED",
      message,
      i18nKey: "errors.purgeBlocked",
      i18nParams: { subject, blocker: table },
      original: err,
    });
  }

  throw new TRPCError({ code: "PRECONDITION_FAILED", message, cause: err });
}

export const recycleBinRouter = router({
  list: protectedProcedure.use(moduleGuard('settings', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];

    const results: Array<{
      entityType: string;
      entityId: number;
      identifier: string;
      deletedAt: Date;
    }> = [];

    // Use Promise.allSettled so one table failure doesn't break the entire recycle bin
    const queries = [
      { type: "user", query: db.select({ id: schema.users.id, identifier: schema.users.username, deletedAt: schema.users.deletedAt }).from(schema.users).where(isNotNull(schema.users.deletedAt)) },
      { type: "customer", query: db.select({ id: schema.customers.id, identifier: schema.customers.name, deletedAt: schema.customers.deletedAt }).from(schema.customers).where(isNotNull(schema.customers.deletedAt)) },
      { type: "warehouse", query: db.select({ id: schema.warehouses.id, identifier: schema.warehouses.name, deletedAt: schema.warehouses.deletedAt }).from(schema.warehouses).where(isNotNull(schema.warehouses.deletedAt)) },
      { type: "fleet", query: db.select({ id: schema.rentalFleet.id, brand: schema.rentalFleet.brand, model: schema.rentalFleet.model, deletedAt: schema.rentalFleet.deletedAt }).from(schema.rentalFleet).where(isNotNull(schema.rentalFleet.deletedAt)) },
      { type: "rental", query: db.select({ id: schema.rentalRequests.id, identifier: schema.rentalRequests.customerName, deletedAt: schema.rentalRequests.deletedAt }).from(schema.rentalRequests).where(isNotNull(schema.rentalRequests.deletedAt)) },
      { type: "inspection", query: db.select({ id: schema.inspections.id, identifier: schema.inspections.type, deletedAt: schema.inspections.deletedAt }).from(schema.inspections).where(isNotNull(schema.inspections.deletedAt)) },
      { type: "dispatch", query: db.select({ id: schema.dispatchOrders.id, identifier: schema.dispatchOrders.orderType, deletedAt: schema.dispatchOrders.deletedAt }).from(schema.dispatchOrders).where(isNotNull(schema.dispatchOrders.deletedAt)) },
      { type: "invoice", query: db.select({ id: schema.invoices.id, identifier: schema.invoices.invoiceNumber, deletedAt: schema.invoices.deletedAt }).from(schema.invoices).where(isNotNull(schema.invoices.deletedAt)) },
      { type: "quotation", query: db.select({ id: schema.quotations.id, identifier: schema.quotations.quotationNumber, deletedAt: schema.quotations.deletedAt }).from(schema.quotations).where(isNotNull(schema.quotations.deletedAt)) },
    ] as const;

    const settled = await Promise.allSettled(queries.map(q => q.query));

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status !== "fulfilled") continue; // skip failed tables silently
      const type = queries[i].type;
      const rows = outcome.value as Array<{
        id: number;
        identifier?: string | null;
        brand?: string | null;
        model?: string | null;
        deletedAt: Date | null;
      }>;
      for (const row of rows) {
        const identifier = type === "fleet"
          ? `${row.brand} ${row.model}`
          : (row.identifier || `${type} #${row.id}`);
        results.push({ entityType: type, entityId: row.id, identifier, deletedAt: row.deletedAt! });
      }
    }

    results.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());
    return results;
  }),

  restore: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({ entityType: entityTypeEnum, entityId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const tableName = TABLE_NAME_MAP[input.entityType];

      // Verify it actually exists and is soft-deleted — otherwise the UPDATE
      // matches 0 rows but still "succeeds", logging a false restore audit entry
      // for a record that never existed.
      const existing: Record<string, unknown>[] = await db.execute(
        sql.raw(`SELECT id FROM "${tableName}" WHERE id = ${Number(input.entityId)} AND "deletedAt" IS NOT NULL LIMIT 1`)
      );
      if (!existing.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Record not found or not in recycle bin" });
      }

      // Safe: tableName is from our controlled map, entityId is parameterized
      await db.execute(
        sql.raw(`UPDATE "${tableName}" SET "deletedAt" = NULL WHERE id = ${Number(input.entityId)}`)
      );

      await logAudit({
        userId: ctx.user?.id,
        action: "restore",
        entityType: input.entityType,
        entityId: input.entityId,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  permanentDelete: superAdminProcedure
    .input(z.object({ entityType: entityTypeEnum, entityId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const tableName = TABLE_NAME_MAP[input.entityType];

      // Verify it's already soft-deleted
      const rows: Record<string, unknown>[] = await db.execute(
        sql.raw(`SELECT id FROM "${tableName}" WHERE id = ${Number(input.entityId)} AND "deletedAt" IS NOT NULL LIMIT 1`)
      );

      if (!rows.length) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Record not found or not in recycle bin" });
      }

      // Purge child rows first — FKs are RESTRICT, not CASCADE (see migration 095).
      // Wrapped in a transaction: if the parent DELETE trips a RESTRICT FK we do
      // not yet know about, the child deletes roll back too instead of leaving
      // permanently orphaned/destroyed child rows behind.
      const children = CHILD_PURGE_MAP[input.entityType] ?? [];
      try {
        await db.transaction(async (tx) => {
          for (const child of children) {
            await tx.execute(
              sql.raw(`DELETE FROM "${child.table}" WHERE "${child.fkColumn}" = ${Number(input.entityId)}`)
            );
          }

          await tx.execute(
            sql.raw(`DELETE FROM "${tableName}" WHERE id = ${Number(input.entityId)}`)
          );
        });
      } catch (err) {
        rethrowAsReadable(err, input.entityType);
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "permanent_delete",
        entityType: input.entityType,
        entityId: input.entityId,
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),

  emptyAll: superAdminProcedure
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      // Order matters for FK constraints (invoices/quotations reference rental, customer)
      const tableOrder: EntityType[] = [
        "quotation", "invoice", "dispatch", "inspection", "rental", "fleet", "customer", "warehouse", "user",
      ];

      // Whole sweep runs in one transaction: if any parent DELETE trips a RESTRICT
      // FK, the entire batch rolls back so the operation fails cleanly instead of
      // leaving already-purged child rows destroyed with their parents intact.
      let totalDeleted: number;
      try {
        totalDeleted = await db.transaction(async (tx) => {
          let deleted = 0;

          for (const entityType of tableOrder) {
            const tableName = TABLE_NAME_MAP[entityType];

            // Purge children of soft-deleted parents first (FKs are RESTRICT post-095).
            const children = CHILD_PURGE_MAP[entityType] ?? [];
            for (const child of children) {
              await tx.execute(
                sql.raw(`DELETE FROM "${child.table}" WHERE "${child.fkColumn}" IN (SELECT id FROM "${tableName}" WHERE "deletedAt" IS NOT NULL)`)
              );
            }

            const result: Record<string, unknown>[] = await tx.execute(
              sql.raw(`DELETE FROM "${tableName}" WHERE "deletedAt" IS NOT NULL RETURNING id`)
            );
            deleted += result.length;
          }

          return deleted;
        });
      } catch (err) {
        rethrowAsReadable(err, "all");
      }

      await logAudit({
        userId: ctx.user?.id,
        action: "empty_recycle_bin",
        entityType: "system",
        metadata: { totalDeleted },
        ipAddress: ctx.req?.ip,
      });

      return { success: true, totalDeleted };
    }),
});
