import { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { COOKIE_NAME } from "../../shared/const";
import { getAdminSession } from "../adminSession";
import { getFieldSessionUserId } from "../fieldSession";
import { getDb } from "../db";
import { users } from "../../drizzle/schema";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  // Check for admin session
  const adminSession = await getAdminSession(opts.req);
  if (adminSession) {
    try {
      const db = await getDb();
      if (db) {
        // Resolve by stable primary key (userId), not email — email is nullable
        // and admins may log in by username, so an email-less admin would otherwise
        // fail to rehydrate into ctx.user (losing all permissions / identity confusion).
        const [adminUser] = await db.select().from(users).where(and(eq(users.id, adminSession.userId), isNull(users.deletedAt))).limit(1);
        if (adminUser && adminUser.isActive) {
          user = adminUser;
        }
      }
    } catch (error) {
      logger.error("[Context] Error loading admin user", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // Check for field staff session (opaque token -> userId lookup)
  if (!user) {
    const sessionCookie = opts.req.cookies[COOKIE_NAME];
    if (sessionCookie && typeof sessionCookie === "string") {
      const userId = await getFieldSessionUserId(sessionCookie);
      if (userId !== undefined) {
        try {
          const db = await getDb();
          if (db) {
            const [internalUser] = await db.select().from(users).where(and(eq(users.id, userId), isNull(users.deletedAt))).limit(1);
            if (internalUser && internalUser.isActive) {
              user = internalUser;
            }
          }
        } catch (error) {
          logger.error("[Context] Error loading field staff user", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  return { req: opts.req, res: opts.res, user };
}
