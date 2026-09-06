import { getDb, isNull, lt, and, eq } from "../db";
import { loginSessions } from "../../drizzle/schema";
export async function runStaleSessionCleanup() {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select({ id: loginSessions.id, loginAt: loginSessions.loginAt, lastActiveAt: loginSessions.lastActiveAt }).from(loginSessions).where(and(isNull(loginSessions.logoutAt), lt(loginSessions.lastActiveAt, new Date(Date.now() - 600_000))));
  for (const row of rows) {
    const end = row.lastActiveAt || row.loginAt;
    await db.update(loginSessions).set({ logoutAt: end, durationSeconds: Math.round((end.getTime() - row.loginAt.getTime()) / 1000) }).where(and(eq(loginSessions.id, row.id), isNull(loginSessions.logoutAt), lt(loginSessions.lastActiveAt, new Date(Date.now() - 600_000))));
  }
}
