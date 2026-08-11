/**
 * Customer-portal payment gating (launch invariant).
 *
 * Online self-serve payment is NOT wired yet (Stripe is scaffolding only). The
 * portal must never show a clickable "Pay Now" that just no-ops. Both the order
 * list (PortalOrders) and order detail (PortalOrderDetail) derive their pay
 * button from the SAME switch:  canPay = ONLINE_PAYMENTS_ENABLED && hasBalance.
 *
 * The pages are React/JSX and the suite runs in a node environment (no DOM), so
 * we test the shared switch + the gating rule rather than rendering. This is the
 * tripwire: if someone flips the flag on before Stripe is actually live, this
 * test fails and forces a conscious decision.
 */
import { describe, it, expect } from "vitest";
import { ONLINE_PAYMENTS_ENABLED } from "../client/src/lib/paymentsConfig";

// The exact rule both portal pages use to decide whether to render Pay Now.
const canPay = (hasBalance: boolean) => ONLINE_PAYMENTS_ENABLED && hasBalance;

describe("portal online-payment gating", () => {
  it("online payments are disabled until Stripe is wired end-to-end", () => {
    expect(ONLINE_PAYMENTS_ENABLED).toBe(false);
  });

  it("never shows a clickable Pay Now while the flag is off, even with a balance", () => {
    expect(canPay(true)).toBe(false);
    expect(canPay(false)).toBe(false);
  });
});
