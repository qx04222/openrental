/**
 * The order-anchored operationalHealth report cannot see a work item that was
 * created and then stalled — which is how two work orders held a machine for
 * two weeks and how 25 draft invoices ($31.7k) went unsent for up to 123 days.
 * These pin the bucketing rules that replace that blind spot.
 */
import { describe, expect, it } from "vitest";
import {
  summarizeWorkQueue,
  WORK_QUEUE_SLA_DAYS,
  type WorkQueueKind,
} from "../server/services/internalWorkQueue";

const row = (
  kind: WorkQueueKind,
  id: number,
  age_days: number,
  extra: { ref?: string; status?: string; detail?: string | null } = {},
) => ({
  kind,
  id,
  ref: extra.ref ?? `REF-${id}`,
  status: extra.status ?? "open",
  age_days,
  detail: extra.detail ?? null,
});

describe("internal work queue", () => {
  it("counts an item as overdue only once it reaches its own SLA", () => {
    const sla = WORK_QUEUE_SLA_DAYS.work_order;
    const { buckets } = summarizeWorkQueue([
      row("work_order", 1, sla - 1),
      row("work_order", 2, sla),
      row("work_order", 3, sla + 10),
    ]);

    const bucket = buckets.find((b) => b.kind === "work_order")!;
    expect(bucket.count).toBe(3);
    expect(bucket.overdueCount).toBe(2);
    expect(bucket.oldestAgeDays).toBe(sla + 10);
  });

  it("gives a waiting customer a tighter clock than internal paperwork", () => {
    // An unanswered extension request is someone holding the line; a damage
    // claim is our own bookkeeping. Same age, different verdict.
    const { buckets } = summarizeWorkQueue([
      row("extension_request", 1, 2, { status: "pending" }),
      row("damage_claim", 2, 2, { status: "accepted" }),
    ]);

    expect(buckets.find((b) => b.kind === "extension_request")!.overdueCount).toBe(1);
    expect(buckets.find((b) => b.kind === "damage_claim")!.overdueCount).toBe(0);
  });

  it("lists the longest-waiting item first", () => {
    const { buckets } = summarizeWorkQueue([
      row("draft_invoice", 1, 5),
      row("draft_invoice", 2, 123),
      row("draft_invoice", 3, 40),
    ]);

    expect(buckets[0].items.map((i) => i.ageDays)).toEqual([123, 40, 5]);
  });

  it("keeps counts exact when the item list is capped", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row("draft_invoice", i, 99));
    const bucket = summarizeWorkQueue(rows).buckets[0];

    // A capped list that also capped the count would under-report the backlog —
    // exactly the kind of quiet truncation this report exists to prevent.
    expect(bucket.count).toBe(60);
    expect(bucket.overdueCount).toBe(60);
    expect(bucket.items).toHaveLength(25);
    expect(bucket.truncated).toBe(true);
  });

  it("surfaces the worst bucket first", () => {
    const { buckets, total, overdueTotal } = summarizeWorkQueue([
      row("work_order", 1, 0),
      row("draft_invoice", 2, 99),
      row("draft_invoice", 3, 99),
    ]);

    expect(buckets[0].kind).toBe("draft_invoice");
    expect(total).toBe(3);
    expect(overdueTotal).toBe(2);
  });

  it("treats a deposit still held on a finished rental as overdue paperwork", () => {
    // A deposit held DURING a rental is correct; held after it ended it is the
    // customer's money sitting on our books. Four such orders ($7,550) had been
    // sitting unnoticed because nothing counted them.
    const sla = WORK_QUEUE_SLA_DAYS.held_deposit;
    const { buckets } = summarizeWorkQueue([
      row("held_deposit", 58, sla + 21, { status: "completed", ref: "20260528GC" }),
      row("held_deposit", 271, sla - 1, { status: "cancelled", ref: "20260714MD" }),
    ]);

    const bucket = buckets.find((b) => b.kind === "held_deposit")!;
    expect(bucket.count).toBe(2);
    expect(bucket.overdueCount).toBe(1);
    expect(bucket.items[0].ref).toBe("20260528GC");
  });

  it("reports an empty queue as genuinely empty, not as a missing bucket", () => {
    expect(summarizeWorkQueue([])).toEqual({ buckets: [], total: 0, overdueTotal: 0 });
  });
});
