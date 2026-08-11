import type { Request, Response, NextFunction } from "express";

const isProduction = process.env.NODE_ENV === "production";
const appUrl = process.env.VITE_APP_URL || "https://demo.openrental.example";

export function securityHeaders() {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    if (isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          // GA4 (gtag.js) loads from googletagmanager.com; beacons/collect go to
          // google-analytics.com. Inert unless VITE_GA4_ID is set, but the CSP must
          // allow them so analytics works once it is.
          "script-src 'self' https://www.googletagmanager.com",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "img-src 'self' data: blob: https://*.supabase.co https://www.googletagmanager.com https://*.google-analytics.com",
          "font-src 'self' data: https://fonts.gstatic.com",
          "connect-src 'self' https://*.supabase.co https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com",
          // Google Maps embed on the Contact page (the iframe's own tiles/scripts
          // are governed by google's CSP; this page only needs to allow the frame).
          "frame-src 'self' https://www.google.com https://maps.google.com",
          "frame-ancestors 'self'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join("; ")
      );
    }

    res.removeHeader("X-Powered-By");
    next();
  };
}

export function corsConfig() {
  const allowedOrigins = [
    appUrl,
    ...(isProduction ? [] : ["http://localhost:3000", "http://localhost:5173"]),
  ];

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Max-Age", "86400");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
