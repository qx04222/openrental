import { z } from "zod";
import { router, publicProcedure, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq } from "../db";
import * as schema from "../../drizzle/schema";

export const siteSettingsRouter = router({
  getAll: publicProcedure.query(async () => {
    const db = await getDb();
    if (!db) return {};

    const settings = await db.select().from(schema.siteSettings);
    const result: Record<string, string> = {};
    for (const s of settings) {
      result[s.key] = s.value;
    }
    return result;
  }),

  update: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({
      key: z.string(),
      value: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [existing] = await db
        .select()
        .from(schema.siteSettings)
        .where(eq(schema.siteSettings.key, input.key))
        .limit(1);

      if (existing) {
        await db
          .update(schema.siteSettings)
          .set({ value: input.value, updatedAt: new Date() })
          .where(eq(schema.siteSettings.key, input.key));
      } else {
        await db.insert(schema.siteSettings).values({
          key: input.key,
          value: input.value,
        });
      }

      return { success: true };
    }),

  bulkUpdate: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.record(z.string(), z.string()))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      for (const [key, value] of Object.entries(input)) {
        const [existing] = await db
          .select()
          .from(schema.siteSettings)
          .where(eq(schema.siteSettings.key, key))
          .limit(1);

        if (existing) {
          await db
            .update(schema.siteSettings)
            .set({ value, updatedAt: new Date() })
            .where(eq(schema.siteSettings.key, key));
        } else {
          await db.insert(schema.siteSettings).values({ key, value });
        }
      }

      return { success: true };
    }),
});
