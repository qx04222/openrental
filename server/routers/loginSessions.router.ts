import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, gte, lte, desc, sql, isNull } from "../db";
import * as schema from "../../drizzle/schema";
import { ADMIN_COOKIE_NAME } from "../../shared/const";
import { APP_TIMEZONE_SQL } from "../_core/dateUtils";

export const loginSessionsRouter = router({
  heartbeat: protectedProcedure
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return { ok: false };

      const sessionToken = ctx.req.cookies[ADMIN_COOKIE_NAME];
      if (!sessionToken) return { ok: false };

      // Heartbeat is best-effort "keep lastActiveAt fresh" — the client fires it
      // and ignores the result (it only reacts to auth errors). A transient DB
      // blip (pooler recycle, cold start) must not surface as a 5xx, which the
      // fleet audit otherwise flags as P0 noise. Fail soft instead.
      try {
        await db.update(schema.loginSessions)
          .set({ lastActiveAt: new Date() })
          .where(and(
            eq(schema.loginSessions.sessionToken, sessionToken),
            isNull(schema.loginSessions.logoutAt),
          ));
      } catch {
        return { ok: false };
      }

      return { ok: true };
    }),

  list: protectedProcedure.use(moduleGuard('audit_log', 'read'))
    .input(z.object({
      userId: z.number().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      limit: z.number().min(1).max(500).optional(),
      offset: z.number().min(0).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { sessions: [], total: 0 };

      const conditions = [];
      if (input?.userId) {
        conditions.push(eq(schema.loginSessions.userId, input.userId));
      }
      if (input?.startDate) {
        conditions.push(gte(schema.loginSessions.loginAt, new Date(input.startDate)));
      }
      if (input?.endDate) {
        conditions.push(lte(schema.loginSessions.loginAt, new Date(input.endDate)));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const limit = input?.limit || 50;
      const offset = input?.offset || 0;

      const sessions = await db
        .select({
          id: schema.loginSessions.id,
          userId: schema.loginSessions.userId,
          loginAt: schema.loginSessions.loginAt,
          logoutAt: schema.loginSessions.logoutAt,
          lastActiveAt: schema.loginSessions.lastActiveAt,
          durationSeconds: schema.loginSessions.durationSeconds,
          ipAddress: schema.loginSessions.ipAddress,
          browser: schema.loginSessions.browser,
          os: schema.loginSessions.os,
          deviceType: schema.loginSessions.deviceType,
          userName: schema.users.name,
          userUsername: schema.users.username,
        })
        .from(schema.loginSessions)
        .leftJoin(schema.users, eq(schema.loginSessions.userId, schema.users.id))
        .where(where)
        .orderBy(desc(schema.loginSessions.loginAt))
        .limit(limit)
        .offset(offset);

      const [countResult] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.loginSessions)
        .where(where);

      return { sessions, total: countResult?.count ?? 0 };
    }),

  analytics: protectedProcedure.use(moduleGuard('audit_log', 'read'))
    .input(z.object({
      days: z.number().min(1).max(365).optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { totalLogins: 0, avgSessionMinutes: 0, totalActiveHours: 0, activeUsers: 0, loginsByDay: [], topUsers: [] };

      const days = input?.days || 30;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const sinceCondition = gte(schema.loginSessions.loginAt, since);

      // Aggregate stats
      const [stats] = await db
        .select({
          totalLogins: sql<number>`count(*)::int`,
          avgSessionMinutes: sql<number>`coalesce(round(avg("durationSeconds") / 60.0, 1), 0)::float`,
          totalActiveHours: sql<number>`coalesce(round(sum("durationSeconds") / 3600.0, 1), 0)::float`,
          activeUsers: sql<number>`count(distinct "userId")::int`,
        })
        .from(schema.loginSessions)
        .where(sinceCondition);

      // Logins by day
      const loginsByDay = await db
        .select({
          date: sql<string>`to_char(date_trunc('day', (("loginAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})), 'YYYY-MM-DD')`,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.loginSessions)
        .where(sinceCondition)
        .groupBy(sql`date_trunc('day', (("loginAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))`)
        .orderBy(sql`date_trunc('day', (("loginAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))`);

      // Top users
      const topUsers = await db
        .select({
          userId: schema.loginSessions.userId,
          userName: schema.users.name,
          userUsername: schema.users.username,
          loginCount: sql<number>`count(*)::int`,
          totalHours: sql<number>`coalesce(round(sum("durationSeconds") / 3600.0, 1), 0)::float`,
        })
        .from(schema.loginSessions)
        .leftJoin(schema.users, eq(schema.loginSessions.userId, schema.users.id))
        .where(sinceCondition)
        .groupBy(schema.loginSessions.userId, schema.users.name, schema.users.username)
        .orderBy(sql`count(*) desc`)
        .limit(10);

      return {
        totalLogins: stats?.totalLogins ?? 0,
        avgSessionMinutes: stats?.avgSessionMinutes ?? 0,
        totalActiveHours: stats?.totalActiveHours ?? 0,
        activeUsers: stats?.activeUsers ?? 0,
        loginsByDay,
        topUsers,
      };
    }),

  /** Get list of users for filter dropdown */
  userList: protectedProcedure.use(moduleGuard('audit_log', 'read'))
    .query(async () => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select({
          id: schema.users.id,
          name: schema.users.name,
          username: schema.users.username,
        })
        .from(schema.users)
        .where(isNull(schema.users.deletedAt))
        .orderBy(schema.users.name);
    }),
});
