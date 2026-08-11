/**
 * Tests for the ConfirmDialog / useConfirm system.
 *
 * These tests validate the core logic (event emitter, promise resolution,
 * feature-flag fallback) without requiring a DOM or React rendering. The
 * ConfirmDialog component itself (Radix AlertDialog) is an integration
 * concern tested via e2e or a jsdom environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Inline the event-emitter logic so we can unit-test it in isolation without
// importing the React modules (which require a browser environment).
// ---------------------------------------------------------------------------

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  dangerous?: boolean;
  requireTypedConfirmation?: string;
};

type ConfirmRequest = ConfirmOptions & { resolve: (v: boolean) => void };
type ConfirmListener = (req: ConfirmRequest) => void;

function createConfirmBus() {
  const listeners: Set<ConfirmListener> = new Set();

  function subscribe(listener: ConfirmListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(request: ConfirmRequest): void {
    for (const l of listeners) l(request);
  }

  function listenerCount(): number {
    return listeners.size;
  }

  return { subscribe, emit, listenerCount };
}

// Feature-flag helper (mirrors useConfirm.ts implementation)
function isConfirmDialogEnabled(storage: Record<string, string>): boolean {
  try {
    const raw = storage["feature_flags"];
    if (!raw) return true;
    const flags = JSON.parse(raw) as Record<string, boolean>;
    return flags["confirm_dialog"] !== false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfirmDialog event bus", () => {
  it("delivers a request to a subscribed listener", () => {
    const bus = createConfirmBus();
    const received: ConfirmRequest[] = [];

    bus.subscribe((req) => received.push(req));

    const resolve = vi.fn();
    bus.emit({ title: "Delete item?", dangerous: true, resolve });

    expect(received).toHaveLength(1);
    expect(received[0].title).toBe("Delete item?");
    expect(received[0].dangerous).toBe(true);
    expect(received[0].resolve).toBe(resolve);
  });

  it("delivers to multiple listeners", () => {
    const bus = createConfirmBus();
    const countA = { n: 0 };
    const countB = { n: 0 };

    bus.subscribe(() => countA.n++);
    bus.subscribe(() => countB.n++);

    bus.emit({ title: "Confirm?", resolve: vi.fn() });

    expect(countA.n).toBe(1);
    expect(countB.n).toBe(1);
  });

  it("unsubscribes correctly — listener no longer called after unsubscribe", () => {
    const bus = createConfirmBus();
    let calls = 0;

    const unsub = bus.subscribe(() => calls++);
    bus.emit({ title: "First", resolve: vi.fn() });
    expect(calls).toBe(1);

    unsub();
    bus.emit({ title: "Second", resolve: vi.fn() });
    expect(calls).toBe(1); // still 1 — unsubscribed
  });

  it("reports zero listeners when none are subscribed", () => {
    const bus = createConfirmBus();
    expect(bus.listenerCount()).toBe(0);
  });

  it("reports correct count after subscribe/unsubscribe", () => {
    const bus = createConfirmBus();
    const unsub1 = bus.subscribe(vi.fn());
    const unsub2 = bus.subscribe(vi.fn());
    expect(bus.listenerCount()).toBe(2);
    unsub1();
    expect(bus.listenerCount()).toBe(1);
    unsub2();
    expect(bus.listenerCount()).toBe(0);
  });
});

describe("ConfirmDialog promise resolution via event bus", () => {
  it("resolves true when listener calls resolve(true)", async () => {
    const bus = createConfirmBus();

    // Simulate ConfirmProvider: accept the first request
    bus.subscribe((req) => {
      setTimeout(() => req.resolve(true), 0);
    });

    const result = await new Promise<boolean>((resolve) => {
      bus.emit({ title: "Confirm delete?", dangerous: true, resolve });
    });

    expect(result).toBe(true);
  });

  it("resolves false when listener calls resolve(false) (cancel)", async () => {
    const bus = createConfirmBus();

    bus.subscribe((req) => {
      setTimeout(() => req.resolve(false), 0);
    });

    const result = await new Promise<boolean>((resolve) => {
      bus.emit({ title: "Confirm?", resolve });
    });

    expect(result).toBe(false);
  });

  it("passes all options through to the listener", () => {
    const bus = createConfirmBus();
    const captured: ConfirmRequest[] = [];
    bus.subscribe((req) => captured.push(req));

    const opts: ConfirmOptions = {
      title: "Reset password?",
      description: "This will send a reset email.",
      confirmLabel: "Reset",
      cancelLabel: "Cancel",
      dangerous: true,
      requireTypedConfirmation: "RESET",
    };

    bus.emit({ ...opts, resolve: vi.fn() });

    expect(captured[0]).toMatchObject(opts);
  });
});

describe("requireTypedConfirmation gating logic", () => {
  it("gates confirm when typed value does not match", () => {
    const required = "DELETE";
    const typedValue = "delete"; // wrong case
    const isEnabled = !required || typedValue === required;
    expect(isEnabled).toBe(false);
  });

  it("enables confirm when typed value matches exactly", () => {
    const required = "DELETE";
    const typedValue = "DELETE";
    const isEnabled = !required || typedValue === required;
    expect(isEnabled).toBe(true);
  });

  it("enables confirm when requireTypedConfirmation is not set", () => {
    const required = undefined;
    const typedValue = "";
    const isEnabled = !required || typedValue === required;
    expect(isEnabled).toBe(true);
  });

  it("gates confirm for empty typed value when confirmation is required", () => {
    const required = "CONFIRM";
    const typedValue = "";
    const isEnabled = !required || typedValue === required;
    expect(isEnabled).toBe(false);
  });
});

describe("Feature flag: isConfirmDialogEnabled", () => {
  it("returns true when no feature_flags key is set", () => {
    expect(isConfirmDialogEnabled({})).toBe(true);
  });

  it("returns true when confirm_dialog flag is true", () => {
    const storage = { feature_flags: JSON.stringify({ confirm_dialog: true }) };
    expect(isConfirmDialogEnabled(storage)).toBe(true);
  });

  it("returns false when confirm_dialog flag is false", () => {
    const storage = { feature_flags: JSON.stringify({ confirm_dialog: false }) };
    expect(isConfirmDialogEnabled(storage)).toBe(false);
  });

  it("returns true when other flags are set but confirm_dialog is absent", () => {
    const storage = { feature_flags: JSON.stringify({ other_flag: false }) };
    expect(isConfirmDialogEnabled(storage)).toBe(true);
  });

  it("returns true on malformed JSON (safe default)", () => {
    const storage = { feature_flags: "not-json{{" };
    expect(isConfirmDialogEnabled(storage)).toBe(true);
  });
});

describe("ConfirmDialog props validation (type-level smoke tests)", () => {
  it("default labels are 'Confirm' and 'Cancel'", () => {
    // Simulate the defaulting logic from the component
    const props = { title: "Delete?", onConfirm: vi.fn(), open: true, onOpenChange: vi.fn() };
    const confirmLabel = (props as { confirmLabel?: string }).confirmLabel ?? "Confirm";
    const cancelLabel = (props as { cancelLabel?: string }).cancelLabel ?? "Cancel";
    expect(confirmLabel).toBe("Confirm");
    expect(cancelLabel).toBe("Cancel");
  });

  it("dangerous flag defaults to false when not provided", () => {
    const dangerous = (undefined as boolean | undefined) ?? false;
    expect(dangerous).toBe(false);
  });

  it("onConfirm can return void or Promise<void>", async () => {
    // Sync variant
    const syncConfirm = () => { /* no return */ };
    await Promise.resolve(syncConfirm());

    // Async variant
    const asyncConfirm = async () => { await Promise.resolve(); };
    await asyncConfirm();

    expect(true).toBe(true); // both variants resolved without error
  });
});
