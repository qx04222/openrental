import { sql } from "drizzle-orm";
import type { getDb } from "../db";

type AppDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ExecuteDb = Pick<AppDb, "execute">;

/**
 * Work our own staff owes the business, keyed on the work item itself.
 *
 * This is deliberately a different question from `reports.operationalHealth`.
 * That report is anchored on the ORDER and asks "the order moved — did the
 * thing it should have produced get produced?". It is blind by construction to
 * an object that WAS produced and then stalled, because from the order's point
 * of view the object exists and the check passes.
 *
 * That blind spot has cost real money twice:
 *  - Two mid-rental-swap work orders auto-opened on 07-07 and 07-17 were never
 *    closed, quietly making a machine unrentable for two weeks. Nothing in the
 *    system ever said so.
 *  - 25 invoices sat in `draft` — up to 123 days, $31.7k — for completed
 *    rentals. `no_invoice` passes (an invoice exists) and the 7-day payment
 *    reminder deliberately skips drafts, so the money was invisible on both
 *    sides.
 *
 * So this asks the inverse: for each work item that someone has to finish, how
 * long has it been sitting there? Age is measured in whole days from creation.
 */

export type WorkQueueKind =
  | "work_order"
  | "draft_invoice"
  | "damage_claim"
  | "dispatch_order"
  | "extension_request"
  | "held_deposit"
  | "unbilled_credit_charges"
  | "overdue_invoice";

/**
 * How many days an item may sit before it counts as overdue.
 *
 * These are starting values, not physics — they are the point to tune once
 * staff have lived with the badges for a while. A customer waiting on an answer
 * (extension, delivery) gets a tighter clock than internal paperwork.
 */
export const WORK_QUEUE_SLA_DAYS: Record<WorkQueueKind, number> = {
  extension_request: 1,
  // Money already owed. `ageDays` here is days past the due date, not days
  // since the row was created, so the clock starts the moment payment is late.
  overdue_invoice: 1,
  dispatch_order: 1,
  work_order: 3,
  draft_invoice: 3,
  held_deposit: 3,
  unbilled_credit_charges: 3,
  damage_claim: 7,
};

/** Items listed per kind. The counts are always exact; only the list is capped. */
const ITEMS_PER_KIND = 25;

export interface WorkQueueItem {
  id: number;
  /** Human-facing document number (WO-2026-0002, INV-2026-0110, …). */
  ref: string;
  status: string;
  ageDays: number;
  overdue: boolean;
  /** Extra context for the row — customer, amount, linked rental. */
  detail: string | null;
}

export interface WorkQueueBucket {
  kind: WorkQueueKind;
  slaDays: number;
  count: number;
  overdueCount: number;
  oldestAgeDays: number;
  items: WorkQueueItem[];
  /** True when `items` was capped, so the UI can say "showing 25 of N". */
  truncated: boolean;
}

export interface WorkQueueSummary {
  buckets: WorkQueueBucket[];
  total: number;
  overdueTotal: number;
}

interface RawRow {
  kind: WorkQueueKind;
  id: number | string;
  ref: string | null;
  status: string | null;
  age_days: number | string;
  detail: string | null;
}

