import { TRPCError } from "@trpc/server";
import type { LifecycleEffectType } from "./rentalLifecycle";
import type { getDb } from "../db";
import { and, eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";

export type LifecycleEffectStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "manual_review"
  | "skipped";

export interface LifecycleEffectRecord {
  id: number;
  commandKey: string;
  rentalRequestId: number;
  effectType: LifecycleEffectType;
  status: LifecycleEffectStatus;
  attempts: number;
}

export interface LifecycleEffectSettlement {
  status: LifecycleEffectStatus;
  attempts: number;
  completedAt: Date | null;
  nextAttemptAt: Date | null;
  lastError: string | null;
}

const MAX_AUTOMATIC_ATTEMPTS = 5;
const AMBIGUOUS_EFFECTS = new Set<LifecycleEffectType>([
  "order_confirmation",
  "notification",
]);

export function assertLifecycleCasSucceeded<T>(rows: T[]): T {
  if (rows.length !== 1) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Rental status changed by another request. Refresh and retry.",
    });
  }
  return rows[0];
}

export function effectFailureDisposition(
  effect: Pick<LifecycleEffectRecord, "effectType" | "attempts">,
  now = new Date(),
): Pick<LifecycleEffectSettlement, "status" | "nextAttemptAt"> {
  if (AMBIGUOUS_EFFECTS.has(effect.effectType) || effect.attempts + 1 >= MAX_AUTOMATIC_ATTEMPTS) {
    return { status: "manual_review", nextAttemptAt: null };
  }

  const delayMs = Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** effect.attempts);
  return { status: "failed", nextAttemptAt: new Date(now.getTime() + delayMs) };
}

export async function executeEffectOnce(
  effect: LifecycleEffectRecord,
  handler: (effect: LifecycleEffectRecord) => Promise<void>,
  now = new Date(),
): Promise<LifecycleEffectSettlement> {
  if (effect.status !== "pending" && effect.status !== "failed") {
    throw new Error(`Lifecycle effect ${effect.id} is not claimable (status=${effect.status})`);
  }

  const attempts = effect.attempts + 1;
  try {
    await handler(effect);
    return {
      status: "completed",
      attempts,
      completedAt: now,
      nextAttemptAt: null,
      lastError: null,
    };
  } catch (error) {
    const disposition = effectFailureDisposition(effect, now);
    return {
      ...disposition,
      attempts,
      completedAt: null,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function settleLifecycleEffect(
  db: Db,
  input: {
    commandKey: string;
    effectType: LifecycleEffectType;
    error?: unknown;
    skipped?: boolean;
  },
): Promise<void> {
  const [row] = await db
    .select({
      id: schema.rentalLifecycleEffects.id,
      effectType: schema.rentalLifecycleEffects.effectType,
      attempts: schema.rentalLifecycleEffects.attempts,
    })
    .from(schema.rentalLifecycleEffects)
    .where(and(
      eq(schema.rentalLifecycleEffects.commandKey, input.commandKey),
      eq(schema.rentalLifecycleEffects.effectType, input.effectType),
    ))
    .limit(1);
  if (!row) return;

  const now = new Date();
  if (input.skipped) {
    await db.update(schema.rentalLifecycleEffects).set({
      status: "skipped",
      attempts: row.attempts,
      completedAt: now,
      nextAttemptAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(schema.rentalLifecycleEffects.id, row.id));
    return;
  }

  if (input.error === undefined) {
    await db.update(schema.rentalLifecycleEffects).set({
      status: "completed",
      attempts: row.attempts + 1,
      completedAt: now,
      nextAttemptAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(schema.rentalLifecycleEffects.id, row.id));
    return;
  }

  const disposition = effectFailureDisposition({
    effectType: row.effectType as LifecycleEffectType,
    attempts: row.attempts,
  }, now);
  await db.update(schema.rentalLifecycleEffects).set({
    status: disposition.status,
    attempts: row.attempts + 1,
    completedAt: null,
    nextAttemptAt: disposition.nextAttemptAt ?? now,
    lastError: input.error instanceof Error ? input.error.message : String(input.error),
    updatedAt: now,
  }).where(eq(schema.rentalLifecycleEffects.id, row.id));
}
