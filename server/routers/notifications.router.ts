import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, desc, sql } from "../db";
import * as schema from "../../drizzle/schema";
import {
  sendEmail,
  sendSMS,
  testEmailConnection,
  testSmsConnection,
  getNotificationStats,
  renderTemplate,
} from "../services/notifications";

export const notificationsRouter = router({
  // ─── Provider config ────────────────────────────────────────
  getConfig: protectedProcedure.use(moduleGuard('settings', 'read'))
    .input(z.object({ provider: z.string() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select()
        .from(schema.notificationSettings)
        .where(eq(schema.notificationSettings.provider, input.provider));
    }),

  getAllConfig: protectedProcedure.use(moduleGuard('settings', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];

    return db
      .select()
      .from(schema.notificationSettings)
      .orderBy(schema.notificationSettings.provider);
  }),

  saveConfig: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({
      provider: z.string().max(50),
      configKey: z.string().max(100),
      configValue: z.string().max(2000),
      isActive: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Upsert: check if exists
      const [existing] = await db
        .select()
        .from(schema.notificationSettings)
        .where(and(
          eq(schema.notificationSettings.provider, input.provider),
          eq(schema.notificationSettings.configKey, input.configKey),
        ))
        .limit(1);

      if (existing) {
        const [result] = await db
          .update(schema.notificationSettings)
          .set({
            configValue: input.configValue,
            isActive: input.isActive ?? true,
            updatedAt: new Date(),
          })
          .where(eq(schema.notificationSettings.id, existing.id))
          .returning();
        return result;
      } else {
        const [result] = await db.insert(schema.notificationSettings).values({
          provider: input.provider,
          configKey: input.configKey,
          configValue: input.configValue,
          isActive: input.isActive ?? true,
        }).returning();
        return result;
      }
    }),

  saveBulkConfig: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({
      configs: z.array(z.object({
        provider: z.string().max(50),
        configKey: z.string().max(100),
        configValue: z.string().max(2000),
      })).max(50),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      for (const cfg of input.configs) {
        if (!cfg.configValue && cfg.configValue !== "false") continue;

        const [existing] = await db
          .select()
          .from(schema.notificationSettings)
          .where(and(
            eq(schema.notificationSettings.provider, cfg.provider),
            eq(schema.notificationSettings.configKey, cfg.configKey),
          ))
          .limit(1);

        if (existing) {
          await db
            .update(schema.notificationSettings)
            .set({ configValue: cfg.configValue, updatedAt: new Date() })
            .where(eq(schema.notificationSettings.id, existing.id));
        } else {
          await db.insert(schema.notificationSettings).values({
            provider: cfg.provider,
            configKey: cfg.configKey,
            configValue: cfg.configValue,
          });
        }
      }

      return { success: true };
    }),

  deleteConfig: protectedProcedure.use(moduleGuard('settings', 'delete'))
    .input(z.object({ provider: z.string().max(50), configKey: z.string().max(100) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db
        .delete(schema.notificationSettings)
        .where(and(
          eq(schema.notificationSettings.provider, input.provider),
          eq(schema.notificationSettings.configKey, input.configKey),
        ));
      return { success: true };
    }),

  // ─── Connection tests ───────────────────────────────────────
  testEmailConnection: protectedProcedure.use(moduleGuard('settings', 'update')).mutation(async () => {
    return testEmailConnection();
  }),

  testSmsConnection: protectedProcedure.use(moduleGuard('settings', 'update')).mutation(async () => {
    return testSmsConnection();
  }),

  // ─── Stats ──────────────────────────────────────────────────
  getStats: protectedProcedure.use(moduleGuard('settings', 'read')).query(async () => {
    return getNotificationStats();
  }),

  // ─── Templates ──────────────────────────────────────────────
  getTemplates: protectedProcedure.use(moduleGuard('settings', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];

    return db
      .select()
      .from(schema.notificationTemplates)
      .orderBy(schema.notificationTemplates.event);
  }),

  saveTemplate: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({
      id: z.number().optional(),
      name: z.string().min(1).max(255),
      channel: z.string().max(50),
      event: z.string().max(100),
      subject: z.string().max(500).optional(),
      body: z.string().min(1).max(10000),
      isActive: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      if (input.id) {
        const { id, ...data } = input;
        const [result] = await db
          .update(schema.notificationTemplates)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(schema.notificationTemplates.id, id))
          .returning();
        return result;
      } else {
        const { id: _id, ...data } = input;
        const [result] = await db.insert(schema.notificationTemplates).values(data).returning();
        return result;
      }
    }),

  duplicateTemplate: protectedProcedure.use(moduleGuard('settings', 'create'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [original] = await db
        .select()
        .from(schema.notificationTemplates)
        .where(eq(schema.notificationTemplates.id, input.id))
        .limit(1);

      if (!original) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });

      const [result] = await db.insert(schema.notificationTemplates).values({
        name: `${original.name} (Copy)`,
        channel: original.channel,
        event: original.event,
        subject: original.subject,
        body: original.body,
        isActive: false,
      }).returning();
      return result;
    }),

  deleteTemplate: protectedProcedure.use(moduleGuard('settings', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.delete(schema.notificationTemplates).where(eq(schema.notificationTemplates.id, input.id));
      return { success: true };
    }),

  previewTemplate: protectedProcedure.use(moduleGuard('settings', 'read'))
    .input(z.object({ body: z.string().max(10000), subject: z.string().max(500).optional() }))
    .query(({ input }) => {
      const sampleVars: Record<string, string> = {
        customerName: "John Smith",
        email: "john@example.com",
        phone: "+1 (555) 123-4567",
        rentalId: "1042",
        status: "approved",
        equipmentName: "CAT 320 Excavator",
        startDate: "2026-03-15",
        endDate: "2026-03-30",
        total: "$4,250.00",
      };
      return {
        subject: input.subject ? renderTemplate(input.subject, sampleVars) : undefined,
        body: renderTemplate(input.body, sampleVars),
      };
    }),

  // ─── Send test ──────────────────────────────────────────────
  sendTestEmail: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({ to: z.string().email().max(255), subject: z.string().max(500), body: z.string().max(10000) }))
    .mutation(async ({ input }) => {
      return sendEmail(input.to, input.subject, input.body, "test");
    }),

  sendTestSMS: protectedProcedure.use(moduleGuard('settings', 'update'))
    .input(z.object({ to: z.string().max(50), body: z.string().max(2000) }))
    .mutation(async ({ input }) => {
      return sendSMS(input.to, input.body, "test");
    }),

  // ─── Log / History ─────────────────────────────────────────
  getLog: protectedProcedure.use(moduleGuard('settings', 'read'))
    .input(z.object({
      channel: z.string().max(50).optional(),
      status: z.string().max(50).optional(),
      limit: z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      const conditions = [];
      if (input?.channel) conditions.push(eq(schema.notificationLog.channel, input.channel));
      if (input?.status) conditions.push(eq(schema.notificationLog.status, input.status));

      if (conditions.length > 0) {
        return db
          .select()
          .from(schema.notificationLog)
          .where(conditions.length === 1 ? conditions[0] : and(...conditions))
          .orderBy(desc(schema.notificationLog.createdAt))
          .limit(input?.limit ?? 100);
      }

      return db
        .select()
        .from(schema.notificationLog)
        .orderBy(desc(schema.notificationLog.createdAt))
        .limit(input?.limit ?? 100);
    }),

  clearLog: protectedProcedure.use(moduleGuard('settings', 'delete'))
    .input(z.object({ olderThanDays: z.number().optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      if (input?.olderThanDays) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - input.olderThanDays);
        // ISO string, not raw Date: postgres-js prepare:false rejects a Date param.
        await db.execute(sql`DELETE FROM notification_log WHERE "createdAt" < ${cutoff.toISOString()}`);
      } else {
        await db.delete(schema.notificationLog);
      }
      return { success: true };
    }),
});
