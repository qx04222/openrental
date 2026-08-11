import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  resolveClaimAmount,
  deriveInvoiceTaxRate,
  computeWaiverAmounts,
  waiverSourceKey,
} from "../server/services/chargeWaiver";
import zhCommon from "../client/src/i18n/locales/zh/common.json";
import enCommon from "../client/src/i18n/locales/en/common.json";

/**
 * Waiving an already-invoiced charge. The issued invoice must never be mutated;
 * the money comes back via an offsetting credit note. The real case this was
 * built for: INV-2026-0152 (subtotal 358.00 / HST 46.54 / total 404.54) with a
 * 36.00 fuel charge on it — waiving must credit 40.68, netting 363.86.
 */

const ORIGINAL_INVOICE = { subtotal: "358.00", taxAmount: "46.54" };

describe("resolveClaimAmount", () => {
  it("prefers approvedAmount, then amount, then repairEstimate", () => {
    expect(resolveClaimAmount({ approvedAmount: "10.00", amount: "20.00", repairEstimate: "30.00" })).toBe(10);
    expect(resolveClaimAmount({ approvedAmount: null, amount: "20.00", repairEstimate: "30.00" })).toBe(20);
    expect(resolveClaimAmount({ approvedAmount: null, amount: null, repairEstimate: "30.00" })).toBe(30);
  });

  it("treats a fully-waived charge (approvedAmount 0) as zero, not as falling through", () => {
    // The precedence is string-based on purpose: "0.00" must WIN over a stale
    // `amount`, otherwise a waived charge would reappear in every total.
    expect(resolveClaimAmount({ approvedAmount: "0.00", amount: "36.00", repairEstimate: null })).toBe(0);
  });

  it("returns 0 for missing / unparseable amounts", () => {
    expect(resolveClaimAmount({ approvedAmount: null, amount: null, repairEstimate: null })).toBe(0);
    expect(resolveClaimAmount({ approvedAmount: "abc", amount: null, repairEstimate: null })).toBe(0);
  });
});

describe("deriveInvoiceTaxRate", () => {
  it("derives the rate actually charged on the original document", () => {
    // 46.54 / 358.00 = 0.13 — read off the invoice, NOT hardcoded and NOT
    // re-looked-up from today's tax table (which may have changed since issue).
    expect(deriveInvoiceTaxRate(ORIGINAL_INVOICE)).toBeCloseTo(0.13, 10);
  });

  it("handles a non-13% province without any code change", () => {
    // GST 5% only (e.g. AB): 5.00 / 100.00
    expect(deriveInvoiceTaxRate({ subtotal: "100.00", taxAmount: "5.00" })).toBeCloseTo(0.05, 10);
  });

  it("returns null when the rate cannot be derived, so the caller can fall back", () => {
    expect(deriveInvoiceTaxRate({ subtotal: "0.00", taxAmount: "46.54" })).toBeNull();
    expect(deriveInvoiceTaxRate({ subtotal: null, taxAmount: null })).toBeNull();
    expect(deriveInvoiceTaxRate({ subtotal: "-10.00", taxAmount: "1.00" })).toBeNull();
  });

  it("allows a genuinely tax-free invoice (rate 0), which is not the same as underivable", () => {
    expect(deriveInvoiceTaxRate({ subtotal: "100.00", taxAmount: "0.00" })).toBe(0);
  });
});

describe("computeWaiverAmounts", () => {
  it("credits the charge plus its share of tax — the real 36.00 fuel case", () => {
    const rate = deriveInvoiceTaxRate(ORIGINAL_INVOICE)!;
    const amounts = computeWaiverAmounts(36, rate);
    expect(amounts.chargeAmount).toBe(36);
    expect(amounts.taxAmount).toBe(4.68);
    expect(amounts.totalAmount).toBe(40.68);

    // And the customer nets what the business expects: 322 x 1.13.
    const originalTotal = 404.54;
    expect(Math.round((originalTotal - amounts.totalAmount) * 100) / 100).toBe(363.86);
  });

  it("rounds tax to cents rather than carrying float dust", () => {
    const amounts = computeWaiverAmounts(33.33, 0.13);
    expect(amounts.taxAmount).toBe(4.33); // 4.3329 → 4.33
    expect(amounts.totalAmount).toBe(37.66);
  });

  it("credits the bare amount when the invoice carried no tax", () => {
    expect(computeWaiverAmounts(36, 0)).toMatchObject({ taxAmount: 0, totalAmount: 36 });
  });
});

