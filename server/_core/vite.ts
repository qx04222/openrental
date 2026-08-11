import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

// Pick the right PWA manifest based on URL prefix. Empty string means
// "no manifest" — public marketing pages (/, /rent-equipment, /checkout, …)
// should not offer install. Three audiences each get their own manifest with
// a non-overlapping scope, so the browser identifies them as separate apps.
function manifestLinkForUrl(url: string): string {
  const pathname = url.split("?")[0];
  // Also inject the matching apple-touch-icon so iOS "Add to Home Screen"
  // uses the app-specific badge (inspector = clipboard, others = car) instead
  // of the static default in index.html.
  if (pathname.startsWith("/admin"))
    return '<link rel="manifest" href="/admin-manifest.json" /><link rel="apple-touch-icon" href="/admin-icons/apple-touch-icon.png" />';
  if (pathname.startsWith("/field"))
    return '<link rel="manifest" href="/field-manifest.json" /><link rel="apple-touch-icon" href="/field-icons/apple-touch-icon.png" />';
  if (pathname.startsWith("/portal"))
    return '<link rel="manifest" href="/customer-manifest.json" /><link rel="apple-touch-icon" href="/admin-icons/apple-touch-icon.png" />';
  return "";
}

export async function setupVite(app: Express, server: Server) {
  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: { middlewareMode: true, hmr: { server }, allowedHosts: true as const },
    appType: "custom",
  });

  // Prevent SW caching
  app.use((req, res, next) => {
    if (req.url === "/field-sw.js" || req.url === "/register-sw.js") {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
    next();
  });

  const publicDir = path.resolve(import.meta.dirname, "../..", "client", "public");
  app.use(express.static(publicDir));
  app.use(vite.middlewares);

  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;
    if (url.startsWith("/api/")) return next();
    if (url.match(/\.(png|jpg|jpeg|gif|svg|ico|webp|json|txt|xml|pdf|woff|woff2|ttf|eot)$/)) {
      return res.status(404).send("File not found");
    }

    try {
      const clientTemplate = path.resolve(import.meta.dirname, "../..", "client", "index.html");
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(`src="/src/main.tsx"`, `src="/src/main.tsx?v=${nanoid()}"`);
      template = template.replace("<!--MANIFEST-->", manifestLinkForUrl(url));
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    // eslint-disable-next-line no-console -- dev server status log
    console.error(`Build directory not found: ${distPath}`);
  }

  app.use("/assets", express.static(path.resolve(distPath, "assets"), { maxAge: "1y", immutable: true }));

  app.use((req, res, next) => {
    if (req.url === "/field-sw.js" || req.url === "/register-sw.js") {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
    next();
  });

  app.use(express.static(distPath, {
    index: false, // every route falls through to the SPA template below
    maxAge: "1d",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  }));

  // Single SPA shell for every route (admin/portal/field/...).
  const templatePath = path.resolve(distPath, "index.html");
  let indexHtmlTemplate: string | null = null;
  app.use("*", (req, res) => {
    if (indexHtmlTemplate === null) {
      try {
        indexHtmlTemplate = fs.readFileSync(templatePath, "utf-8");
      } catch {
        return res.status(500).send("Index template not found");
      }
    }
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Type", "text/html");
    res.send(indexHtmlTemplate.replace("<!--MANIFEST-->", manifestLinkForUrl(req.originalUrl)));
  });
}
