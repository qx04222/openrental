import { getDb } from "../db";
import * as schema from "../../drizzle/schema";
import { logger } from "../_core/logger";

interface AuditEntry {
  userId?: number | null;
  action: string;
  entityType: string;
  entityId?: number;
  changes?: Record<string, { old: unknown; new: unknown }>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

export async function logAudit(entry: AuditEntry) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(schema.auditLogs).values({
      userId: entry.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      changes: entry.changes ? JSON.stringify(entry.changes) : null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      ipAddress: entry.ipAddress,
    });
  } catch (error) {
    logger.error("[AuditLog] Failed to write audit log", { error: error instanceof Error ? error.message : String(error) });
  }
}
