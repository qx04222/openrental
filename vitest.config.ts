import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "shared/**",
        "client/src/lib/**",
        "server/services/pricingCalculation.ts",
        "server/services/taxCalculation.ts",
        "server/adminSession.ts",
        "server/fieldSession.ts",
        "server/_core/trpc.ts",
        "server/routers/dispatch.router.ts",
        "server/routers/inspections.router.ts",
        "server/routers/rentalRequests.router.ts",
        "server/routers/fieldAuth.ts",
        "server/adminAuthRoutes.ts",
      ],
      exclude: [
        "**/node_modules/**",
        "dist/**",
        "client/src/lib/trpc.ts",
        "client/src/lib/pwa.ts",
        "client/src/lib/imageUtils.ts",
      ],
      // Ratchet floor, slightly below current actual (lines 53.6 / stmts 52.0 /
      // funcs 60.2 / branches 46.7). The old 93/91 values were aspirational and
      // never met — CI ran plain `npm test` (no --coverage) so the gate never
      // fired. These realistic floors make `test:coverage` an enforceable gate
      // that blocks regression; raise them as unit coverage grows. (The big
      // routers in `include` are covered by the real-path e2e suite, not unit
      // tests, so their unit-coverage is intentionally low here.)
      thresholds: {
        lines: 53,
        functions: 60,
        branches: 46,
        statements: 52,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@server": path.resolve(__dirname, "server"),
      "@db": path.resolve(__dirname, "server/db"),
      "@core": path.resolve(__dirname, "server/_core"),
    },
  },
});