export async function getInternalWorkQueue(db: ExecuteDb): Promise<WorkQueueSummary> {
  const rows = await db.execute(sql`
    -- Work orders holding equipment. Anything not closed out still blocks the
    -- unit (see fleetAvailability.listOperationalFleetBlocks).
    SELECT
      'work_order'::text AS kind,
      wo.id,
      COALESCE(wo."workOrderNumber", '#' || wo.id) AS ref,
      wo.status::text AS status,
      (CURRENT_DATE - wo."createdAt"::date) AS age_days,
      COALESCE(NULLIF(rf."serialNumber", ''), rf."assetNumber") AS detail
    FROM work_orders wo
    LEFT JOIN rental_fleet rf ON rf.id = wo."rentalFleetId"
    WHERE wo."deletedAt" IS NULL
      AND wo.status NOT IN ('completed', 'cancelled')

    UNION ALL

    -- Invoices generated but never sent. The customer has never seen these.
    SELECT
      'draft_invoice'::text AS kind,
      i.id,
      COALESCE(i."invoiceNumber", '#' || i.id) AS ref,
      i.status::text AS status,
      (CURRENT_DATE - i."createdAt"::date) AS age_days,
      COALESCE(NULLIF(c.company, ''), c.name, '') || ' · $' || ROUND(i."totalAmount"::numeric, 2) AS detail
    FROM invoices i
    LEFT JOIN rental_requests r ON r.id = i."rentalId"
    LEFT JOIN customers c ON c.id = COALESCE(i."customerId", r."customerId")
    WHERE i."deletedAt" IS NULL
      AND i.status = 'draft'

    UNION ALL

    -- Damage claims short of 'invoiced' are money not yet asked for; 'disputed'
    -- is a customer waiting on us.
    SELECT
      'damage_claim'::text AS kind,
      dc.id,
      '#' || dc.id AS ref,
      dc.status::text AS status,
      (CURRENT_DATE - dc."createdAt"::date) AS age_days,
      COALESCE(NULLIF(c.company, ''), c.name, '') AS detail
    FROM damage_claims dc
    LEFT JOIN customers c ON c.id = dc."customerId"
    WHERE dc."deletedAt" IS NULL
      AND dc.status <> 'invoiced'

    UNION ALL

    -- Dispatch orders created but never driven to completion. Distinct from
    -- operationalHealth's no_dispatch, which only catches orders that never
    -- got a dispatch row at all.
    SELECT
      'dispatch_order'::text AS kind,
      d.id,
      COALESCE(r."rentalNumber", '#' || d.id) AS ref,
      d.status::text AS status,
      (CURRENT_DATE - d."createdAt"::date) AS age_days,
      d."deliveryAddress" AS detail
    FROM dispatch_orders d
    LEFT JOIN rental_requests r ON r.id = d."rentalRequestId"
    WHERE d."deletedAt" IS NULL
      AND d.status NOT IN ('completed', 'cancelled')

    UNION ALL

    -- Extension requests are a customer holding the line for an answer.
    SELECT
      'extension_request'::text AS kind,
      er.id,
      COALESCE(r."rentalNumber", '#' || er.id) AS ref,
      er.status::text AS status,
      (CURRENT_DATE - er."createdAt"::date) AS age_days,
      COALESCE(NULLIF(c.company, ''), c.name, '') AS detail
    FROM extension_requests er
    LEFT JOIN rental_requests r ON r.id = er."rentalRequestId"
    LEFT JOIN customers c ON c.id = r."customerId"
    WHERE er.status = 'pending'

    UNION ALL

    -- Deposits still held on a rental that has already ended. A prepayment is
    -- "held" until someone converts it to rent (appliedAt); on a finished order
    -- it must be either converted or refunded, and until then it is the
    -- customer's money sitting on our books with nothing pointing at it.
    -- Age runs from the rental end date, not the payment date: holding a
    -- deposit during the rental is correct, holding it afterwards is not.
    SELECT
      'held_deposit'::text AS kind,
      r.id,
      COALESCE(r."rentalNumber", '#' || r.id) AS ref,
      r.status::text AS status,
      (CURRENT_DATE - r."endDate"::date) AS age_days,
      COALESCE(NULLIF(c.company, ''), c.name, '') || ' · $'
        || ROUND(SUM(p.amount::numeric), 2) AS detail
    FROM rental_requests r
    JOIN rental_prepayments p
      ON p."rentalRequestId" = r.id
     AND p."deletedAt" IS NULL
     AND p."appliedAt" IS NULL
     -- Already moved onto the customer's balance; it is no longer waiting on
     -- anyone. (migration 150)
     AND p."transferredToCreditAt" IS NULL
    LEFT JOIN customers c ON c.id = r."customerId"
    WHERE r."deletedAt" IS NULL
      AND r.status IN ('completed', 'cancelled', 'rejected')
    GROUP BY r.id, r."rentalNumber", r.status, r."endDate", c.company, c.name
    HAVING SUM(p.amount::numeric) > 0

    UNION ALL

    -- Settled credit orders that still carry unbilled charges. Settlement tries
    -- to invoice the balance and then moves the order to a terminal state only a
    -- super_admin can reopen; if that invoicing failed, the charges are stranded
    -- with no invoice they can ever reach. operationalHealth's no_invoice check
    -- explicitly skips credit orders, so nothing else looks here.
    SELECT
      'unbilled_credit_charges'::text AS kind,
      r.id,
      COALESCE(r."rentalNumber", '#' || r.id) AS ref,
      r.status::text AS status,
      (CURRENT_DATE - r."creditFinalizedAt"::date) AS age_days,
      COALESCE(NULLIF(c.company, ''), c.name, '') || ' · $'
        || ROUND(SUM(rc.amount::numeric), 2) AS detail
    FROM rental_requests r
    JOIN rental_charges rc
      ON rc."rentalRequestId" = r.id
     AND rc."deletedAt" IS NULL
     AND rc."invoiceId" IS NULL
    LEFT JOIN customers c ON c.id = r."customerId"
    WHERE r."deletedAt" IS NULL
      AND r."isCreditOrder" = true
      AND r."creditFinalizedAt" IS NOT NULL
    GROUP BY r.id, r."rentalNumber", r.status, r."creditFinalizedAt", c.company, c.name
    HAVING SUM(rc.amount::numeric) > 0

    UNION ALL

    -- Invoices past their due date with money still on them. Nothing else in
    -- this queue watches receivables, and no automated chase reaches these
    -- customers: 94 of 104 have no email address on file and the SMS channel is
    -- deliberately switched off. Someone has to phone them, so the work belongs
    -- on the work list.
    SELECT
      'overdue_invoice'::text AS kind,
      i.id,
      COALESCE(i."invoiceNumber", '#' || i.id) AS ref,
      i.status::text AS status,
      (CURRENT_DATE - i."dueDate"::date) AS age_days,
      COALESCE(NULLIF(c.company, ''), c.name, '') || ' · $'
        || ROUND(i."balanceDue"::numeric, 2) AS detail
    FROM invoices i
    LEFT JOIN rental_requests r2 ON r2.id = i."rentalId"
    LEFT JOIN customers c ON c.id = COALESCE(i."customerId", r2."customerId")
    WHERE i."deletedAt" IS NULL
      AND i.status IN ('sent', 'partial', 'overdue')
      AND i."balanceDue"::numeric > 0
      AND i."dueDate" IS NOT NULL
      AND i."dueDate"::date < CURRENT_DATE
  `) as unknown as RawRow[];

  return summarizeWorkQueue(rows);
}

