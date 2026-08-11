/**
 * A reminder may only be marked as reminded when it was actually delivered.
 *
 * Production regression (found 2026-08-09): the cron called sendBusinessSMS and
 * then wrote the "sent" marker unconditionally. sendBusinessSMS returns
 * silently when the SMS channel is globally disabled, so between 2026-07-02 and
 * 08-09 it stamped 95 markers for messages that never left the building — and
 * because the marker is also the idempotency guard, those rentals and invoices
 * were permanently disqualified from ever being reminded.
 *
 * The two properties that must hold forever:
 *   1. channel disabled  → no marker written, customer stays eligible
 *   2. delivered         → exactly one marker, so we never double-send
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const { smsEnabledRef, otpSendSMS, inserted, selectResult } = vi.hoisted(() => ({
  smsEnabledRef: { value: true },
  otpSendSMS: vi.fn(async () => {}),
  inserted: [] as Record<string, unknown>[],
  selectResult: { rows: [] as unknown[] },
}));

vi.mock("../server/services/notifications", () => ({
  isSmsEnabled: async () => smsEnabledRef.value,
}));

vi.mock("../server/services/otp", () => ({
  sendSMS: otpSendSMS,
  normalizePhone: (p: string) => p,
}));

vi.mock("../server/_core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * Minimal db double: `select…limit` answers the "already delivered?" probe,
 * `insert…values…onConflictDoNothing` captures marker writes.
 */
function makeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => selectResult.rows }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { onConflictDoNothing: async () => undefined };
      },
    }),
  };
}

vi.mock("../server/db", async () => {
  const actual = await vi.importActual<typeof import("../server/db")>("../server/db");
  return { ...actual, getDb: async () => makeDb() };
});

import { sendBusinessSMS } from "../server/services/smsNotify";

/**
 * The exact shape the cron uses, kept in the test so the contract is visible:
 * send, and only on a confirmed delivery write the marker.
 */
async function reminderStep(phone: string) {
  const result = await sendBusinessSMS(phone, "OpenRental: your rental ends tomorrow.");
  if (!result.delivered) return { marked: false, reason: result.reason };
  const db = makeDb();
  await db.insert().values({ entityType: "rental", entityId: 1, kind: "reminder_ending_soon", channel: "sms", recipient: phone }).onConflictDoNothing();
  return { marked: true };
}

describe("reminder marker follows delivery, not intent", () => {
  beforeEach(() => {
    inserted.length = 0;
    selectResult.rows = [];
    smsEnabledRef.value = true;
    vi.clearAllMocks();
  });

  it("writes no marker when the SMS channel is globally disabled", async () => {
    smsEnabledRef.value = false;

    const outcome = await reminderStep("+14165551234");

    expect(otpSendSMS).not.toHaveBeenCalled();
    expect(outcome).toEqual({ marked: false, reason: "channel_disabled" });
    expect(inserted).toEqual([]); // ← the whole point: still eligible tomorrow
  });

  it("writes no marker when the provider throws", async () => {
    otpSendSMS.mockRejectedValueOnce(new Error("Telnyx 500"));

    const outcome = await reminderStep("+14165551234");

    expect(outcome).toEqual({ marked: false, reason: "send_failed" });
    expect(inserted).toEqual([]);
  });

  it("writes exactly one marker on a confirmed delivery", async () => {
    const outcome = await reminderStep("+14165551234");

    expect(otpSendSMS).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ marked: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      entityType: "rental",
      kind: "reminder_ending_soon",
      channel: "sms",
    });
  });
});

describe("rentalReminderCron wiring", () => {
  // The behavioural tests above prove the rule; this one proves the cron
  // actually follows it. Without this, someone can reintroduce an
  // unconditional marker write and every test above still passes.
  const source = readFileSync(join(__dirname, "..", "server/jobs/rentalReminderCron.ts"), "utf8");

  it("guards every marker write on result.delivered", () => {
    const sends = source.split("await sendBusinessSMS(").slice(1);
    expect(sends.length, "expected three reminder sends").toBe(3);

    for (const [i, tail] of sends.entries()) {
      const recordAt = tail.indexOf("recordDelivered(");
      expect(recordAt, `send #${i + 1} never records a delivery`).toBeGreaterThan(-1);
      const between = tail.slice(0, recordAt);
      expect(between, `send #${i + 1} records without checking delivery`).toContain("result.delivered");
    }
  });

  it("no longer stamps reminder markers into audit_logs", () => {
    // The old implementation wrote action: "reminder_*" audit rows as the
    // guard. Those rows are history now; writing new ones would resurrect the
    // burn-on-skip behaviour.
    expect(source).not.toContain("auditLogs");
  });
});

describe("sendBusinessSMS result contract", () => {
  beforeEach(() => {
    smsEnabledRef.value = true;
    vi.clearAllMocks();
  });

  it("never reports delivered:true without calling the provider", async () => {
    smsEnabledRef.value = false;
    const result = await sendBusinessSMS("+14165551234", "hi");
    expect(result.delivered).toBe(false);
    expect(otpSendSMS).not.toHaveBeenCalled();
  });
});
