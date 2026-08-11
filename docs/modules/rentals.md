# Rentals

Quote → order → approved → active → renewal / swap → return → closed.

## The state machine is one file

`shared/rentalStateMachine.ts` owns the allowed transitions. Server routers and
tests both import it, so a transition that is illegal in the machine is illegal
everywhere. Change flows there first.

Terminal states are `completed`, `cancelled`, `rejected`.

## Side effects are claimable, not fire-and-forget

Reaching a status has consequences — generate the contract PDF, reconcile the
invoice, notify. Those are modelled as **lifecycle effects**
(`server/services/rentalLifecycle.ts`, table `rental_lifecycle_effects`) that
are claimed, executed, then settled. A crash between two effects retries the
unsettled one instead of leaving the order half-transitioned, and a retry cron
(`server/jobs/rentalLifecycleEffectsCron.ts`) sweeps anything stuck.

If you add an effect, add it to `getLifecycleEffectsForStatus` **and** handle it
in both execution paths (the inline router path and the retry cron). Gating only
one of them produces a bug that looks intermittent.

## Availability is derived, never stored twice

`server/services/fleetAvailability.ts` computes whether a unit is free from real
blockers: an active rental, an open work order, a pending return. The list badge
and the assignment dropdown read the same function, which is why they cannot
disagree — an earlier version stored a status column alongside and the two
drifted.

## Rolling / open-ended rentals

Month-to-month rentals with no end date settle on a cycle
(`rollingSettlement.ts`, `rollingSettlementCron.ts`) instead of at return.
`rental_rolling_terms` holds the cycle; `OPEN_ENDED_END_DATE` is the sentinel.

## Key files

- Routers: `rentalRequests`, `rollingRentals`, `rentalCharges`,
  `rentalPrepayments`, `extensionRequests`, `rentalAssetProgress`, `dispatch`,
  `workOrders`, `damageClaims`, `quotations`
- Services: `fleetAvailability`, `fleetRelease`, `assetAssignment`,
  `chargeWaiver`, `extensionApproval`, `editableGuard`
- UI: `client/src/pages/admin/RentalManagement/`
