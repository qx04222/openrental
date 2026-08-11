/**
 * Payment service — interface scaffolding for Stripe (not yet wired).
 *
 * The functions below define the API the rest of the codebase calls when it
 * wants to charge / refund / capture a deposit. Today they are no-ops that
 * mark the rental in a "would have charged" state; once Stripe credentials
 * are configured and the code is allowed to call out, the implementation
 * just needs to swap the stubbed bodies for real Stripe API calls — every
 * call site stays the same.
 *
 * Env vars expected (when activating):
 *   STRIPE_SECRET_KEY                  sk_live_…
 *   STRIPE_WEBHOOK_SECRET              whsec_…
 *   STRIPE_DEPOSIT_CAPTURE_METHOD      "automatic" | "manual" (default manual)
 *   PUBLIC_PORTAL_URL                  https://…/portal  (for return URL)
 */
import { logger } from "../_core/logger";

export interface CheckoutSessionInput {
  rentalRequestId: number;
  invoiceId?: number;
  amountCad: number;
  description: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSessionResult {
  /** When real Stripe is wired, this is the full Checkout URL the customer is redirected to. */
  checkoutUrl: string | null;
  /** Stripe session ID, persisted on rental_requests / invoices */
  sessionId: string | null;
  /** When live=false, the call is a no-op stub and no session was created */
  live: boolean;
}

export interface DepositAuthInput {
  rentalRequestId: number;
  amountCad: number;
  customerEmail?: string;
  description: string;
}

export interface RefundInput {
  paymentIntentId: string;
  amountCad?: number; // omit for full refund
  reason?: "duplicate" | "fraudulent" | "requested_by_customer";
}

function isLive(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Stripe Checkout session for a rental's outstanding balance.
 * No-op stub today; returns live=false so callers can show a "payment
 * not yet enabled" message instead of failing.
 */
export async function createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
  if (!isLive()) {
    logger.info("[Payments] Checkout stub (Stripe not configured)", {
      rentalRequestId: input.rentalRequestId,
      invoiceId: input.invoiceId,
      amount: input.amountCad,
    });
    return { checkoutUrl: null, sessionId: null, live: false };
  }
  // TODO when STRIPE_SECRET_KEY is set:
  //   const Stripe = (await import("stripe")).default;
  //   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  //   const session = await stripe.checkout.sessions.create({...});
  //   return { checkoutUrl: session.url!, sessionId: session.id, live: true };
  throw new Error("Stripe live path not implemented yet");
}

/**
 * Authorize (hold) the deposit on a customer's card without capturing it.
 * Returns the PaymentIntent id so the rental row can save it.
 */
export async function authorizeDeposit(input: DepositAuthInput): Promise<{ paymentIntentId: string | null; live: boolean }> {
  if (!isLive()) {
    logger.info("[Payments] Deposit-auth stub", {
      rentalRequestId: input.rentalRequestId,
      amount: input.amountCad,
    });
    return { paymentIntentId: null, live: false };
  }
  // TODO: stripe.paymentIntents.create({ amount, currency: 'cad', capture_method: 'manual', ... })
  throw new Error("Stripe live path not implemented yet");
}

/** Capture a previously-authorized deposit hold (e.g. after damage charges). */
export async function captureDeposit(_paymentIntentId: string, _amountCad?: number): Promise<{ ok: boolean; live: boolean }> {
  if (!isLive()) {
    logger.info("[Payments] Capture stub");
    return { ok: false, live: false };
  }
  throw new Error("Stripe live path not implemented yet");
}

/** Refund a fully-paid invoice or a captured deposit (full or partial). */
export async function issueRefund(input: RefundInput): Promise<{ ok: boolean; refundId: string | null; live: boolean }> {
  if (!isLive()) {
    logger.info("[Payments] Refund stub", { paymentIntentId: input.paymentIntentId, amountCad: input.amountCad, reason: input.reason });
    return { ok: false, refundId: null, live: false };
  }
  throw new Error("Stripe live path not implemented yet");
}

/**
 * Webhook handler dispatch — called from /api/stripe-webhook when activated.
 * Today it just logs; tomorrow it'll route checkout.session.completed events
 * to the appropriate "mark paid" handlers.
 */
export async function handleStripeWebhook(rawBody: string, signature: string): Promise<{ handled: boolean; live: boolean }> {
  if (!isLive()) {
    logger.info("[Payments] Webhook stub received", { sig: signature.slice(0, 16) + "…", bodyLen: rawBody.length });
    return { handled: false, live: false };
  }
  throw new Error("Stripe live path not implemented yet");
}
