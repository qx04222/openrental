import { describe, expect, it, vi } from "vitest";
import {
  assertLifecycleCasSucceeded,
  effectFailureDisposition,
  executeEffectOnce,
  type LifecycleEffectRecord,
} from "../server/services/rentalLifecycleEffects";

const effect = (overrides: Partial<LifecycleEffectRecord> = {}): LifecycleEffectRecord => ({
  id: 7,
  commandKey: "rental:42:active:completed:1",
  rentalRequestId: 42,
  effectType: "invoice_reconcile",
  status: "pending",
  attempts: 0,
  ...overrides,
});

describe("rental lifecycle effect safety", () => {
  it("rejects a lost compare-and-swap instead of reporting success", () => {
    expect(() => assertLifecycleCasSucceeded([])).toThrow(/changed by another request/i);
  });

  it("accepts exactly one compare-and-swap winner", () => {
    expect(assertLifecycleCasSucceeded([{ id: 42 }])).toEqual({ id: 42 });
  });

  it("retries an idempotent effect with bounded exponential backoff", () => {
    const disposition = effectFailureDisposition(effect({ attempts: 1 }), new Date("2026-07-15T00:00:00Z"));

    expect(disposition.status).toBe("failed");
    expect(disposition.nextAttemptAt).toEqual(new Date("2026-07-15T00:02:00Z"));
  });

  it("sends an ambiguous notification failure to manual review", () => {
    const disposition = effectFailureDisposition(effect({ effectType: "notification" }), new Date("2026-07-15T00:00:00Z"));

    expect(disposition).toEqual({ status: "manual_review", nextAttemptAt: null });
  });

  it("executes a claimed effect once and returns a completed settlement", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const settlement = await executeEffectOnce(effect(), handler, new Date("2026-07-15T00:00:00Z"));

    expect(handler).toHaveBeenCalledOnce();
    expect(settlement).toEqual(expect.objectContaining({ status: "completed", attempts: 1 }));
  });

  it("does not execute a non-pending effect", async () => {
    const handler = vi.fn();

    await expect(executeEffectOnce(effect({ status: "processing" }), handler)).rejects.toThrow(/not claimable/i);
    expect(handler).not.toHaveBeenCalled();
  });
});
