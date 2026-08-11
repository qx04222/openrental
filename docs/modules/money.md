# Money

Two rules govern everything here.

**Conservation.** Every dollar a customer pays is in exactly one of three
places: allocated to an invoice, held as a deposit on an order, or sitting on
the customer's credit balance. Tests assert the sum, and aggregates that join
are checked against the raw ledger so a join can never quietly drop money.

**History is append-only.** An issued invoice is not edited. A waived charge
becomes an offsetting credit note. A reversal goes back the way it came.

## Pricing

`server/services/pricingResolution.ts` resolves a rate by precedence:
customer-specific contract rate → category default → asset rate. Tiers are
day / week / month / 28-day; `multiItemPricing.ts` apportions an order total
across units so per-unit revenue reporting stays honest.

Delivery is priced by distance band (`shipping_pricing_*`), insurance by a
configurable rate, deposits by a rule table keyed on rental length
(`deposit_rules`).

## Invoices

`invoiceGenerator.ts` builds from the order, stores the tax breakdown as text
on the invoice, and is idempotent through a `sourceKey`. Tax comes from
`taxCalculation.ts`, which reads `tax_rates` per province: HST alone where the
province has it, GST + PST where it does not.

`status = 'sent'` means **issued** — booked to receivables, due date running.
It says nothing about delivery. Whether the customer actually received it is
`emailSentAt`, written only after the provider accepted the message.

## Deposits and credit

A deposit is held against the order. When the order closes it must go somewhere
explicit: applied to rent (`appliedAt`) or moved to the customer's balance
(`transferredToCreditAt`). Both markers are excluded from "held" — check both,
or the UI and the work queue will disagree about the same dollar.

`customer_credit_entries` is a ledger, not a balance column. Recomputed entries
upsert on a `sourceKey` so a recalculation cannot compound; event entries append.

## Collections

`/admin/collections` ranks customers by **amount owed × days late** — either
dimension alone buries the other. Contact attempts are recorded in
`customer_interactions`; a future follow-up date collapses that customer out of
today's list until it arrives.
