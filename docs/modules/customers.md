# Customers

## Records

`customers` holds one row per account, soft-deleted (`deletedAt`), with a merge
log for duplicates found by phone. Phone is the reliable identifier in this
business — email is frequently absent.

## Classification

Two independent axes, both optional:

- **Industry** — landscaping, renovation, general contractor, excavation,
  property services, individual, other. A customer may have one primary
  (`industry`) plus any number of secondary (`secondaryIndustries`). Revenue
  reports attribute to the **primary** only, so totals still sum to the whole;
  filters match primary **or** secondary, so nothing is missed when slicing.
- **Preferred language** — the language to communicate in (`en`, `zh`, `other`).
  It is a communication preference and nothing else.

Vocabulary lives in `shared/customerClassification.ts`. Editing a customer's
classification by hand marks it confirmed.

## Credit

`creditLimit` plus `creditEnforcement.ts` gate credit (挂账) orders.
`creditWarning.ts` computes exposure for the warning shown at order time.
Credit orders settle at the end rather than per-order, and cannot be reopened
by anyone below super admin once finalised.

## Portal

Customers authenticate by phone OTP (`customerAuth.ts`) and see their own
orders and invoices only. Portal routes are under `client/src/pages/portal/`.
