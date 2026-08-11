import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const modulePath = "../shared/rollingRental";

describe("rolling rental domain", () => {
  it("has a shared domain module", () => {
    expect(existsSync("shared/rollingRental.ts")).toBe(true);
  });

  it("adds an exact 28-day rolling period", async () => {
    const { addRollingDays } = await import(modulePath);

    expect(addRollingDays(new Date("2026-01-31T12:00:00.000Z"), 28).toISOString())
      .toBe("2026-02-28T12:00:00.000Z");
  });

  it("stops company-delay billing at customer ready time", async () => {
    const { resolveBillingCutoff } = await import(modulePath);
    const ready = new Date("2026-08-01T15:00:00.000Z");

    expect(resolveBillingCutoff({
      responsibility: "company",
      customerReadyAt: ready,
      pickedUpAt: null,
    })).toEqual(ready);
  });

  it("continues customer-delay billing until physical pickup", async () => {
    const { resolveBillingCutoff } = await import(modulePath);
    const ready = new Date("2026-08-01T15:00:00.000Z");
    const pickedUp = new Date("2026-08-03T15:00:00.000Z");

    expect(resolveBillingCutoff({
      responsibility: "customer",
      customerReadyAt: ready,
      pickedUpAt: null,
    })).toBeNull();
    expect(resolveBillingCutoff({
      responsibility: "customer",
      customerReadyAt: ready,
      pickedUpAt: pickedUp,
    })).toEqual(pickedUp);
  });

  it("never moves an earlier billing cutoff later", async () => {
    const { resolveBillingCutoff } = await import(modulePath);
    const ready = new Date("2026-08-01T15:00:00.000Z");
    const pickup = new Date("2026-08-03T15:00:00.000Z");

    expect(resolveBillingCutoff({
      responsibility: "company",
      customerReadyAt: ready,
      pickedUpAt: pickup,
      existingBillingStopAt: ready,
    })).toEqual(ready);
  });

  it("derives operational state in physical-custody priority", async () => {
    const { deriveRollingOperationalState } = await import(modulePath);
    const base = {
      rentalStatus: "active" as const,
      rollingStatus: "active" as const,
      customerReadyAt: null,
      pickedUpAt: null,
      returnEvidence: false,
      responsibility: "none" as const,
    };

    expect(deriveRollingOperationalState(base)).toBe("rolling_renewal");
    expect(deriveRollingOperationalState({
      ...base,
      rollingStatus: "ending",
      customerReadyAt: new Date(),
      responsibility: "company",
    })).toBe("awaiting_pickup");
    expect(deriveRollingOperationalState({
      ...base,
      rollingStatus: "ending",
      customerReadyAt: new Date(),
      pickedUpAt: new Date(),
    })).toBe("awaiting_return_inspection");
    expect(deriveRollingOperationalState({
      ...base,
      rollingStatus: "ending",
      customerReadyAt: new Date(),
      pickedUpAt: new Date(),
      returnEvidence: true,
    })).toBe("awaiting_close");
    expect(deriveRollingOperationalState({
      ...base,
      rentalStatus: "completed",
      rollingStatus: "ended",
      customerReadyAt: new Date(),
      pickedUpAt: new Date(),
      returnEvidence: true,
    })).toBe("completed");
  });

  it("distinguishes customer-caused overdue from company pickup delay", async () => {
    const { deriveRollingOperationalState } = await import(modulePath);
    const base = {
      rentalStatus: "overdue" as const,
      rollingStatus: "ending" as const,
      customerReadyAt: new Date("2026-08-01T15:00:00.000Z"),
      pickedUpAt: null,
      returnEvidence: false,
    };

    expect(deriveRollingOperationalState({ ...base, responsibility: "customer" as const }))
      .toBe("customer_overdue");
    expect(deriveRollingOperationalState({ ...base, responsibility: "company" as const }))
      .toBe("awaiting_pickup");
  });

  it("settles active and customer-chargeable ending terms only when due", async () => {
    const { isRollingSettlementDue } = await import(modulePath);
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(isRollingSettlementDue({
      status: "active",
      billingStopAt: null,
      nextSettlementDate: new Date("2026-08-01T12:00:00.000Z"),
    }, now)).toBe(true);
    expect(isRollingSettlementDue({
      status: "ending",
      billingStopAt: null,
      nextSettlementDate: new Date("2026-07-31T12:00:00.000Z"),
    }, now)).toBe(true);
    expect(isRollingSettlementDue({
      status: "ending",
      billingStopAt: new Date("2026-07-30T12:00:00.000Z"),
      nextSettlementDate: new Date("2026-07-31T12:00:00.000Z"),
    }, now)).toBe(false);
    expect(isRollingSettlementDue({
      status: "ended",
      billingStopAt: null,
      nextSettlementDate: new Date("2026-07-31T12:00:00.000Z"),
    }, now)).toBe(false);
  });
});
