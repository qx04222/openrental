/**
 * SMS notification dispatcher for non-OTP business events.
 *
 * Wraps the low-level sendSMS so failures never bubble up to the caller —
 * a notification dropping shouldn't break the originating business action
 * (signature capture, status change, etc.). Each function logs success/error
 * and returns nothing.
 */
import { getDb, eq, and, isNull, or } from "../db";
import * as schema from "../../drizzle/schema";
import { sendSMS, normalizePhone } from "./otp";
import { isSmsEnabled } from "./notifications";
import { logger } from "../_core/logger";

const PUBLIC_BASE = process.env.SITE_URL || process.env.VITE_APP_URL || "";

/**
 * Outcome of an attempted business SMS.
 *
 * `delivered` is the ONLY thing a caller may treat as "the customer heard from
 * us". Both the disabled-channel path and the send-failure path return false —
 * they are different reasons for the same fact. Callers that stamp a
 * "reminded" marker must gate on this; stamping unconditionally is what let
 * 95 reminders be recorded as sent while the channel was switched off.
 */
export type SmsSendResult = { delivered: boolean; reason?: "channel_disabled" | "send_failed" };

type NotifyFn = (phone: string, message: string) => Promise<SmsSendResult>;

const safeSend: NotifyFn = async (phone, message) => {
  // Honor the global SMS toggle (notification_settings global.sms_enabled).
  // Auth/login OTPs deliberately call otp.sendSMS directly and bypass this gate.
  if (!(await isSmsEnabled())) {
    logger.info("[smsNotify] skipped — SMS globally disabled", { phone });
    return { delivered: false, reason: "channel_disabled" };
  }
  try {
    const normalized = normalizePhone(phone);
    await sendSMS(normalized, message);
    return { delivered: true };
  } catch (err) {
    logger.warn("[smsNotify] send failed (non-fatal)", {
      phone,
      error: err instanceof Error ? err.message : String(err),
    });
    return { delivered: false, reason: "send_failed" };
  }
};

/**
 * Gated single-recipient business SMS. Use this instead of importing
 * otp.sendSMS directly for any non-OTP/customer/business message so it
 * respects the global SMS toggle. Non-fatal: failures are logged, not thrown.
 */
export async function sendBusinessSMS(phone: string, message: string): Promise<SmsSendResult> {
  return safeSend(phone, message);
}

/** Find phones of all admin/super_admin users with isActive=true and a phone set. */
async function getAdminPhones(): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ phone: schema.users.phone })
    .from(schema.users)
    .where(and(
      isNull(schema.users.deletedAt),
      eq(schema.users.isActive, true),
      or(eq(schema.users.role, "admin"), eq(schema.users.role, "super_admin")),
    ));
  return rows.map(r => r.phone).filter((p): p is string => !!p && p.trim().length >= 7);
}

/** Send the same message to every admin. */
async function notifyAdmins(message: string): Promise<void> {
  const phones = await getAdminPhones();
  await Promise.all(phones.map(p => safeSend(p, message)));
}

// ─── Public events ───────────────────────────────────────────────

/** Customer signed their rental contract. Notify all admins. */
export async function notifyContractSigned(rentalNumber: string | null, customerName: string, rentalId: number): Promise<void> {
  const ref = rentalNumber || `#${rentalId}`;
  await notifyAdmins(`OpenRental: ${customerName} just signed contract ${ref}.`);
}

/** Rental was just approved. Notify the customer with a self-sign link. */
export async function notifyRentalApproved(customerPhone: string | null, rentalId: number, rentalNumber: string | null): Promise<void> {
  if (!customerPhone) return;
  const ref = rentalNumber || `#${rentalId}`;
  const link = PUBLIC_BASE ? `${PUBLIC_BASE.replace(/\/$/, "")}/portal/sign/${rentalId}` : `/portal/sign/${rentalId}`;
  await safeSend(customerPhone, `OpenRental: Your rental ${ref} is approved. Sign the contract: ${link}`);
}

/** New rental request landed in the queue. Notify all admins. */
export async function notifyNewRentalRequest(customerName: string, rentalId: number, rentalNumber: string | null, total: string | null): Promise<void> {
  const ref = rentalNumber || `#${rentalId}`;
  const totalPart = total ? ` ($${total})` : "";
  await notifyAdmins(`OpenRental: New rental request ${ref} from ${customerName}${totalPart}.`);
}

/** New website Contact Us / quote-request inquiry. Notify all admins. */
export async function notifyNewInquiry(name: string, email: string, inquiryId: number): Promise<void> {
  await notifyAdmins(`OpenRental: New website inquiry #${inquiryId} from ${name} (${email}).`);
}
