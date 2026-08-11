/**
 * tRPC Procedures — tests that exercise the real middleware in server/_core/trpc.ts
 * Covers: protectedProcedure, adminProcedure, superAdminProcedure, fieldStaffProcedure
 * using actual createCallerFactory with tiny test routers.
 */
import { describe, it, expect } from "vitest";
import { t, publicProcedure, protectedProcedure, adminProcedure, superAdminProcedure, fieldStaffProcedure, router } from "../server/_core/trpc";
import { formatTrpcError } from "../server/_core/trpc";
import type { TrpcContext } from "../server/_core/context";
import type { User } from "../drizzle/schema";
import { TRPCError } from "@trpc/server";

// A tiny router that exposes all 5 procedure types
const testRouter = router({
  publicEndpoint: publicProcedure.query(() => "public_ok"),
  protectedEndpoint: protectedProcedure.query(() => "protected_ok"),
  adminEndpoint: adminProcedure.query(() => "admin_ok"),
  superAdminEndpoint: superAdminProcedure.query(() => "super_admin_ok"),
  fieldStaffEndpoint: fieldStaffProcedure.query(() => "field_staff_ok"),
});

const createCaller = t.createCallerFactory(testRouter);

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1, email: "user@test.com", name: "Test", username: "testuser",
    role: "admin", isActive: true, passwordHash: null, phone: null,
    createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    lastSignedIn: null, loginMethod: null,
    ...overrides,
  };
}

function makeCtx(user: User | null = null): TrpcContext {
  return {
    req: { ip: "127.0.0.1", cookies: {} } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
    user,
  };
}

describe("tRPC procedure middleware", () => {
  describe("formatTrpcError", () => {
    it("masks internal errors in production", () => {
      const shape = {
        message: "Original message",
        data: { stack: "stacktrace", code: "INTERNAL_SERVER_ERROR" },
      };

      expect(formatTrpcError(shape, { cause: new Error("boom") }, true)).toEqual({
        message: "An internal error occurred. Please try again later.",
        data: { stack: undefined, code: "INTERNAL_SERVER_ERROR" },
      });
    });

    it("preserves explicit tRPC errors in production", () => {
      const shape = {
        message: "Forbidden",
        data: { stack: "stacktrace", code: "FORBIDDEN" },
      };

      expect(formatTrpcError(shape, { cause: new TRPCError({ code: "FORBIDDEN" }) }, true)).toEqual({
        message: "Forbidden",
        data: { stack: undefined, code: "FORBIDDEN" },
      });
    });

    it("preserves a directly-thrown TRPCError message in production (cause undefined)", () => {
      // Regression: a procedure doing `throw new TRPCError({ code: "BAD_REQUEST", message })`
      // leaves error.cause undefined, so masking must key off the code — not cause —
      // or every curated validation/credit/availability message leaks as a generic
      // "internal error" to users.
      const shape = {
        message: "Start date must be before end date",
        data: { stack: "stacktrace", code: "BAD_REQUEST" },
      };

      expect(formatTrpcError(shape, { cause: undefined }, true)).toEqual({
        message: "Start date must be before end date",
        data: { stack: undefined, code: "BAD_REQUEST" },
      });
    });

    it("keeps stack details in development", () => {
      const shape = {
        message: "Original message",
        data: { stack: "stacktrace", code: "INTERNAL_SERVER_ERROR" },
      };

      expect(formatTrpcError(shape, { cause: new Error("boom") }, false)).toEqual(shape);
    });
  });

  // ── publicProcedure ─────────────────────────────────────────────
  describe("publicProcedure", () => {
    it("allows unauthenticated access", async () => {
      const caller = createCaller(makeCtx());
      expect(await caller.publicEndpoint()).toBe("public_ok");
    });

    it("allows authenticated access", async () => {
      const caller = createCaller(makeCtx(makeUser()));
      expect(await caller.publicEndpoint()).toBe("public_ok");
    });
  });

  // ── protectedProcedure ──────────────────────────────────────────
  describe("protectedProcedure", () => {
    it("rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.protectedEndpoint()).rejects.toThrow("Please login");
    });

    it("allows any authenticated user", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "user" })));
      expect(await caller.protectedEndpoint()).toBe("protected_ok");
    });
  });

  // ── adminProcedure ──────────────────────────────────────────────
  describe("adminProcedure", () => {
    it("rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.adminEndpoint()).rejects.toThrow("Please login");
    });

    it("rejects non-admin users", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "field_staff" })));
      await expect(caller.adminEndpoint()).rejects.toThrow("permission");
    });

    it("allows admin", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "admin" })));
      expect(await caller.adminEndpoint()).toBe("admin_ok");
    });

    it("allows super_admin", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "super_admin" })));
      expect(await caller.adminEndpoint()).toBe("admin_ok");
    });
  });

  // ── superAdminProcedure ─────────────────────────────────────────
  describe("superAdminProcedure", () => {
    it("rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.superAdminEndpoint()).rejects.toThrow("Please login");
    });

    it("rejects regular admin", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "admin" })));
      await expect(caller.superAdminEndpoint()).rejects.toThrow("Super admin");
    });

    it("rejects field staff", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "field_staff" })));
      await expect(caller.superAdminEndpoint()).rejects.toThrow("Super admin");
    });

    it("allows super_admin", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "super_admin" })));
      expect(await caller.superAdminEndpoint()).toBe("super_admin_ok");
    });
  });

  // ── fieldStaffProcedure ─────────────────────────────────────────
  describe("fieldStaffProcedure", () => {
    it("rejects unauthenticated", async () => {
      const caller = createCaller(makeCtx());
      await expect(caller.fieldStaffEndpoint()).rejects.toThrow("Please login");
    });

    it("rejects user role", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "user" })));
      await expect(caller.fieldStaffEndpoint()).rejects.toThrow("Field staff role");
    });

    it("allows field_staff", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "field_staff" })));
      expect(await caller.fieldStaffEndpoint()).toBe("field_staff_ok");
    });

    it("allows admin (admins can do field work)", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "admin" })));
      expect(await caller.fieldStaffEndpoint()).toBe("field_staff_ok");
    });

    it("allows super_admin", async () => {
      const caller = createCaller(makeCtx(makeUser({ role: "super_admin" })));
      expect(await caller.fieldStaffEndpoint()).toBe("field_staff_ok");
    });
  });
});
