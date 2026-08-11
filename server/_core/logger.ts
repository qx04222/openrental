/**
 * Simple logger for OpenRental
 */

import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";

const isProduction = process.env.NODE_ENV === "production";

function formatMessage(level: string, message: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  return `[${ts}] [${level}] ${message}${metaStr}`;
}

/* eslint-disable no-console -- This IS the logger; console is intentional */
export const logger = {
  info(message: string, meta?: Record<string, unknown>) {
    console.log(formatMessage("INFO", message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>) {
    console.warn(formatMessage("WARN", message, meta));
  },
  error(message: string, meta?: Record<string, unknown>) {
    console.error(formatMessage("ERROR", message, meta));
  },
  debug(message: string, meta?: Record<string, unknown>) {
    if (!isProduction) {
      console.debug(formatMessage("DEBUG", message, meta));
    }
  },
};
/* eslint-enable no-console */

export function requestLogger() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      if (!req.path.startsWith("/assets") && !req.path.startsWith("/field-icons")) {
        logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      }
    });
    next();
  };
}

export function errorLogger(): ErrorRequestHandler {
  return (err: Error, req: Request, _res: Response, next: NextFunction) => {
    logger.error(`${req.method} ${req.path}`, { error: err.message });
    next(err);
  };
}

export function expressRateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Periodic cleanup to prevent memory growth
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of hits) {
      if (now > val.resetAt) hits.delete(key);
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count++;
    if (entry.count > limit) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    next();
  };
}
