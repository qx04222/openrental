import { z } from "zod";
import { router, adminProcedure, superAdminProcedure, protectedProcedure } from "../_core/trpc";
import { getDb, eq } from "../db";
import * as schema from "../../drizzle/schema";

const permissionFields = z.object({
  canManageUsers: z.boolean().optional(),
  canManageRentals: z.boolean().optional(),
  canManageInvoices: z.boolean().optional(),
  canEditPricing: z.boolean().optional(),
  canManageCustomers: z.boolean().optional(),
  canManageFleet: z.boolean().optional(),
  canViewReports: z.boolean().optional(),
  canManageSettings: z.boolean().optional(),
  canExportData: z.boolean().optional(),
  canDeleteRecords: z.boolean().optional(),
});

export const permissionsRouter = router({
  getByUserId: adminProcedure
    .input(z.object({ userId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const [result] = await db
        .select()
        .from(schema.userPermissions)
        .where(eq(schema.userPermissions.userId, input.userId))
        .limit(1);
      return result || null;
    }),

  update: superAdminProcedure
    .input(z.object({ userId: z.number(), permissions: permissionFields }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [existing] = await db
        .select()
        .from(schema.userPermissions)
        .where(eq(schema.userPermissions.userId, input.userId))
        .limit(1);

      const permData = {
        ...input.permissions,
        updatedAt: new Date(),
      };

      if (existing) {
        await db
          .update(schema.userPermissions)
          .set(permData)
          .where(eq(schema.userPermissions.userId, input.userId));
      } else {
        await db.insert(schema.userPermissions).values({
          userId: input.userId,
          ...input.permissions,
        });
      }

      return { success: true };
    }),

  getMyPermissions: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return null;
    if (!ctx.user) return null;

    const [result] = await db
      .select()
      .from(schema.userPermissions)
      .where(eq(schema.userPermissions.userId, ctx.user.id))
      .limit(1);
    return result || null;
  }),
});
