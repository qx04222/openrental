# OpenRental

**Self-hostable equipment rental management, built for how North American yards actually run.**

Fleet ledger, order lifecycle, tiered pricing, invoicing, deposits and receivables — plus an offline-capable field PWA for inspections and signatures. Apache-2.0.

```bash
git clone https://github.com/OWNER/openrental.git && cd openrental
cp .env.example .env          # set DATABASE_URL
npm install
npm run db:baseline           # one SQL file, 63 tables
npm run seed && npm run seed:demo
npm run dev                   # → http://localhost:3000/admin  (admin / admin123)
```

---

## Why another rental system

Most open-source "rental" projects are booking calendars. Renting machines is not booking: a unit leaves the yard on a Tuesday, comes back damaged and half-fuelled on the following Monday, the customer already paid a deposit, the damage becomes a charge, the charge becomes a credit note, and someone has to phone them in six weeks because the invoice is still open.

OpenRental was extracted from a system that had been running a real equipment rental business daily — through renewals, mid-rental swaps, disputed damage, overdue returns and month-end reconciliation. The parts that survive here are the parts that survived contact with those problems. **All of the original company's data, branding and customer records were removed before this repository was created** — see [Provenance](#provenance).

## Built for North America

This is not a generic system with a currency dropdown bolted on. The tax, calendar and document conventions are the ones a Canadian or US yard actually needs:

- **Canadian tax engine, province by province.** `tax_rates` models GST, PST and HST separately, because they do not compose the same way — a province with HST gets a single line; a province with GST + PST gets two. The tax breakdown is stored on the invoice, not recomputed at print time, so a reprint six months later still shows what the customer was actually charged.
- **A rental day is a local calendar day.** A machine returned at 8pm on the 3rd is a three-day rental whether or not UTC has already rolled over. One timezone is authoritative for every date field, set once via `APP_TIMEZONE` — `America/Toronto`, `America/Vancouver`, `America/Chicago`, `America/Phoenix`, whatever your yard runs on. An invalid zone fails at boot rather than silently shifting every invoice by a day.
- **Deposits behave like North American rental deposits.** Held against the order, tiered by rental length, then either applied to the rent or moved onto the customer's account balance when the order closes — never silently absorbed. Money the customer has paid but not yet consumed is tracked as a liability, not as revenue.
- **Damage and fuel become documents, not arguments.** A return inspection with a fuel deficit or damage generates a claim; the claim becomes an invoice line or a waiver; a waiver on an already-issued invoice issues an offsetting credit note rather than editing history.
- **Signature evidence you could hand to a lawyer.** Contract signing captures the signature, the document hash, IP, user agent and timestamp, so "they agreed to the damage terms" is a record rather than a recollection.
- **Bilingual English / Chinese out of the box** (`en`, `zh`), including the customer-facing documents. A large share of independent rental operators in the GTA, Vancouver and California run bilingual front counters.

**Not yet:** US state and local sales tax is not modeled — the tax engine is Canada-first. Adding a US rate strategy behind the same `taxCalculation` interface is a well-scoped, high-value first contribution. See [`good first issue`](../../labels/good%20first%20issue).

## What is actually in here

| Area | What it does |
|---|---|
| **Fleet ledger** | Assets, categories, attachments, serial/asset numbers, engine hours, condition, maintenance windows. Availability is derived from real blockers — an open work order holds the unit, and the list badge and the dropdown cannot disagree. |
| **Order lifecycle** | Quote → order → active → return → close, with side effects (contract PDF, invoice, notifications) modelled as claimable, settleable effects so a crash mid-transition retries instead of half-applying. Renewals, mid-rental swaps and open-ended rolling rentals included. |
| **Pricing** | Day / week / month / 28-day tiers, per-category defaults, customer-specific contract rates, promotions and referral discounts, delivery priced by distance band, insurance as a configurable rate. Multi-unit orders apportion correctly. |
| **Money** | Invoices with stored tax breakdown, prepayments, deposits, credit notes, a customer credit ledger, late fees, and a collections view ranked by amount × days late. Conservation is enforced by tests: every dollar taken in is either allocated, held, or on the customer's balance. |
| **Field PWA** | Dispatch and return inspections on a phone: photos, hour meter, fuel level, condition, customer signature. Works offline — inspections queue in IndexedDB and sync when the device gets signal, which is the normal case on a job site. |
| **Back office** | Role-based permissions (5 roles, per-module CRUD, per-user overrides), full audit log, recycle bin with restore, work orders, damage claims, a work queue that surfaces anything created and then stalled. |
| **Reports** | Utilization, fleet ROI, revenue by category and by customer industry, financing plans, aged receivables. |

