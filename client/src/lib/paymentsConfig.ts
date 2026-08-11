/**
 * Online self-serve payment is not wired yet (Stripe is scaffolding only —
 * `server/services/payments.ts` returns a stub when no key is configured and
 * throws "not implemented" when one is). Until it is implemented end-to-end we
 * MUST NOT show customers a clickable "Pay Now" entry point — instead direct
 * them to pay through the office.
 *
 * This is the single source of truth for that switch. Both the order list
 * (PortalOrders) and the order detail (PortalOrderDetail) import it, so the
 * day Stripe goes live, flipping this one constant to `true` re-enables every
 * payment entry point at once. Do not re-declare a local copy in a page.
 */
export const ONLINE_PAYMENTS_ENABLED = false;
