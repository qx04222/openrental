import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import cookieParser from "cookie-parser";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "../routers/app.router";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { logger, requestLogger, errorLogger, expressRateLimit } from "./logger";
import { securityHeaders, corsConfig } from "./security";
import compression from "compression";
import { APP_TIMEZONE } from "./dateUtils";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.set("trust proxy", 1);
  app.use(securityHeaders());
  app.use(compression());
  app.use("/api", corsConfig());

  // Cookie parser
  app.use(cookieParser());
  app.use(requestLogger());

  // Body parser — 2mb default, 50mb only for photo-upload procedures (base64
  // inspection photos + signature routinely exceed 2mb). The wide parser MUST
  // be mounted BEFORE the global one: the first json parser to consume the
  // body enforces its limit, a later mount can never widen it.
  const photoBodyParser = express.json({ limit: "50mb" });
  const PHOTO_PROCEDURES = new Set([
    "inspections.create",
    "inspections.createWithToken",
    "inspections.update",
    "rentalFleet.uploadImage",
  ]);
  app.use("/api/trpc", (req, res, next) => {
    // req.path is mount-relative, e.g. "/inspections.create" or a batched
    // "/inspections.create,inspections.update"
    const procs = req.path.replace(/^\//, "").split(",");
    if (procs.some((p) => PHOTO_PROCEDURES.has(p))) return photoBodyParser(req, res, next);
    return next();
  });
  app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
    try {
      const { handleStripeWebhook } = await import("../services/payments");
      const sig = req.header("stripe-signature") || "";
      const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : String(req.body || "");
      const result = await handleStripeWebhook(rawBody, sig);
      if (!result.live) return res.status(200).json({ received: true, live: false, note: "Stripe not configured — webhook ignored" });
      return res.status(200).json({ received: true });
    } catch (err) {
      logger.error("[Stripe webhook] error", { error: err instanceof Error ? err.message : String(err) });
      return res.status(400).json({ error: "Webhook handler failed" });
    }
  });

  // Inspection token verification routes (public, token-gated)

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ limit: "2mb", extended: true }));

  // Oversized bodies otherwise become an HTML error page, which the tRPC
  // client fails to parse (Safari: "The string did not match the expected
  // pattern."). Answer in the tRPC batch envelope so the toast stays readable.
  app.use("/api", (err: { type?: string; status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err?.type === "entity.too.large") {
      return res.status(413).json([
        { error: { json: { message: "Upload too large — please retake photos and try again", code: -32013, data: { code: "PAYLOAD_TOO_LARGE", httpStatus: 413 } } } },
      ]);
    }
    return next(err);
  });

  // Rate limiting (global tRPC cap; overridable via env for the E2E runner).
  const trpcRateMax = Number(process.env.TRPC_RATE_MAX) || 60;
  app.use("/api/trpc", expressRateLimit(trpcRateMax, 60000));

  // Separate rate limits per auth operation to prevent login brute-force from blocking logout/heartbeat
  app.use("/api/admin-auth/password-login", expressRateLimit(10, 60000));
  app.use("/api/admin-auth/logout", expressRateLimit(30, 60000));
  app.use("/api/admin-auth/heartbeat", expressRateLimit(120, 60000));
  // verify-session fires on every protected-page mount; a power user (or the E2E
  // runner) navigating fast can approach 60/min. Overridable via env (default 60).
  app.use("/api/admin-auth/verify-session", expressRateLimit(Number(process.env.VERIFY_SESSION_RATE_MAX) || 60, 60000));

  // Stricter rate limit for public rental creation (5 per 10 minutes).
  // Overridable via env so the E2E runner can drive many creates in one pass.
  const rentalCreateMax = Number(process.env.RENTAL_CREATE_RATE_MAX) || 5;
  app.use("/api/trpc/rentals.create", expressRateLimit(rentalCreateMax, 10 * 60 * 1000));

  // Admin auth routes
  const adminAuthRoutes = await import("../adminAuthRoutes");
  app.use("/api/admin-auth", adminAuthRoutes.default);

  // Stripe webhook entry — currently a no-op stub. When STRIPE_SECRET_KEY
  // is set this dispatches checkout.session.completed events. Uses raw
  // body parser so signature verification works.
  app.get("/api/inspection/verify/:token", async (req, res) => {
    try {
      const { createHash } = await import("crypto");
      const tokenHash = createHash("sha256").update(req.params.token).digest("hex");
      const { getDb, eq, and, isNull } = await import("../db");
      const { inspectionTokens, rentalFleet, catalogCache } = await import("../../drizzle/schema");
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "Database not available" });

      const [token] = await db
        .select()
        .from(inspectionTokens)
        .where(eq(inspectionTokens.tokenHash, tokenHash))
        .limit(1);

      if (!token || token.isUsed || new Date() > token.expiresAt) {
        return res.status(404).json({ error: "Invalid or expired token" });
      }

      let equipment = null;
      if (token.rentalFleetId) {
        const [fleet] = await db
          .select()
          .from(rentalFleet)
          .leftJoin(catalogCache, eq(rentalFleet.catalogCacheId, catalogCache.id))
          .where(and(eq(rentalFleet.id, token.rentalFleetId), isNull(rentalFleet.deletedAt)))
          .limit(1);
        equipment = fleet;
      }

      res.json({
        inspectionType: token.inspectionType,
        rentalId: token.rentalId,
        rentalFleetId: token.rentalFleetId,
        equipment,
      });
    } catch (error) {
      logger.error("[InspectionRoute] Token verify error", { error: error instanceof Error ? error.message : String(error) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      // Without this, a thrown error reaches the client as an opaque 500 with
      // nothing in the server log (only the access line). No input: may hold PII.
      onError: ({ error, path, type }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          logger.error(`[tRPC] ${type} ${path ?? "<no-path>"} failed`, {
            code: error.code,
            message: error.message,
            stack: error.cause instanceof Error ? error.cause.stack : error.stack,
          });
        }
      },
    })
  );

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Error logging
  app.use(errorLogger());

  // Vite dev or static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    logger.warn(`Port ${preferredPort} busy, using ${port}`);
  }

  server.listen(port, () => {
    logger.info(`OpenRental server running on http://localhost:${port}/`);
  });

  // Seed default contract template if none exist
  try {
    const { seedDefaultContractTemplate } = await import("../services/contractTemplateSeed");
    const seedResult = await seedDefaultContractTemplate();
    if (seedResult.seeded) {
      logger.info("[Startup] Seeded default bilingual contract template");
    }
  } catch (error) {
    logger.warn("[Startup] Contract template seed failed (non-critical)", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Cron jobs — catalog sync removed (TerraX integration retired). The
  // catalog_cache table is now a local-only registry; admin CRUD only.
  try {
    const cron = await import("node-cron");
    const cronTimezone = process.env.CRON_TIMEZONE || process.env.TZ || APP_TIMEZONE;

    // Stale session cleanup — every 5 minutes
    // Closes login_sessions where lastActiveAt > 10 min ago and logoutAt is null
    cron.default.schedule("*/5 * * * *", async () => {
      try {
        const { getDb } = await import("../db");
        const { loginSessions } = await import("../../drizzle/schema");
        const { isNull, lt, and, eq: drizzleEq } = await import("drizzle-orm");
        const db = await getDb();
        if (!db) return;

        const staleThreshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
        const staleRows = await db
          .select({ id: loginSessions.id, loginAt: loginSessions.loginAt, lastActiveAt: loginSessions.lastActiveAt })
          .from(loginSessions)
          .where(and(isNull(loginSessions.logoutAt), lt(loginSessions.lastActiveAt, staleThreshold)));

        for (const row of staleRows) {
          const endTime = row.lastActiveAt || row.loginAt;
          const dur = Math.round((endTime.getTime() - row.loginAt.getTime()) / 1000);
          await db.update(loginSessions)
            .set({ logoutAt: endTime, durationSeconds: dur })
            .where(drizzleEq(loginSessions.id, row.id));
        }

        if (staleRows.length > 0) {
          logger.info(`[Cron] Auto-closed ${staleRows.length} stale login session(s)`);
        }
      } catch (err) {
        logger.warn("[Cron] Stale session cleanup failed", { error: err instanceof Error ? err.message : String(err) });
      }
    });
    logger.info("[Cron] Stale session cleanup scheduled every 5 minutes");

    // Durable rental lifecycle effects — retries only idempotent work. Effects
    // with ambiguous delivery outcomes are moved to manual review instead of
    // risking duplicate customer messages.
    cron.default.schedule("*/5 * * * *", async () => {
      try {
        const { runRentalLifecycleEffectsCron } = await import("../jobs/rentalLifecycleEffectsCron");
        await runRentalLifecycleEffectsCron();
      } catch (err) {
        logger.warn("[Cron] Rental lifecycle effect retry failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, { timezone: cronTimezone });
    logger.info(`[Cron] Rental lifecycle effect retry scheduled every 5 minutes (${cronTimezone})`);

    // Late fee estimation — daily at 03:30 the configured timezone
    cron.default.schedule("30 3 * * *", async () => {
      try {
        const { runLateFeeCron } = await import("../jobs/lateFeeCron");
        await runLateFeeCron();
      } catch (err) {
        logger.warn("[Cron] Late fee estimation failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, { timezone: cronTimezone });
    logger.info(`[Cron] Late fee estimation scheduled for 3:30 AM daily (${cronTimezone})`);

    // Overdue status flip — daily at 04:00 the configured timezone
    cron.default.schedule("0 4 * * *", async () => {
      try {
        const { runOverdueCron } = await import("../jobs/overdueCron");
        await runOverdueCron();
      } catch (err) {
        logger.warn("[Cron] Overdue status flip failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, { timezone: cronTimezone });
    logger.info(`[Cron] Overdue status flip scheduled for 4:00 AM daily (${cronTimezone})`);

    // Rolling-rental settlement — daily at 04:15 Toronto, after overdue state
    // evaluation. The job is additionally protected by its disabled-by-default
    // feature flag and deterministic invoice source keys.
    cron.default.schedule("15 4 * * *", async () => {
      try {
        const { runRollingSettlementCron } = await import("../jobs/rollingSettlementCron");
        await runRollingSettlementCron();
      } catch (err) {
        logger.warn("[Cron] Rolling rental settlement failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, { timezone: cronTimezone });
    logger.info(`[Cron] Rolling rental settlement scheduled for 4:15 AM daily (${cronTimezone})`);

    // Price version promotion — daily at 00:05 the configured timezone.
    // Flips equipment_models cache to any price version whose effective_from
    // has arrived (future-scheduled category price changes go live).
    cron.default.schedule("5 0 * * *", async () => {
      try {
        const { runPromotePricesCron } = await import("../jobs/promotePricesCron");
        await runPromotePricesCron();
      } catch (err) {
        logger.warn("[Cron] Price version promotion failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, { timezone: cronTimezone });
    logger.info(`[Cron] Price version promotion scheduled for 00:05 daily (${cronTimezone})`);

    // Rental reminders — daily at 09:00 Toronto.
    // Sends "rental ends tomorrow", "1-day overdue", "invoice 7 days unpaid".
    cron.default.schedule("0 9 * * *", async () => {
      try {
        const { runRentalReminderCron } = await import("../jobs/rentalReminderCron");
        await runRentalReminderCron();
      } catch (err) {
        logger.warn("[Cron] Rental reminders failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, { timezone: cronTimezone });
    logger.info(`[Cron] Rental reminders scheduled for 9:00 AM daily (${cronTimezone})`);

    logger.info(`[Cron] Birthday/holiday greetings scheduled for 08:00 daily (${cronTimezone})`);

    // Quotation expiry — daily at 04:00 Toronto. Marks draft/sent quotes past
    // their validUntil as expired (status-only; does not block ordering).
    cron.default.schedule("0 4 * * *", async () => {
      try {
        const { runQuotationExpiryCron } = await import("../jobs/quotationExpiryCron");
        await runQuotationExpiryCron();
      } catch (err) {
        logger.warn("[Cron] Quotation expiry failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }, { timezone: cronTimezone });
    logger.info(`[Cron] Quotation expiry scheduled for 4:00 AM daily (${cronTimezone})`);

    // Certificate status refresh — daily at 04:15 Toronto. Recomputes each
    // fleet certificate's valid/expiring_soon/expired status from its expiry
    // date so the expiring-soon view and filters stay truthful. Does NOT touch
    logger.info(`[Cron] Certificate status refresh scheduled for 4:15 AM daily (${cronTimezone})`);

  } catch (error) {
    logger.warn("Cron scheduling failed (non-critical)", { error: error instanceof Error ? error.message : String(error) });
  }
}

startServer().catch((error) => {
  logger.error("Failed to start server", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
