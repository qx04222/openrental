/**
 * Business SMS must honor the global `sms_enabled` toggle.
 *
 * Regression: business/customer SMS used to call otp.sendSMS directly,
 * bypassing the backend "SMS off" switch. They now route through
 * smsNotify, which checks isSmsEnabled() before sending. Login OTPs
 * (otp.sendSMS) stay exempt and are not exercised here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { smsEnabledRef, otpSendSMS } = vi.hoisted(() => ({
  smsEnabledRef: { value: true },
  otpSendSMS: vi.fn(async () => {}),
}));

vi.mock("../server/services/notifications", () => ({
  isSmsEnabled: async () => smsEnabledRef.value,
}));

vi.mock("../server/services/otp", () => ({
  sendSMS: otpSendSMS,
  normalizePhone: (p: string) => p,
}));

vi.mock("../server/_core/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendBusinessSMS, notifyRentalApproved } from "../server/services/smsNotify";

describe("business SMS global toggle", () => {
  beforeEach(() => {
    smsEnabledRef.value = true;
    vi.clearAllMocks();
  });

  it("sends when SMS is globally enabled", async () => {
    await sendBusinessSMS("+14165551234", "hello");
    expect(otpSendSMS).toHaveBeenCalledTimes(1);
    expect(otpSendSMS).toHaveBeenCalledWith("+14165551234", "hello");
  });

  it("does NOT send when SMS is globally disabled", async () => {
    smsEnabledRef.value = false;
    await sendBusinessSMS("+14165551234", "hello");
    expect(otpSendSMS).not.toHaveBeenCalled();
  });

  it("suppresses customer rental-approved SMS when disabled", async () => {
    smsEnabledRef.value = false;
    await notifyRentalApproved("+14165551234", 42, "R-42");
    expect(otpSendSMS).not.toHaveBeenCalled();
  });

  it("sends customer rental-approved SMS when enabled", async () => {
    await notifyRentalApproved("+14165551234", 42, "R-42");
    expect(otpSendSMS).toHaveBeenCalledTimes(1);
  });
});
