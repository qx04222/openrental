import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import { listFlags, setFlag, isFeatureEnabled, listAllEnabled } from "../services/featureFlags";
import { logAudit } from "../services/auditLog";
import { isSafetyFlagKey } from "../services/rentalOperationPolicies";

// Admin: manage flags. Public: check a specific flag (client hook calls this).
export const featureFlagsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user?.role !== "super_admin" && ctx.user?.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    return listFlags();
  }),

  setEnabled: protectedProcedure
    .input(z.object({
      key: z.string().min(1).max(100),
      enabled: z.boolean(),
      reason: z.string().trim().min(5).max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user?.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only super_admin can toggle flags" });
      }
      if (isSafetyFlagKey(input.key) && !input.reason) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A reason is required to change this safety flag",
        });
      }
      const previous = await isFeatureEnabled(input.key);
      await setFlag(input.key, input.enabled);
      if (isSafetyFlagKey(input.key)) {
        await logAudit({
          userId: ctx.user.id,
          action: "update",
          entityType: "feature_flag",
          changes: { enabled: { old: previous, new: input.enabled } },
          metadata: { key: input.key, reason: input.reason },
          ipAddress: ctx.req?.ip,
        });
      }
      return { ok: true };
    }),

  isEnabled: publicProcedure
    .input(z.object({ key: z.string().min(1).max(100) }))
    .query(async ({ input }) => ({ enabled: await isFeatureEnabled(input.key) })),

  // Single-shot snapshot used by the useFeatureFlag client hook. Returning
  // every flag in one trip lets dozens of useFeatureFlag(key) callers
  // share one React Query cache entry instead of producing N batched
  // isEnabled procedures per page load.
  allEnabled: publicProcedure.query(async () => listAllEnabled()),
});