63 tables, ~80k lines of TypeScript, **1,429 tests**.

## Design decisions worth knowing before you contribute

These are opinions the codebase holds on purpose. Understanding them will save you a rejected PR.

**Silence is not success.** The single most expensive class of bug in this system's history was work that looked done and wasn't: reminders marked "sent" while the SMS channel was switched off, a stats query that crashed and rendered as six confident zeroes, invoices labelled "sent" that had never been emailed. So: a status field records *bookkeeping state*, a separate timestamp records *delivery fact*, and a failed query renders as an error, never as `0`. If you add an integration, record what the provider confirmed — not what you intended.

**Money is never silently dropped.** Aggregates that join are checked against the raw ledger. When rows can't join (an invoice with no customer attached), they get their own bucket and stay in the headline total. There are tests that exist purely to fail if a total starts under-reporting.

**Migrations are hand-written and idempotent.** `sql/NNN_*.sql`, guarded so re-running the folder is safe. `drizzle/schema.ts` is a hand-maintained mirror for the typed query builder — **`drizzle-kit push` is not used and will drift your schema**. The whole history is flattened into `sql/000_baseline.sql`; everything after it is incremental.

**`npm run build` is part of the definition of done.** Type-check and unit tests do not catch bundler-only errors. CI runs the build; so should you.

**Comments explain why, not what.** Most non-obvious lines in this codebase have a comment naming the incident that produced them. Keep that up — it is the difference between a codebase you can inherit and one you have to re-derive.

## Stack

TypeScript end to end. Express + tRPC on the server, Drizzle ORM over PostgreSQL, React + Vite + Tailwind on the client, Vitest for tests, PDFKit for documents. Deploys as a single Node process behind any Postgres — there is nothing cloud-vendor-specific in the runtime.

Optional integrations, all off by default and all degrading to a no-op when unconfigured: Resend (email), Telnyx (SMS), Stripe (card payment), Supabase Storage (photos and PDFs).

## Getting set up properly

```bash
# 1. Postgres 14+
createdb openrental

# 2. Configure
cp .env.example .env
#   DATABASE_URL   required
#   APP_TIMEZONE   your yard's IANA zone (default America/Toronto)
#   everything else optional — unset integrations simply stay dark

# 3. Schema + data
npm run db:baseline     # sql/000_baseline.sql
npm run seed            # admin user, one warehouse, site settings
npm run seed:demo       # optional fictional fleet / customers, so screens aren't empty

# 4. Run
npm run dev
```

Sign in at `/admin` with `admin` / `admin123` and change the password immediately. The field PWA is at `/field-access` (phone-number login, `inspector` seed user).

Verify a change the way CI does:

```bash
npm run check    # tsc
npm run lint
npm test         # 1,429 tests
npm run build    # bundler-only errors live here
```

## Provenance

OpenRental was extracted from a production system operated by a single rental company. Before this repository existed, the following were removed and **the git history was not carried over** — this repo starts at commit one:

- every real customer name, phone number, address and order
- the original company's branding, domain, contact details and marketing site
- one-off production data-repair migrations
- internal integrations with that company's other systems

Every company, person, phone number and address in the seeds, fixtures, tests and docs is invented. Phone numbers use the `555-01xx` range reserved for fiction. If you find anything that looks like it identifies a real person or business, please report it privately — see [SECURITY.md](SECURITY.md).

## Contributing

Issues and PRs welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it is short, and it explains the test expectations, the migration rules and how to run the e2e suite against a scratch database.

Good places to start:

- **US sales tax** behind the existing `taxCalculation` interface
- **A second notification provider** (Twilio, SendGrid) following the delivery-fact pattern
- **Metric/imperial toggle** for hour meters, weights and dimensions
- **Accessibility pass** on the admin tables

## License

[Apache License 2.0](LICENSE). Use it commercially, fork it, run it for your own yard. If you improve it, a PR back is appreciated but not required.
