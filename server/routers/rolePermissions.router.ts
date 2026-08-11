import { z } from "zod";
import { router, adminProcedure, superAdminProcedure, protectedProcedure, invalidatePermissionCache } from "../_core/trpc";
import { getDb, eq, and } from "../db";
import * as schema from "../../drizzle/schema";
import { MODULES, resolvePermissions } from "../../shared/authRules";

const moduleEnum = z.enum(MODULES as unknown as [string, ...string[]]);

const crudBooleans = z.object({
  canCreate: z.boolean(),
  canRead: z.boolean(),
  canUpdate: z.boolean(),
  canDelete: z.boolean(),
});

const crudBooleansNullable = z.object({
  canCreate: z.boolean().nullable().optional(),
  canRead: z.boolean().nullable().optional(),
  canUpdate: z.boolean().nullable().optional(),
  canDelete: z.boolean().nullable().optional(),
});

const roleEnum = z.enum(["super_admin", "admin", "accountant", "user", "field_staff"]);

export const rolePermissionsRouter = router({
  /** List all role permissions grouped by role */
  list: superAdminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(schema.rolePermissions);
    // Group by role
    const grouped: Record<string, typeof rows> = {};
    for (const row of rows) {
      if (!grouped[row.role]) grouped[row.role] = [];
      grouped[row.role].push(row);
    }
    return grouped;
  }),

  /** List permissions for a specific role */
  listForRole: adminProcedure
    .input(z.object({ role: roleEnum }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select()
        .from(schema.rolePermissions)
        .where(eq(schema.rolePermissions.role, input.role));
    }),

  /** Upsert a single role+module permission */
  update: superAdminProcedure
    .input(z.object({
      role: roleEnum,
      module: moduleEnum,
    }).merge(crudBooleans))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { role, module: mod, canCreate, canRead, canUpdate, canDelete } = input;

      const [existing] = await db.select()
        .from(schema.rolePermissions)
        .where(and(
          eq(schema.rolePermissions.role, role),
          eq(schema.rolePermissions.module, mod),
        ))
        .limit(1);

      if (existing) {
        await db.update(schema.rolePermissions)
          .set({ canCreate, canRead, canUpdate, canDelete, updatedAt: new Date() })
          .where(eq(schema.rolePermissions.id, existing.id));
      } else {
        await db.insert(schema.rolePermissions).values({
          role, module: mod, canCreate, canRead, canUpdate, canDelete,
        });
      }

      invalidatePermissionCache();
      return { success: true };
    }),

  /** Bulk upsert permissions for a role */
  bulkUpdate: superAdminProcedure
    .input(z.object({
      role: roleEnum,
      permissions: z.array(z.object({ module: moduleEnum }).merge(crudBooleans)),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      for (const perm of input.permissions) {
        const [existing] = await db.select()
          .from(schema.rolePermissions)
          .where(and(
            eq(schema.rolePermissions.role, input.role),
            eq(schema.rolePermissions.module, perm.module),
          ))
          .limit(1);

        if (existing) {
          await db.update(schema.rolePermissions)
            .set({
              canCreate: perm.canCreate,
              canRead: perm.canRead,
              canUpdate: perm.canUpdate,
              canDelete: perm.canDelete,
              updatedAt: new Date(),
            })
            .where(eq(schema.rolePermissions.id, existing.id));
        } else {
          await db.insert(schema.rolePermissions).values({
            role: input.role,
            module: perm.module,
            canCreate: perm.canCreate,
            canRead: perm.canRead,
            canUpdate: perm.canUpdate,
            canDelete: perm.canDelete,
          });
        }
      }

      invalidatePermissionCache();
      return { success: true };
    }),

  /** Get user-level overrides for a specific user */
  getUserOverrides: adminProcedure
    .input(z.object({ userId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select()
        .from(schema.userPermissionOverrides)
        .where(eq(schema.userPermissionOverrides.userId, input.userId));
    }),

  /** Set a user-level override for a specific module */
  setUserOverride: superAdminProcedure
    .input(z.object({
      userId: z.number(),
      module: moduleEnum,
    }).merge(crudBooleansNullable))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const { userId, module: mod, ...perms } = input;

      const [existing] = await db.select()
        .from(schema.userPermissionOverrides)
        .where(and(
          eq(schema.userPermissionOverrides.userId, userId),
          eq(schema.userPermissionOverrides.module, mod),
        ))
        .limit(1);

      if (existing) {
        await db.update(schema.userPermissionOverrides)
          .set(perms)
          .where(eq(schema.userPermissionOverrides.id, existing.id));
      } else {
        await db.insert(schema.userPermissionOverrides).values({
          userId,
          module: mod,
          ...perms,
        });
      }

      return { success: true };
    }),

  /** Remove a user-level override */
  removeUserOverride: superAdminProcedure
    .input(z.object({ userId: z.number(), module: moduleEnum }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      await db.delete(schema.userPermissionOverrides)
        .where(and(
          eq(schema.userPermissionOverrides.userId, input.userId),
          eq(schema.userPermissionOverrides.module, input.module),
        ));

      return { success: true };
    }),

  /** Get resolved permissions for the current user (role defaults + overrides merged) */
  getMyPermissions: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db || !ctx.user) return [];

    const rolePerms = await db.select()
      .from(schema.rolePermissions)
      .where(eq(schema.rolePermissions.role, ctx.user.role as typeof schema.rolePermissions.$inferSelect.role));

    const overrides = await db.select()
      .from(schema.userPermissionOverrides)
      .where(eq(schema.userPermissionOverrides.userId, ctx.user.id));

    return resolvePermissions(ctx.user.role, rolePerms, overrides);
  }),
});
