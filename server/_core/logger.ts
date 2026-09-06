/**
 * Simple logger for OpenRental
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction, ErrorRequestHandler } from "express";

const isProduction = process.env.NODE_ENV === "production";

export const requestContext = new AsyncLocalStorage<{ requestId: string }>();
export const logObservation = new AsyncLocalStorage<{ warnings: number; errors: number }>();
const secretKey = /password|secret|token|authorization|cookie|api.?key|signature|database.?url/i;

export function redactLogValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "string") return value
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(/((?:password|secret|token|api[_-]?key|authorization)\s*[=:]\s*)[^\s&,;]+/gi, "$1[REDACTED]");
  if (typeof value === "bigint") return value.toString();
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth > 8) return "[Truncated]";
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: redactLogValue(value.message), stack: redactLogValue(value.stack) };
  if (Array.isArray(value)) return value.map(v => redactLogValue(v, seen, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key,
    secretKey.test(key) ? "[REDACTED]" : redactLogValue(val, seen, depth + 1)]));
}

export function safeRequestPath(path: string): string {
  return path.split("?")[0].replace(/(\/api\/inspection\/verify\/)[^/]+/, "$1[REDACTED]");
}

function formatMessage(level: string, message: string, meta?: Record<string, unknown>) {
  const observed = logObservation.getStore();
  if (observed && level === "WARN") observed.warnings++;
  if (observed && level === "ERROR") observed.errors++;
  return JSON.stringify({ timestamp: new Date().toISOString(), level,
    message: redactLogValue(message), requestId: requestContext.getStore()?.requestId,
    ...(meta ? { meta: redactLogValue(meta) } : {}) });
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
    const path = safeRequestPath(req.originalUrl);
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);
    res.on("finish", () => {
      const duration = Date.now() - start;
      if (!req.path.startsWith("/assets") && !req.path.startsWith("/field-icons")) {
        logger.info("http.request", { requestId, method: req.method, path, status: res.statusCode, durationMs: duration });
      }
    });
    requestContext.run({ requestId }, next);
  };
}

export function errorLogger(): ErrorRequestHandler {
  return (err: Error, req: Request, _res: Response, next: NextFunction) => {
    logger.error(`${req.method} ${safeRequestPath(req.originalUrl)}`, { error: err.message });
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
  }, 5 * 60 * 1000).unref(); // Every 5 minutes

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
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    next();
  };
}