/** Split out from the query so the bucketing rules are testable without a database. */
export function summarizeWorkQueue(rows: RawRow[]): WorkQueueSummary {
  const byKind = new Map<WorkQueueKind, WorkQueueItem[]>();

  for (const row of rows) {
    const ageDays = Number(row.age_days) || 0;
    const item: WorkQueueItem = {
      id: Number(row.id),
      ref: row.ref || `#${row.id}`,
      status: row.status || "",
      ageDays,
      overdue: ageDays >= WORK_QUEUE_SLA_DAYS[row.kind],
      detail: row.detail ? row.detail.trim() || null : null,
    };
    const list = byKind.get(row.kind);
    if (list) list.push(item);
    else byKind.set(row.kind, [item]);
  }

  const buckets: WorkQueueBucket[] = [];
  for (const [kind, items] of byKind) {
    // Oldest first: the thing that has been waiting longest is the thing to do.
    items.sort((a, b) => b.ageDays - a.ageDays);
    buckets.push({
      kind,
      slaDays: WORK_QUEUE_SLA_DAYS[kind],
      count: items.length,
      overdueCount: items.filter((item) => item.overdue).length,
      oldestAgeDays: items[0]?.ageDays ?? 0,
      items: items.slice(0, ITEMS_PER_KIND),
      truncated: items.length > ITEMS_PER_KIND,
    });
  }

  // Worst bucket first, so the badge and the report agree on what matters.
  buckets.sort((a, b) => b.overdueCount - a.overdueCount || b.count - a.count);

  return {
    buckets,
    total: buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    overdueTotal: buckets.reduce((sum, bucket) => sum + bucket.overdueCount, 0),
  };
}
