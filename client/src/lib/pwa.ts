const DB_NAME = "openrental-field-db";
const SW_PATH = "/field-sw.js";

export type PwaAudience = "customer" | "admin" | "field";

/**
 * Three audiences each own a non-overlapping URL prefix. Public marketing
 * routes (/, /rent-equipment, /checkout, …) return null and get NO manifest
 * — installable PWAs are gated to the authenticated/staff areas only.
 *
 * Must stay in sync with `manifestLinkForUrl` in server/_core/vite.ts.
 */
export function audienceForPath(pathname: string): PwaAudience | null {
  if (pathname.startsWith("/admin")) return "admin";
  if (pathname.startsWith("/field")) return "field";
  if (pathname.startsWith("/portal")) return "customer";
  return null;
}

const MANIFEST_PATHS: Record<PwaAudience, string> = {
  customer: "/customer-manifest.json",
  admin: "/admin-manifest.json",
  field: "/field-manifest.json",
};

/**
 * SPA-navigation fallback: keep the <link rel="manifest"> in sync as the
 * router pushes new URLs without a full page reload. The initial manifest
 * is injected server-side by manifestLinkForUrl(); this function only
 * handles route changes after first paint.
 */
export function applyManifestForRoute(pathname: string = window.location.pathname) {
  const audience = audienceForPath(pathname);
  const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;

  if (audience === null) {
    if (link) link.remove();
    return;
  }

  const target = MANIFEST_PATHS[audience];
  if (!link) {
    const fresh = document.createElement("link");
    fresh.rel = "manifest";
    fresh.href = target;
    document.head.appendChild(fresh);
    return;
  }
  if (!link.href.endsWith(target)) {
    link.href = target;
  }
}

export function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        const registration = await navigator.serviceWorker.register(SW_PATH, { scope: "/" });
        // eslint-disable-next-line no-console -- intentional SW registration log
        console.log("[PWA] Service worker registered:", registration.scope);
      } catch (error) {
        // eslint-disable-next-line no-console -- intentional SW registration warning
        console.warn("[PWA] Service worker registration failed:", error);
      }
    });
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

export function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
  });
}

export function getInstallPrompt() {
  return deferredPrompt;
}

export function clearInstallPrompt() {
  deferredPrompt = null;
}

// IndexedDB helpers for offline inspection storage
export interface PendingInspection {
  offlineId: string;
  [key: string]: unknown;
}

export async function openFieldDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("pendingInspections")) {
        db.createObjectStore("pendingInspections", { keyPath: "offlineId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePendingInspection(data: PendingInspection): Promise<void> {
  const db = await openFieldDb();
  const tx = db.transaction("pendingInspections", "readwrite");
  tx.objectStore("pendingInspections").put(data);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingInspections(): Promise<PendingInspection[]> {
  const db = await openFieldDb();
  const tx = db.transaction("pendingInspections", "readonly");
  const store = tx.objectStore("pendingInspections");
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as PendingInspection[]);
    request.onerror = () => reject(request.error);
  });
}

export async function removePendingInspection(offlineId: string): Promise<void> {
  const db = await openFieldDb();
  const tx = db.transaction("pendingInspections", "readwrite");
  tx.objectStore("pendingInspections").delete(offlineId);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
