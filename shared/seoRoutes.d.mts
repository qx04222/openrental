export interface SeoRoute {
  /** Route path, e.g. "/mini-excavator-rental". */
  path: string;
  /** Baked HTML output file relative to dist/public, e.g. "mini-excavator-rental/index.html". */
  out: string;
  /** sitemap <priority>, e.g. "0.8". */
  priority: string;
  /** sitemap <changefreq>, e.g. "weekly". */
  changefreq: string;
}

export const SEO_ROUTES: SeoRoute[];
export const SEO_PRERENDER_MAP: Record<string, string>;
