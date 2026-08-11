import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, eq, and, isNull, or } from "../db";
import * as schema from "../../drizzle/schema";
import bcrypt from "bcrypt";
import { logAudit } from "../services/auditLog";

export const usersRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) return null;
    const { passwordHash: _pw, ...user } = ctx.user as Record<string, unknown>;
    return user;
  }),

  list: protectedProcedure.use(moduleGuard('users', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];
    const result = await db.select().from(schema.users).where(isNull(schema.users.deletedAt));
    return result.map(({ passwordHash: _pw, ...user }) => user);
  }),

  create: protectedProcedure.use(moduleGuard('users', 'create'))
    .input(z.object({
      username: z.string().min(1).max(100),
      email: z.string().email().max(255).optional(),
      name: z.string().max(255).optional(),
      phone: z.string().max(20).optional(),
      password: z.string().min(6).max(128),
      role: z.enum(["super_admin", "admin", "accountant", "user", "field_staff"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Only super_admin can create a super_admin. Without this, an admin who
      // was delegated users.create could mint a super_admin account and escalate
      // past every superAdminProcedure guard. (Mirrors the same check in update.)
      if (input.role === "super_admin" && ctx.user?.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can create super admins" });
      }

      const passwordHash = await bcrypt.hash(input.password, 10);
      const [result] = await db.insert(schema.users).values({
        username: input.username,
        email: input.email,
        name: input.name,
        phone: input.phone,
        passwordHash,
        role: input.role,
      }).returning();

      const { passwordHash: _, ...user } = result;

      await logAudit({
        userId: ctx.user?.id,
        action: "create",
        entityType: "user",
        entityId: result.id,
        metadata: { username: input.username, role: input.role },
        ipAddress: ctx.req?.ip,
      });

      return user;
    }),

  update: protectedProcedure.use(moduleGuard('users', 'update'))
    .input(z.object({
      id: z.number(),
      username: z.string().max(100).optional(),
      email: z.string().email().max(255).optional(),
      name: z.string().max(255).optional(),
      phone: z.string().max(20).optional(),
      role: z.enum(["super_admin", "admin", "accountant", "user", "field_staff"]).optional(),
      isActive: z.boolean().optional(),
      password: z.string().min(6).max(128).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Fetch current values for audit diff (exclude soft-deleted)
      const [existing] = await db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, input.id), isNull(schema.users.deletedAt)))
        .limit(1);

      // Only super_admin can promote to super_admin
      if (input.role === "super_admin" && ctx.user?.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only super admins can promote to super admin" });
      }

      const { id, password, ...data } = input;
      const updateData: Partial<typeof schema.users.$inferInsert> & { updatedAt: Date } = { ...data, updatedAt: new Date() };
      if (password) {
        updateData.passwordHash = await bcrypt.hash(password, 10);
      }

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      const [result] = await db.update(schema.users).set(updateData).where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt))).returning();
      const { passwordHash: _, ...user } = result;

      // Audit log: user update
      if (existing) {
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        const fieldsToTrack = ["username", "email", "name", "phone", "role", "isActive"] as const;
        for (const field of fieldsToTrack) {
          if (input[field] !== undefined && String(input[field]) !== String(existing[field] ?? "")) {
            changes[field] = { old: existing[field], new: input[field] };
          }
        }
        if (password) {
          changes.password = { old: "***", new: "***" };
        }
        if (Object.keys(changes).length > 0) {
          await logAudit({
            userId: ctx.user?.id,
            action: "update",
            entityType: "user",
            entityId: id,
            changes,
            metadata: { username: existing.username },
            ipAddress: ctx.req?.ip,
          });
        }
      }

      return user;
    }),

  delete: protectedProcedure.use(moduleGuard('users', 'delete'))
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      // Cannot delete yourself
      if (input.id === ctx.user?.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot delete your own account" });
      }

      // Check target user exists
      const [target] = await db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, input.id), isNull(schema.users.deletedAt)))
        .limit(1);

      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

      // Cannot delete the last admin — count active, non-deleted admins by role
      if (target.role === "admin" || target.role === "super_admin") {
        const admins = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(
            or(eq(schema.users.role, "admin"), eq(schema.users.role, "super_admin")),
            isNull(schema.users.deletedAt),
            eq(schema.users.isActive, true),
          ));

        if (admins.length <= 1) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Cannot delete the last admin. At least one admin must remain." });
        }
      }

      await db.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, input.id));

      await logAudit({
        userId: ctx.user?.id,
        action: "delete",
        entityType: "user",
        entityId: input.id,
        metadata: { username: target.username },
        ipAddress: ctx.req?.ip,
      });

      return { success: true };
    }),
});