describe("waiverSourceKey", () => {
  it("is deterministic per charge, so a double-waive collides on the unique index", () => {
    expect(waiverSourceKey(14)).toBe("waive:claim:14");
    expect(waiverSourceKey(14)).toBe(waiverSourceKey(14));
    expect(waiverSourceKey(15)).not.toBe(waiverSourceKey(14));
  });
});

describe("waiver error messages are translatable", () => {
  it("every waiver error key exists in both locales", () => {
    const keys = [
      "errors.waive.notInvoiced",
      "errors.waive.nothingToWaive",
      "errors.waive.alreadyWaived",
      "errors.waive.invoiceNotFound",
      "errors.damageClaim.notFound",
      "errors.databaseUnavailable",
    ];
    for (const key of keys) {
      expect(zhCommon, `zh missing ${key}`).toHaveProperty(key);
      expect(enCommon, `en missing ${key}`).toHaveProperty(key);
    }
  });
});

/**
 * Behavioural tests for waiveInvoicedCharge itself. The DB is faked at the
 * `getDb` boundary — enough to pin the guards (not invoiced / reason required)
 * and to assert what the credit note is actually built from.
 */
describe("waiveInvoicedCharge", () => {
  const INVOICED_CLAIM = {
    id: 14,
    rentalId: 77,
    customerId: 5,
    chargeType: "fuel",
    description: "Refuel on return",
    approvedAmount: null,
    amount: "36.00",
    repairEstimate: null,
    status: "invoiced",
    invoiceId: 153,
    deletedAt: null,
  };

  const INVOICE_ROW = {
    id: 153,
    invoiceNumber: "INV-2026-0152",
    subtotal: "358.00",
    taxAmount: "46.54",
    totalAmount: "404.54",
    taxProvince: "ON",
    taxBreakdown: "HST 13.00%",
    customerId: 5,
    deletedAt: null,
  };

  /** Rows the fake DB hands back, in the order the service queries them. */
  let selectQueue: unknown[][];
  let insertedInvoices: Record<string, unknown>[];
  let insertedLineItems: Record<string, unknown>[];
  let claimUpdates: Record<string, unknown>[];
  let auditCalls: Record<string, unknown>[];

  function makeTx() {
    const tx: Record<string, unknown> = {
      select: () => {
        const chain: Record<string, unknown> = {};
        const next = () => chain;
        chain.from = next;
        chain.where = next;
        chain.limit = next;
        chain.for = next;
        chain.orderBy = next;
        // Awaiting the chain resolves to the next queued result set.
        (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
          resolve(selectQueue.shift() ?? []);
        return chain;
      },
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          // Invoices carry an invoiceNumber; line items do not.
          const target = "invoiceNumber" in vals ? insertedInvoices : insertedLineItems;
          target.push(vals);
          return {
            returning: async () => [{ ...vals, id: 900 }],
            then: (resolve: (v: unknown) => unknown) => resolve([{ ...vals, id: 900 }]),
          };
        },
      }),
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          claimUpdates.push(vals);
          return { where: async () => undefined };
        },
      }),
      // Nested transaction = savepoint.
      transaction: async (fn: (sp: unknown) => unknown) => fn(tx),
    };
    return tx;
  }

  beforeEach(() => {
    selectQueue = [];
    insertedInvoices = [];
    insertedLineItems = [];
    claimUpdates = [];
    auditCalls = [];
    vi.resetModules();
  });

  async function loadService() {
    vi.doMock("../server/db", async () => {
      const actual = await vi.importActual<Record<string, unknown>>("../server/db");
      const tx = makeTx();
      return {
        ...actual,
        getDb: async () => ({
          ...tx,
          transaction: async (fn: (t: unknown) => unknown) => fn(tx),
        }),
      };
    });
    vi.doMock("../server/services/auditLog", () => ({
      logAudit: async (entry: Record<string, unknown>) => {
        auditCalls.push(entry);
      },
    }));
    // Province fallback must never be reached in these cases; make it loud.
    vi.doMock("../server/services/taxCalculation", () => ({
      calculateTax: async () => {
        throw new Error("province tax fallback should not be used here");
      },
    }));
    return await import("../server/services/chargeWaiver");
  }

  it("refuses a charge that has not been invoiced — that one is directly editable", async () => {
    const { waiveInvoicedCharge } = await loadService();
    selectQueue = [[{ ...INVOICED_CLAIM, invoiceId: null }]];

    await expect(
      waiveInvoicedCharge({ claimId: 14, reason: "waived" }),
    ).rejects.toThrowError(/has not been invoiced/i);
    expect(insertedInvoices).toHaveLength(0);
  });

  it("requires a reason before anything is read or written", async () => {
    const { waiveInvoicedCharge } = await loadService();
    selectQueue = [[INVOICED_CLAIM]];

    await expect(
      waiveInvoicedCharge({ claimId: 14, reason: "" }),
    ).rejects.toThrowError(/reason is required/i);
    // The reason gate runs first: nothing was even queried.
    expect(selectQueue).toHaveLength(1);
    expect(insertedInvoices).toHaveLength(0);
  });

  it('requires a note when the reason is "other"', async () => {
    const { waiveInvoicedCharge } = await loadService();
    selectQueue = [[INVOICED_CLAIM]];
    await expect(
      waiveInvoicedCharge({ claimId: 14, reason: "other" }),
    ).rejects.toThrowError(/note is required/i);
  });

  it("refuses to waive a charge that is already waived", async () => {
    const { waiveInvoicedCharge } = await loadService();
    selectQueue = [
      [INVOICED_CLAIM],
      [{ id: 900, invoiceNumber: "CN-2026-0007" }], // existing credit note
    ];
    await expect(
      waiveInvoicedCharge({ claimId: 14, reason: "waived" }),
    ).rejects.toThrowError(/already waived/i);
    expect(insertedInvoices).toHaveLength(0);
  });

  it("issues a credit note for charge + tax that traces back to the original invoice", async () => {
    const { waiveInvoicedCharge } = await loadService();
    selectQueue = [
      [INVOICED_CLAIM], // claim
      [], // no existing credit note
      [INVOICE_ROW], // original invoice
      [], // computeNextInvoiceNumber: no prior CN
    ];

    const result = await waiveInvoicedCharge({
      claimId: 14,
      reason: "customer_agreed",
      userId: 3,
    });

    expect(result.chargeAmount).toBe(36);
    expect(result.taxAmount).toBe(4.68);
    expect(result.totalAmount).toBe(40.68);

    const cn = insertedInvoices[0];
    expect(cn.type).toBe("credit_note");
    // Stored negative, so it nets against receivables.
    expect(cn.subtotal).toBe("-36.00");
    expect(cn.taxAmount).toBe("-4.68");
    expect(cn.totalAmount).toBe("-40.68");
    expect(cn.balanceDue).toBe("-40.68");
    expect(cn.rentalId).toBe(77);
    expect(cn.sourceKey).toBe("waive:claim:14");

    // Traceability: original invoice number + charge id are recoverable.
    expect(String(cn.notes)).toContain("INV-2026-0152");
    const trace = JSON.parse(String(cn.internalNotes));
    expect(trace).toMatchObject({
      waivedClaimId: 14,
      originalInvoiceId: 153,
      originalInvoiceNumber: "INV-2026-0152",
      taxSource: "original_invoice",
    });

    // A negative line item, not a mutated original.
    expect(insertedLineItems[0]).toMatchObject({ amount: "-36.00", lineType: "credit" });

    // The claim is zeroed via approvedAmount; status is left alone.
    expect(claimUpdates[0].approvedAmount).toBe("0.00");
    expect(claimUpdates[0]).not.toHaveProperty("status");
  });

  it("writes an audit entry carrying the reason, the credit note and the rental id", async () => {
    const { waiveInvoicedCharge } = await loadService();
    selectQueue = [[INVOICED_CLAIM], [], [INVOICE_ROW], []];

    await waiveInvoicedCharge({ claimId: 14, reason: "customer_agreed", userId: 3 });

    expect(auditCalls).toHaveLength(1);
    const entry = auditCalls[0];
    expect(entry.action).toBe("waive");
    expect(entry.entityType).toBe("damage_claim");
    expect(entry.entityId).toBe(14);
    const meta = entry.metadata as Record<string, unknown>;
    // Without rentalRequestId the entry is invisible on the order's history tab.
    expect(meta.rentalRequestId).toBe(77);
    expect(meta.reason).toBe("customer_agreed");
    expect(meta.originalInvoiceNumber).toBe("INV-2026-0152");
    expect(meta.creditTotal).toBe("-40.68");
    const changes = entry.changes as Record<string, { old: unknown; new: unknown }>;
    expect(changes.waivedAmount).toEqual({ old: "36.00", new: "0.00" });
  });

  it("surfaces guard failures as typed TRPCErrors the client can translate", async () => {
    const { waiveInvoicedCharge } = await loadService();
    selectQueue = [[{ ...INVOICED_CLAIM, invoiceId: null }]];
    try {
      await waiveInvoicedCharge({ claimId: 14, reason: "waived" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
    }
  });
});
