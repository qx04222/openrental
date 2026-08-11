import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, isNull, sql } from "../db";
import * as schema from "../../drizzle/schema";
import { logAudit } from "../services/auditLog";
import { logger } from "../_core/logger";

/**
 * Collections — the daily call list for money already owed.
 *
 * Why a page and not a notification: 94 of 104 customers have no email address
 * on file, and the SMS channel is deliberately switched off. Nothing automated
 * reaches these people, so the chase is a human phoning them. Before this page
 * the system knew exactly who was late and told nobody: `customers`.
 * `lastContactedAt` was NULL on all 104 rows, so staff had no way to know who
 * had already been called or what the customer said.
 *
 * Everything here is additive. The list is a read-only aggregate, and a contact
 * is recorded in `customer_interactions` — a table that already existed with
 * exactly the right shape and zero rows.
 *
 * Guarded on `invoices`: this is receivables data.
 */

/** One outstanding invoice on a customer's row. */
interface OverdueInvoiceRow {
  id: number;
  invoiceNumber: string | null;
  balanceDue: string;
  dueDate: Date | null;
  daysOverdue: number;
}

export const collectionsRouter = router({
  /**
   * Customers with overdue money, worst first.
   *
   * "Worst" is owed × days late, not either alone: a $200 invoice ninety days
   * late and a $9,000 invoice two days late are both worth a call today, and
   * sorting on one dimension buries the other.
   */
  list: protectedProcedure.use(moduleGuard("invoices", "read"))
    .query(async () => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const rows = await db.execute(sql`
        WITH overdue AS (
          SELECT
            COALESCE(i."customerId", r."customerId") AS customer_id,
            i.id,
            i."invoiceNumber",
            i."balanceDue"::numeric AS balance_due,
            i."dueDate",
            (CURRENT_DATE - i."dueDate"::date) AS days_overdue
          FROM invoices i
          LEFT JOIN rental_requests r ON r.id = i."rentalId"
          WHERE i."deletedAt" IS NULL
            AND i.status IN ('sent', 'partial', 'overdue')
            AND i."balanceDue"::numeric > 0
            AND i."dueDate" IS NOT NULL
            AND i."dueDate"::date < CURRENT_DATE
        ),
        latest_contact AS (
          SELECT DISTINCT ON ("customerId")
            "customerId", type::text AS type, summary, "createdAt"
          FROM customer_interactions
          ORDER BY "customerId", "createdAt" DESC
        )
        SELECT
          c.id                                AS customer_id,
          c.name,
          c.company,
          c.phone,
          c.email,
          c."lastContactedAt",
          c."nextFollowUp",
          c."followUpNotes",
          lc.type                             AS last_contact_type,
          lc.summary                          AS last_contact_summary,
          SUM(o.balance_due)                  AS total_owed,
          COUNT(*)                            AS invoice_count,
          MAX(o.days_overdue)                 AS oldest_days_overdue,
          json_agg(
            json_build_object(
              'id', o.id,
              'invoiceNumber', o."invoiceNumber",
              'balanceDue', o.balance_due,
              'dueDate', o."dueDate",
              'daysOverdue', o.days_overdue
            ) ORDER BY o.days_overdue DESC
          )                                   AS invoices
        FROM overdue o
        JOIN customers c ON c.id = o.customer_id AND c."deletedAt" IS NULL
        LEFT JOIN latest_contact lc ON lc."customerId" = c.id
        GROUP BY c.id, c.name, c.company, c.phone, c.email, c."lastContactedAt",
                 c."nextFollowUp", c."followUpNotes", lc.type, lc.summary
        ORDER BY SUM(o.balance_due) * MAX(o.days_overdue) DESC
      `) as unknown as Array<Record<string, unknown>>;

      const now = Date.now();
      const customers = rows.map((row) => {
        const nextFollowUp = row.nextFollowUp ? new Date(row.nextFollowUp as string) : null;
        return {
          customerId: Number(row.customer_id),
          name: (row.name as string) ?? "",
          company: (row.company as string) ?? null,
          phone: (row.phone as string) ?? null,
          email: (row.email as string) ?? null,
          totalOwed: Number(row.total_owed),
          invoiceCount: Number(row.invoice_count),
          oldestDaysOverdue: Number(row.oldest_days_overdue),
          lastContactedAt: row.lastContactedAt ? new Date(row.lastContactedAt as string) : null,
          lastContactType: (row.last_contact_type as string) ?? null,
          lastContactSummary: (row.last_contact_summary as string) ?? null,
          nextFollowUp,
          followUpNotes: (row.followUpNotes as string) ?? null,
          // Someone already spoke to them and agreed a date that has not
          // arrived. Still on the list, collapsed by default — chasing before
          // the promised date costs goodwill and buys nothing.
          waiting: !!nextFollowUp && nextFollowUp.getTime() > now,
          invoices: (row.invoices as OverdueInvoiceRow[]) ?? [],
        };
      });

      // Overdue invoices attached to no customer at all — no customerId and no
      // rental to borrow one from. They cannot appear on a call list because
      // there is nobody to call, but they are real money and must never just
      // vanish from the total. Surfaced separately so the page can say so.
      const orphanRows = await db.execute(sql`
        SELECT i.id, i."invoiceNumber", i."balanceDue"::numeric AS balance_due,
               (CURRENT_DATE - i."dueDate"::date) AS days_overdue
        FROM invoices i
        LEFT JOIN rental_requests r ON r.id = i."rentalId"
        LEFT JOIN customers c ON c.id = COALESCE(i."customerId", r."customerId") AND c."deletedAt" IS NULL
        WHERE i."deletedAt" IS NULL
          AND i.status IN ('sent', 'partial', 'overdue')
          AND i."balanceDue"::numeric > 0
          AND i."dueDate" IS NOT NULL
          AND i."dueDate"::date < CURRENT_DATE
          AND c.id IS NULL
        ORDER BY i."balanceDue"::numeric DESC
      `) as unknown as Array<Record<string, unknown>>;

      const unassigned = orphanRows.map((row) => ({
        id: Number(row.id),
        invoiceNumber: (row.invoiceNumber as string) ?? null,
        balanceDue: Number(row.balance_due),
        daysOverdue: Number(row.days_overdue),
      }));

      const assignedAmount = customers.reduce((sum, c) => sum + c.totalOwed, 0);
      const unassignedAmount = unassigned.reduce((sum, i) => sum + i.balanceDue, 0);

      return {
        customers,
        unassigned,
        totals: {
          customerCount: customers.length,
          invoiceCount: customers.reduce((sum, c) => sum + c.invoiceCount, 0) + unassigned.length,
          // The headline number is ALL overdue money, including the invoices
          // nobody can be called about — anything less would under-report.
          amount: assignedAmount + unassignedAmount,
          unassignedAmount,
          // Split out so the header can say "X of it is already promised".
          waitingAmount: customers.filter((c) => c.waiting).reduce((sum, c) => sum + c.totalOwed, 0),
        },
      };
    }),

  /**
   * Record that someone was contacted.
   *
   * Writes the interaction, stamps `lastContactedAt`, and optionally sets the
   * follow-up date that collapses the row until it arrives. No invoice or
   * payment is touched — recording a phone call must never move money.
   */
  logContact: protectedProcedure.use(moduleGuard("invoices", "update"))
    .input(z.object({
      customerId: z.number(),
      type: z.enum(["call", "email", "note", "visit", "complaint", "follow_up"]),
      summary: z.string().min(1).max(1000),
      nextFollowUp: z.date().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const contactedAt = new Date();

      const [interaction] = await db
        .insert(schema.customerInteractions)
        .values({
          customerId: input.customerId,
          type: input.type,
          summary: input.summary,
          createdBy: ctx.user?.id ?? null,
        })
        .returning();

      await db
        .update(schema.customers)
        .set({
          lastContactedAt: contactedAt,
          // `undefined` leaves the existing date alone; `null` clears it.
          ...(input.nextFollowUp === undefined ? {} : { nextFollowUp: input.nextFollowUp }),
          updatedAt: contactedAt,
        })
        .where(eq(schema.customers.id, input.customerId));

      await logAudit({
        userId: ctx.user?.id,
        action: "contact_logged",
        entityType: "customer",
        entityId: input.customerId,
        metadata: { type: input.type, nextFollowUp: input.nextFollowUp?.toISOString() ?? null },
        ipAddress: ctx.req?.ip,
      }).catch((err) => {
        logger.warn("[collections.logContact] audit failed", { error: err });
      });

      return { id: interaction?.id ?? null, contactedAt };
    }),

  /** Contact history for one customer, newest first. */
  history: protectedProcedure.use(moduleGuard("invoices", "read"))
    .input(z.object({ customerId: z.number(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.customerInteractions.id,
          type: schema.customerInteractions.type,
          summary: schema.customerInteractions.summary,
          createdAt: schema.customerInteractions.createdAt,
          userName: schema.users.name,
        })
        .from(schema.customerInteractions)
        .leftJoin(schema.users, and(
          eq(schema.users.id, schema.customerInteractions.createdBy),
          isNull(schema.users.deletedAt),
        ))
        .where(eq(schema.customerInteractions.customerId, input.customerId))
        .orderBy(desc(schema.customerInteractions.createdAt))
        .limit(input.limit);
    }),
});
