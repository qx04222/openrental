# Documentation

Start with the [README](../README.md) for what OpenRental is and how to run it,
and [CONTRIBUTING](../CONTRIBUTING.md) for how to get a change merged.

These pages are the map you want open while reading the code.

| Page | Covers |
|---|---|
| [rentals.md](modules/rentals.md) | Order lifecycle, the state machine, availability, renewals |
| [money.md](modules/money.md) | Pricing, invoices, deposits, the credit ledger, collections |
| [customers.md](modules/customers.md) | Customer records, classification, credit limits, portal access |
| [database.md](modules/database.md) | Schema baseline, migration rules, the Drizzle mirror |

## Layout

```
server/
  _core/        express + tRPC wiring, auth, dates, logging
  routers/      one tRPC router per domain (47)
  services/     business logic, reusable across routers (70)
  jobs/         cron: reminders, late fees, overdue flips, lifecycle retries
  db/           connection, seeds
client/src/
  pages/admin/  back office
  pages/portal/ customer self-serve
  pages/        field PWA (inspections, deliveries, signatures)
  i18n/         en + zh message catalogues
shared/         code both sides import — state machine, pricing types, constants
drizzle/        hand-maintained typed schema mirror
sql/            000_baseline.sql + incremental migrations
tests/          1,429 unit tests
e2e/            python harness driving a scratch database
```
