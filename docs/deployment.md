# Deployment and recovery

## First install

Build the provided Dockerfile using Node 22. It includes the compiled app and
bootstrap tool; runtime dependencies exclude Vite and the build toolchain.
Set `DATABASE_URL`, `BOOTSTRAP_ADMIN_PASSWORD` (20+ random characters),
`APP_TIMEZONE`, matching `VITE_APP_TIMEZONE` at build time, `CRON_TIMEZONE`,
`SITE_URL` and `VITE_APP_URL`. Use `admin` or set `BOOTSTRAP_ADMIN_USERNAME`.

The startup transaction takes a PostgreSQL advisory lock. Only an empty public
schema is initialized. The administrator gets a bcrypt hash; no demo accounts,
customers or financial records are installed. A partially initialized foreign
schema fails closed. Existing users and settings are never overwritten. Record
the administrator password in a password manager; it is not printed in logs.

Use a dedicated database and service. This repository is separate from the
original operator's Mr Bin Rentals service. Never deploy it over that database
without an explicit, verified migration plan.

## Release gates

1. `npm ci` and `npm run verify`: types, zero-warning lint, locale parity, tests,
   and production bundle.
2. `OPENRENTAL_TEST_DB=<unique_scratch_name> bash e2e/run-all.sh`: actual API,
   roles, pricing, invoices, deposits and return lifecycle on a new local DB.
3. Browser login, dashboard, invoice deep links, table navigation, search,
   390/768/1440px layouts, Chinese/English, error/retry behavior.
4. `npm audit --omit=dev`. Remaining development advisories must be documented.
5. Run the built artifact with production dependencies, bootstrap twice, check
   one administrator, probe readiness, then verify graceful SIGTERM.
6. Back up the target database and save the current deployment identity before
   replacing a running release. `railway up` uses `railway.json` and only becomes
   healthy when `/health/ready` succeeds. Verify the deployed version/revision,
   login and browser routes after deployment.

`/health` is process liveness; `/health/ready` checks a required database table,
returns 503 on failure, and never emits connection details. `APP_REVISION` should
identify the exact uploaded artifact, especially for an uncommitted local build.

## Rollback

Keep the previous successful Railway deployment available. If post-deploy checks
fail, redeploy that artifact and repeat readiness/login checks. This release adds
no schema changes to existing databases, so application rollback does not require
reversing financial data. Do not restore a database backup over newer customer
transactions without reconciling them. Use a separate database to prove backup
restore before any future schema migration.

Run one application replica until all cron jobs have cross-instance locking.
`noOverlap` prevents overlap within a process; it does not guarantee exactly-once
execution across different machines. Side-effect retries retain their existing
ledger and must not be inferred successful from a cron tick.

## Automatic maintenance

The owner's Codex task has an hourly continuation to inspect evidence, implement
bounded upgrades, validate and deploy authorized changes. Dependency proposals
are configured weekly in Dependabot. Major updates must be treated individually;
no broad automatic merge is configured. GitHub workflows take effect only after
repository publication. Never call a local workflow edit a successful CI run.

Business notification integrations remain disabled until explicitly configured.
Deployment/maintenance must not create customer payments or send test messages to
real customers. Logs contain request IDs and redact credential fields; correlate
an error using the response `X-Request-ID`.

## Verified instance backup policy

The dedicated deployment uses daily snapshots (six-day retention) and weekly
snapshots (27-day retention), plus a manually captured RC1 snapshot. A logical
backup was restored into an isolated local database. Continuous PITR status is
not enabled; do not promise recovery to an arbitrary second. Local Codex hourly
maintenance requires the host to remain available; Railway hosting and volume
backup scheduling are independent of that host.
