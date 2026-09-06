import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

function worker(payload: unknown) {
  const records = new Map([["offline-1", { offlineId: "offline-1", type: "general" }]]);
  const listeners: Record<string, (event: unknown) => void> = {};
  const db = {
    close() {},
    transaction() {
      const tx: Record<string, unknown> = {};
      tx.objectStore = () => ({
        getAll() { const req: Record<string, unknown> = {}; setTimeout(() => { req.result = [...records.values()]; (req.onsuccess as () => void)(); }, 0); return req; },
        delete(key: string) { records.delete(key); setTimeout(() => (tx.oncomplete as (() => void) | undefined)?.(), 0); },
      });
      return tx;
    },
  };
  const fetch = vi.fn(async () => ({ ok: true, json: async () => payload }));
  const context = {
    self: { addEventListener: (key: string, fn: typeof listeners[string]) => { listeners[key] = fn; }, clients: { matchAll: async () => [] } },
    indexedDB: { open() { const req: Record<string, unknown> = {}; setTimeout(() => { req.result = db; (req.onsuccess as () => void)(); }, 0); return req; } },
    fetch, Promise, console, setTimeout,
  };
  runInNewContext(readFileSync("client/public/field-sw.js", "utf8"), context);
  return { records, fetch, sync: () => runInNewContext("syncPendingInspections()", context) as Promise<unknown> };
}

it("retains an offline inspection when HTTP success contains no saved inspection", async () => {
  const w = worker([{ error: { message: "write failed" } }]);
  await w.sync().catch(() => undefined);
  expect(w.records.has("offline-1")).toBe(true);
});

it("retains an offline inspection when the confirmation belongs to another record", async () => {
  const w = worker([{ result: { data: { json: { id: 42, offlineId: "other" } } } }]);
  await w.sync().catch(() => undefined);
  expect(w.records.has("offline-1")).toBe(true);
});

it("coalesces concurrent sync triggers and deletes only the confirmed inspection", async () => {
  const w = worker([{ result: { data: { json: { id: 42, offlineId: "offline-1" } } } }]);
  await Promise.all([w.sync(), w.sync()]);
  expect(w.fetch).toHaveBeenCalledTimes(1);
  expect(w.records.size).toBe(0);
});
