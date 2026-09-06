/* eslint-disable no-undef */
const CACHE_NAME = "openrental-field-v4";
const DB_NAME = "openrental-field-db";
const DB_STORE = "pendingInspections";

const PRECACHE_URLS = [
  "/",
  "/field-dashboard",
  "/field-inspection",
  "/field-access",
  "/field-deliveries",
];

// Install: precache essential pages
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("openrental-field-") && k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // API requests: network only (don't cache)
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Static assets: cache first, then network (and cache the response)
  if (url.pathname === "/surface-init.js" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/field-icons/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const clone = response.clone();
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Navigation: network first, fallback to cache
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => {
          return caches.match(event.request).then((r) => r || caches.match("/"));
        })
    );
    return;
  }
});

// Background sync for offline inspections
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-inspections") {
    event.waitUntil(syncPendingInspections());
  }
});

// Online fallback also works in browsers without Background Sync support.
self.addEventListener("message", (event) => {
  if (event.data?.type === "SYNC_INSPECTIONS") event.waitUntil(syncPendingInspections());
});

let syncInFlight;
function syncPendingInspections() {
  if (!syncInFlight) syncInFlight = flushInspections().finally(() => { syncInFlight = undefined; });
  return syncInFlight;
}

async function flushInspections() {
  const db = await openDB();
  try {
    const items = await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let failed = false;
    for (const item of items) {
      try {
        const res = await fetch("/api/trpc/inspections.create?batch=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ "0": { json: item } }),
          credentials: "include",
        });
        if (!res.ok) throw new Error("Inspection not acknowledged");
        const body = await res.json();
        const saved = body?.[0]?.result?.data?.json;
        if (!saved?.id || saved.offlineId !== item.offlineId) throw new Error("Inspection confirmation mismatch");
        await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, "readwrite");
          tx.objectStore(DB_STORE).delete(item.offlineId);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch {
        failed = true; // Keep the full local record for a future authenticated retry.
      }
    }
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) client.postMessage({ type: "INSPECTION_SYNC_FINISHED", failed });
    if (failed) throw new Error("Some inspections remain pending");
  } finally {
    db.close();
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "offlineId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
