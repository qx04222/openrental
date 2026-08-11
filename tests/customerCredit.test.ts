/**
 * An order's overpayment is RECOMPUTED on every invoice/payment change, not
 * emitted once. Appending a ledger row per recalculation would inflate the
 * customer's balance without anybody doing anything — the same class of bug as
 * a stored balance, arrived at from the other direction. These pin the
 * upsert-by-key behaviour that prevents it.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { setRecomputedCreditEntry, overpaymentSourceKey } from "../server/services/customerCredit";

interface Row { id: number; sourceKey: string | null; amount: string; updatedAt?: Date; deletedAt?: Date | null }

/** Minimal stand-in for the drizzle chain the service uses. */
function fakeDb() {
  const rows: Row[] = [];
  let nextId = 1;
  const inserts: Record<string, unknown>[] = [];
  const updates: { id: number; set: Record<string, unknown> }[] = [];

  const db = {
    select: () => ({
      from: () => ({
        where: (pred: { key?: string }) => ({
          limit: async () => rows.filter((r) => r.sourceKey === pred.key).slice(0, 1),
        }),
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        inserts.push(v);
        rows.push({ id: nextId++, sourceKey: (v.sourceKey as string) ?? null, amount: v.amount as string });
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async (pred: { id?: number }) => {
          updates.push({ id: pred.id!, set: v });
          const row = rows.find((r) => r.id === pred.id);
          if (row) row.amount = v.amount as string;
        },
      }),
    }),
  };
  return { db, rows, inserts, updates };
}

// The service passes drizzle expression objects to .where(); intercept them by
// reading the key/id off the calls the fake records instead.
function patched(sourceKey: string, idLookup: Row[]) {
  const f = fakeDb();
  f.rows.push(...idLookup);
  const db = {
    ...f.db,
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => f.rows.filter((r) => r.sourceKey === sourceKey).slice(0, 1) }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          f.updates.push({ id: 0, set: v });
          const row = f.rows.find((r) => r.sourceKey === sourceKey);
          if (row) row.amount = v.amount as string;
        },
      }),
    }),
  };
  return { ...f, db };
}

const entry = (amount: number) => ({
  sourceKey: overpaymentSourceKey(42),
  customerId: 7,
  amount,
  entryType: "overpayment" as const,
  rentalRequestId: 42,
});

describe("recomputed credit entries", () => {
  let ctx: ReturnType<typeof patched>;
  beforeEach(() => { ctx = patched(overpaymentSourceKey(42), []); });

  it("creates the entry the first time", async () => {
    await setRecomputedCreditEntry(ctx.db as never, entry(300));

    expect(ctx.inserts).toHaveLength(1);
    expect(ctx.inserts[0]).toMatchObject({ amount: "300.00", sourceKey: "overpay:rental:42" });
  });

  it("updates rather than appends when recalculated", async () => {
    await setRecomputedCreditEntry(ctx.db as never, entry(300));
    await setRecomputedCreditEntry(ctx.db as never, entry(450));

    // The balance must read 450, not 750.
    expect(ctx.inserts).toHaveLength(1);
    expect(ctx.updates).toHaveLength(1);
    expect(ctx.rows[0].amount).toBe("450.00");
  });

  it("does not write at all when the amount is unchanged", async () => {
    await setRecomputedCreditEntry(ctx.db as never, entry(300));
    await setRecomputedCreditEntry(ctx.db as never, entry(300));

    // Recalculation runs on every payment and invoice change; a no-op UPDATE
    // would churn updatedAt and make the audit trail lie about when it moved.
    expect(ctx.updates).toHaveLength(0);
  });

  it("writes nothing when there was never anything to record", async () => {
    await setRecomputedCreditEntry(ctx.db as never, entry(0));

    expect(ctx.inserts).toHaveLength(0);
    expect(ctx.updates).toHaveLength(0);
  });

  it("zeroes an existing entry instead of deleting it", async () => {
    await setRecomputedCreditEntry(ctx.db as never, entry(300));
    await setRecomputedCreditEntry(ctx.db as never, entry(0));

    // That the order once carried an overpayment is worth keeping; a zero row
    // sums to nothing.
    expect(ctx.rows).toHaveLength(1);
    expect(ctx.rows[0].amount).toBe("0.00");
  });

  it("keys the entry to its order", () => {
    expect(overpaymentSourceKey(42)).toBe("overpay:rental:42");
    expect(overpaymentSourceKey(43)).not.toBe(overpaymentSourceKey(42));
  });
});
