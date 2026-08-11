import { useEffect } from "react";

/**
 * Lightweight per-route SEO head manager — no dependency, client-only.
 *
 * Sets the document title, description, canonical, robots, OpenGraph/Twitter
 * tags, and an optional page-level JSON-LD block, then cleans the JSON-LD up on
 * unmount. Google renders JS so it sees these; non-JS scrapers fall back to the
 * static tags in index.html. (Full coverage for non-JS crawlers needs build-time
 * prerendering — tracked separately in docs/seo/.)
 */

export const SITE_URL = (
  (import.meta.env.VITE_APP_URL as string | undefined) || "https://demo.openrental.example"
).replace(/\/$/, "");

interface SeoProps {
  title: string;
  description?: string;
  /** Path (e.g. "/contact"); resolved against SITE_URL for canonical + og:url. */
  path?: string;
  noindex?: boolean;
  image?: string;
  /** A JSON-LD object (or array of objects) injected as <script type=application/ld+json>. */
  jsonLd?: object | object[];
}

function upsertMeta(attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertLink(rel: string, href: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

export default function Seo({ title, description, path, noindex, image, jsonLd }: SeoProps) {
  useEffect(() => {
    const url = path ? `${SITE_URL}${path}` : `${SITE_URL}/`;
    const img = image ? (image.startsWith("http") ? image : `${SITE_URL}${image}`) : `${SITE_URL}/og-cover.png`;

    document.title = title;
    upsertMeta("name", "robots", noindex ? "noindex, nofollow" : "index, follow");
    upsertLink("canonical", url);
    upsertMeta("property", "og:title", title);
    upsertMeta("property", "og:url", url);
    upsertMeta("property", "og:image", img);
    upsertMeta("name", "twitter:title", title);
    upsertMeta("name", "twitter:image", img);
    if (description) {
      upsertMeta("name", "description", description);
      upsertMeta("property", "og:description", description);
      upsertMeta("name", "twitter:description", description);
    }

    let script: HTMLScriptElement | null = null;
    if (jsonLd) {
      script = document.createElement("script");
      script.type = "application/ld+json";
      script.setAttribute("data-seo", "route");
      script.text = JSON.stringify(jsonLd);
      document.head.appendChild(script);
    }
    return () => {
      if (script) script.remove();
    };
  }, [title, description, path, noindex, image, jsonLd]);

  return null;
}
