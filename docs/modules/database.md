# Database and migrations

## Rules

- **The baseline is one file.** `sql/000_baseline.sql` creates all 63 tables.
  Apply it with `npm run db:baseline`.
- **Migrations are hand-written, numbered SQL**: `sql/NNN_description.sql`,
  increasing, and **idempotent** — value guards, `ON CONFLICT`, `IF NOT EXISTS`.
  Re-running the folder must be safe.
- **Never edit a migration that has shipped.** Write a correcting one.
- **`drizzle-kit push` / `migrate` are not used.** `drizzle/schema.ts` is a
  hand-maintained mirror that exists so the query builder is typed; it is not
  the source of truth and pushing from it will drift your schema. When you add
  a column in SQL, mirror it there in the same commit — a missing mirror
  compiles fine locally and breaks at runtime.
- **Verify anything involving PL/pgSQL against a real database.** Mocks do not
  execute function bodies.

## Gotchas

- **`numeric` comes back as a string.** postgres.js does not coerce; `parseFloat`
  at the read site. Sorting a numeric column as a string is wrong in a way that
  looks right — see `client/src/lib/tableSort.ts`.
- **Dates are calendar dates in `APP_TIMEZONE`**, not UTC instants. Use the
  helpers in `server/_core/dateUtils.ts`; do not hand-roll `AT TIME ZONE`.
- **Do not bind a JS `Date` inside a raw `sql\`\`` fragment.** postgres.js throws
  `ERR_INVALID_ARG_TYPE` before the query is sent, and if the caller swallows
  it the failure surfaces as a zero. Interpolate `date.toISOString()`.

## Files

- `sql/000_baseline.sql` — full schema
- `drizzle/schema.ts` — typed mirror
- `server/db/core.ts` — pool and connection
- `server/db/seed.ts`, `server/db/seedDemo.ts` — base and demo data
