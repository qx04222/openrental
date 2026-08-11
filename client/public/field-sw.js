/* eslint-disable no-undef */
const CACHE_NAME = "openrental-field-v2";
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for assets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API requests: network only (don't cache)
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // Static assets: cache first, then network (and cache the response)
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/field-icons/")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
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
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
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

async function syncPendingInspections() {
  const db = await openDB();
  const tx = db.transaction(DB_STORE, "readonly");
  const store = tx.objectStore(DB_STORE);

  return new Promise((resolve) => {
    const request = store.getAll();
    request.onsuccess = async () => {
      const items = request.result;
      for (const item of items) {
        try {
          // Match tRPC httpBatchLink format: POST /api/trpc/inspections.create?batch=1
          // Body: { "0": { "json": { ... } } }
          const res = await fetch("/api/trpc/inspections.create?batch=1", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ "0": { json: item } }),
            credentials: "include",
          });
          if (res.ok) {
            const deleteTx = db.transaction(DB_STORE, "readwrite");
            deleteTx.objectStore(DB_STORE).delete(item.offlineId);
          }
        } catch {
          // Will retry on next sync
        }
      }
      resolve();
    };
  });
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
