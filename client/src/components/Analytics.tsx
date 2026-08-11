import { useEffect, useRef } from "react";

// GA4 measurement ID. Deliberately has no default: a hardcoded one would send
// every self-hoster's traffic into somebody else's analytics property. Unset
// means gtag is never loaded at all.
const GA_ID = (import.meta.env.VITE_GA4_ID as string | undefined) || "";

// Skip tracking on localhost, so `npm run dev` never pollutes a real property.
function isLocalHost(): boolean {
  const h = typeof window !== "undefined" ? window.location.hostname : "";
  return h === "localhost" || h === "127.0.0.1" || h === "" || h.endsWith(".local");
}

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/**
 * Fire a GA4 conversion/interaction event (e.g. "generate_lead", "add_to_cart").
 * Safe to call from anywhere: no-ops on localhost, when GA is disabled, or before
 * gtag.js has loaded (only loaded on the public marketing surface). Mark the lead
 * events as Key Events in the GA4 admin to count them as conversions.
 */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  if (!GA_ID || isLocalHost() || typeof window === "undefined" || !window.gtag) return;
  window.gtag("event", name, params || {});
}

/**
 * GA4 page-view tracking, scoped to the public marketing surface (the internal
 * ERP/admin/field pages are excluded by the `enabled` prop App passes in). Loads
 * gtag.js lazily on the first public page, then emits a page_view on each public
 * route change — SPA navigations don't reload the page, so GA4 needs the manual hit.
 */
export default function Analytics({ path, enabled }: { path: string; enabled: boolean }) {
  const loaded = useRef(false);

  // Load gtag.js once, the first time we land on a public page.
  useEffect(() => {
    if (!GA_ID || !enabled || loaded.current || isLocalHost()) return;
    loaded.current = true;

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(script);

    window.dataLayer = window.dataLayer || [];
    window.gtag = (...args: unknown[]) => {
      window.dataLayer!.push(args);
    };
    window.gtag("js", new Date());
    // We emit page_view ourselves on every navigation, so disable the automatic one.
    window.gtag("config", GA_ID, { send_page_view: false });
  }, [enabled]);

  // One page_view per public route change.
  useEffect(() => {
    if (!GA_ID || !enabled || isLocalHost() || !window.gtag) return;
    window.gtag("event", "page_view", {
      page_path: path,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [path, enabled]);

  return null;
}
