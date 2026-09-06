import "dotenv/config";
import express from "express";
import { readinessHandler, livenessHandler } from "./readiness";
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
  app.get("/health", livenessHandler);
  app.get("/health/ready", readinessHandler);

  // Error logging
  app.use(errorLogger());

  // Vite dev or static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = process.env.NODE_ENV === "production" ? preferredPort : await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    logger.warn(`Port ${preferredPort} busy, using ${port}`);
  }

  server.listen(port, () => {
    logger.info(`OpenRental server running on http://localhost:${port}/`);
  });

  // Stop accepting work before closing the database; the platform can route away.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("server.shutdown");
    const deadline = setTimeout(() => process.exit(1), 25_000).unref();
    const cron = await import("node-cron");
    for (const task of cron.default.getTasks().values()) task.stop();
    server.close(async () => {
      const { closePool } = await import("../db");
      await closePool();
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

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

  // Observe each handler and serialize same-job execution across processes.
  try {
    const { registerScheduledJob } = await import("../services/scheduledJobs");
    const zone = process.env.CRON_TIMEZONE || process.env.TZ || APP_TIMEZONE;
    registerScheduledJob("session_cleanup", "*/5 * * * *", zone, async () => (await import("../jobs/staleSessionCleanup")).runStaleSessionCleanup());
    registerScheduledJob("lifecycle_effects", "*/5 * * * *", zone, async () => (await import("../jobs/rentalLifecycleEffectsCron")).runRentalLifecycleEffectsCron());
    registerScheduledJob("late_fees", "30 3 * * *", zone, async () => (await import("../jobs/lateFeeCron")).runLateFeeCron());
    registerScheduledJob("overdue_status", "0 4 * * *", zone, async () => (await import("../jobs/overdueCron")).runOverdueCron());
    registerScheduledJob("rolling_settlement", "15 4 * * *", zone, async () => (await import("../jobs/rollingSettlementCron")).runRollingSettlementCron());
    registerScheduledJob("price_promotion", "5 0 * * *", zone, async () => (await import("../jobs/promotePricesCron")).runPromotePricesCron());
    registerScheduledJob("rental_reminders", "0 9 * * *", zone, async () => (await import("../jobs/rentalReminderCron")).runRentalReminderCron());
    registerScheduledJob("quotation_expiry", "0 4 * * *", zone, async () => (await import("../jobs/quotationExpiryCron")).runQuotationExpiryCron());
    logger.info("jobs.registered", { count: 8, timezone: zone });
  } catch (error) {
    logger.error("jobs.registration_failed", { error });
  }
}

startServer().catch((error) => {
  logger.error("Failed to start server", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
