# Security policy

## Reporting a vulnerability

Please report security issues privately, not as a public GitHub issue.

Use **GitHub's private vulnerability reporting** on this repository
(Security → Report a vulnerability). Include what you found, how to reproduce
it, and what an attacker could do with it.

We will acknowledge within a week and tell you our assessment and timeline.
We will credit you in the fix unless you prefer otherwise.

## Reporting a privacy problem

This repository is supposed to contain **no real personal data**. Every
customer, phone number and address in the seeds, fixtures, tests and docs is
invented.

If you find something that looks like it identifies a real person or business,
report it the same private way and we will treat it as urgent.

## Running OpenRental safely

A few things are your responsibility as an operator:

- **Change the seeded credentials.** `npm run seed` creates `admin/admin123`
  so a fresh install is usable. Change it before the instance is reachable.
- **Keep `DATABASE_URL` out of version control.** `.env` is gitignored; keep it
  that way. Sessions are database-backed with random identifiers, so there is no
  signing secret to rotate — but a leaked `DATABASE_URL` is a total compromise.
- **Serve over HTTPS.** Session cookies and signature evidence assume it.
- **Restrict database access.** The application connects as a single role with
  full rights to its own schema; do not point it at a shared database.
- **Review role permissions after upgrading.** New modules default to
  super-admin-only, but a role you created may need explicit grants.

## Supported versions

Pre-1.0. Fixes land on `main`; there are no backport branches yet.
