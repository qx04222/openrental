import { UNAUTHED_ERR_MSG, NOT_ADMIN_ERR_MSG } from "../../shared/const";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { isAuthenticated, isAdmin, isSuperAdmin, isFieldStaff, checkModuleAccess, type Module, type Action } from "../../shared/authRules";
import { rolePermissions, userPermissionOverrides } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { stripScriptTags } from "../utils/sanitize";
import { I18nErrorInfo } from "./i18nError";
import type { getDb } from "../db";

const isProduction = process.env.NODE_ENV === "production";

type FormatterShape = {
  message: string;
  data: Record<string, unknown>;
};

export function formatTrpcError<TShape extends FormatterShape>(
  shape: TShape,
  error: { cause?: unknown },
  production = isProduction
): TShape {
  // In production, hide internal details for UNEXPECTED failures only. tRPC wraps
  // a thrown plain Error as an INTERNAL_SERVER_ERROR; every deliberate
  // `throw new TRPCError({ code: ... })` keeps its own code (BAD_REQUEST,
  // CONFLICT, FORBIDDEN, NOT_FOUND, TOO_MANY_REQUESTS, ...) and its message is
  // curated + safe to surface. Keying off the code (not `error.cause`, which is
  // undefined for a directly-thrown TRPCError) lets those reach the user while
  // still masking genuine internal errors.
  const isUnexpected =
    !(error.cause instanceof TRPCError) &&
    shape.data.code === "INTERNAL_SERVER_ERROR";
  if (production && isUnexpected) {
    return {
      ...shape,
      message: "An internal error occurred. Please try again later.",
      data: { ...shape.data, stack: undefined },
    };
  }

  // Attach the translation hint, when the thrower supplied one via i18nError().
  // The message itself is left untouched on purpose: it is read as logic by
  // client/src/main.tsx (retry on UNAUTHED_ERR_MSG) and by
  // RentalManagement/index.tsx (branches on "blacklisted"/"Credit limit"), and it
  // stays the client's fallback for the ~450 errors not yet migrated.
  const i18n = error.cause instanceof I18nErrorInfo ? error.cause : undefined;

  return {
    ...shape,
    data: {
      ...shape.data,
      stack: production ? undefined : shape.data.stack,
      ...(i18n ? { i18nKey: i18n.i18nKey, i18nParams: i18n.i18nParams } : {}),
    },
  };
}

export const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return formatTrpcError(shape, error, isProduction);
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;

// Sanitize string inputs to strip <script> tags and event handlers (XSS prevention).
// Runs before Zod validation, mutates rawInput in place.
const sanitizeInputMiddleware = t.middleware(async (opts) => {
  const raw = await opts.getRawInput();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "string") {
        obj[key] = stripScriptTags(obj[key] as string);
      }
    }
  }
  return opts.next();
});

// All procedure types chain sanitizeInputMiddleware first
const baseProcedure = t.procedure.use(sanitizeInputMiddleware);

export const publicProcedure = baseProcedure;

const requireUser = t.middleware(async (opts) => {
  if (!isAuthenticated(opts.ctx.user)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return opts.next({ ctx: { ...opts.ctx, user: opts.ctx.user } });
});

export const protectedProcedure = baseProcedure.use(requireUser);

export const adminProcedure = baseProcedure.use(
  t.middleware(async (opts) => {
    if (!isAuthenticated(opts.ctx.user)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }
    if (!isAdmin(opts.ctx.user)) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return opts.next({ ctx: { ...opts.ctx, user: opts.ctx.user } });
  })
);

export const superAdminProcedure = baseProcedure.use(
  t.middleware(async (opts) => {
    if (!isAuthenticated(opts.ctx.user)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }
    if (!isSuperAdmin(opts.ctx.user)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Super admin access required." });
    }
    return opts.next({ ctx: { ...opts.ctx, user: opts.ctx.user } });
  })
);

export const fieldStaffProcedure = baseProcedure.use(
  t.middleware(async (opts) => {
    if (!isAuthenticated(opts.ctx.user)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }
    if (!isFieldStaff(opts.ctx.user)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Field staff role required." });
    }
    return opts.next({ ctx: { ...opts.ctx, user: opts.ctx.user } });
  })
);

// ─── Module-level CRUD permission guard ──────────────────────

// In-memory cache for role permissions (refreshed every 5 minutes)
type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type RolePermissionRow = typeof rolePermissions.$inferSelect;

let rolePermsCache: { data: RolePermissionRow[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

async function getRolePermissions(db: Database) {
  if (rolePermsCache && Date.now() - rolePermsCache.timestamp < CACHE_TTL) {
    return rolePermsCache.data;
  }
  const perms = await db.select().from(rolePermissions);
  rolePermsCache = { data: perms, timestamp: Date.now() };
  return perms;
}

/** Invalidate the role permissions cache (call when permissions are updated). */
export function invalidatePermissionCache() {
  rolePermsCache = null;
}

/**
 * Module-level CRUD permission guard.
 * Usage: protectedProcedure.use(moduleGuard('invoices', 'create'))
 */
export function moduleGuard(module: Module, action: Action) {
  return t.middleware(async (opts) => {
    const { ctx, next } = opts;
    if (!ctx.user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }

    // super_admin bypass
    if (ctx.user.role === 'super_admin') {
      return next({ ctx });
    }

    const { getDb } = await import("../db");
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

    const rolePerms = await getRolePermissions(db);

    // Load user overrides
    const overrides = await db.select()
      .from(userPermissionOverrides)
      .where(eq(userPermissionOverrides.userId, ctx.user.id));

    const allowed = checkModuleAccess(ctx.user.role, module, action, rolePerms, overrides);

    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `No ${action} permission for ${module}`,
      });
    }

    return next({ ctx });
  });
}
