# Contributing

Thanks for looking. This project is maintained in spare time, so the most
useful thing you can do is make a change easy to say yes to.

**What to expect:** a focused PR with a test usually gets a quick answer. An
issue proposing a feature may sit for a while, or be closed as out of scope —
please do not read that as hostility, it is capacity. If something matters to
you and you are willing to build it, say so in the issue; that changes the
calculation considerably.

## Getting a dev environment

```bash
createdb openrental
cp .env.example .env          # DATABASE_URL is the only required value
npm install
npm run db:baseline
npm run seed && npm run seed:demo
npm run dev
```

Sign in at `/admin` as `admin` / `admin123`. The field PWA is at `/field-access`
(the `inspector` seed user).

## Before you open a PR

```bash
npm run verify   # tsc + lint + tests + build
```

All four must pass. `npm run build` is not optional — it catches bundler-only
errors that `tsc` and Vitest do not see.

## What a good PR looks like

- **One change.** A bug fix and a refactor in the same PR takes four times as
  long to review.
- **A test that fails without your fix.** Break your own fix and confirm the
  test goes red before you submit. Say in the PR that you did.
- **A comment naming the failure**, if the fix is non-obvious. Not what the code
  does — why it has to.
- **No new dependency** unless it removes more code than it adds. Check its
  license: this project is Apache-2.0 and cannot take copyleft runtime deps.

## Rules that will get a PR sent back

**Database.** Migrations are hand-written numbered SQL in `sql/`, idempotent,
additive. Never edit a shipped migration — write a correcting one. Never run a
migration against a database as part of a PR. `drizzle/schema.ts` is a
hand-maintained mirror and must be updated in the same commit as the SQL;
`drizzle-kit push` is not used and will drift the schema.

**Money.** Anything touching invoices, deposits, payments or the credit ledger
needs a conservation test — the totals must still add up. Issued financial
documents are append-only: reverse with an offsetting entry, never edit.

**Silent failure.** Do not write a "done" marker unless the thing was confirmed
done. Do not render a failed query as `0`. If an integration can be disabled or
can fail, the caller must be able to tell the difference between "succeeded",
"skipped" and "failed".

**Dates.** Calendar dates are anchored to `APP_TIMEZONE`. Use the helpers in
`server/_core/dateUtils.ts`. Never interpolate a JS `Date` into a raw SQL
fragment.

**i18n.** Every user-facing string goes through i18next with keys in both `en`
and `zh`. `npm run lint` fails on an asymmetric catalogue.

## Running the e2e suite

The Python harness in `e2e/` drives a scratch database. It never touches
anything but a database you name explicitly:

```bash
createdb openrental_e2e
DATABASE_URL=postgresql://localhost/openrental_e2e bash e2e/run-all.sh
```

## Reporting bugs

Include what you expected, what happened, and the smallest reproduction you
can manage. If it involves money, include the numbers.

For anything with security or privacy implications, do not open a public
issue — see [SECURITY.md](SECURITY.md).

## Code of conduct

Be decent. Assume the other person is trying. See
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
