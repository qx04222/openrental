# Conventions for AI coding agents

This file is read automatically by Claude Code and similar tools. Humans should
read [CONTRIBUTING.md](CONTRIBUTING.md) — it says the same things with more
context.

## Before you start

- `docs/index.md` is the map. `docs/modules/` has one page per domain.
- Do not read the full i18n JSON catalogues or `sql/000_baseline.sql` end to end
  unless the task actually needs them; they are large and mostly noise for a
  targeted change.

## Definition of done

A change is done when **all four** pass, in this order:

```bash
npm run check    # tsc --noEmit
npm run lint
npm test         # vitest
npm run build    # bundler-only errors live here and nowhere else
```

`npm run verify` runs the first three plus build. Type-check and unit tests
alone are not sufficient — the build catches a class of error the others miss.

## Database

- Migrations are hand-written numbered SQL in `sql/`, **idempotent**, additive.
  Never edit one that has shipped; write a correcting migration.
- **Never run a migration against anyone's database.** Applying it is a human
  action. Write the file, say what it does.
- `drizzle/schema.ts` is a hand-maintained mirror, not a migration source.
  `drizzle-kit push` will drift the schema — do not use it. When you add a
  column in SQL, mirror it in the same commit.
- `numeric` reads back as a **string**. `parseFloat` at the read site.
- Never bind a JS `Date` inside a raw `sql\`\`` fragment — pass
  `date.toISOString()`.

## Tests

- Write the failing test first, then make it pass.
- **Prove a regression test fails without the fix.** Break the fix, watch it go
  red, restore it. A test that passes either way protects nothing.
- Money, dates and permissions changes need a test. No exceptions.

## The house style on failure

This codebase has been burned repeatedly by work that looked successful and
was not. Two rules follow from that:

1. **Record what happened, not what you intended.** If a send can be skipped or
   fail, the "done" marker is written only on confirmation. A status column is
   bookkeeping state; delivery is its own timestamp.
2. **A failed read must not render as a value.** `data?.x ?? 0` turns a crashed
   query into a confident zero. Surface the error.

## Comments

Explain *why*, not *what*. When you fix something non-obvious, name the failure
in a comment — the next person needs the reason, not a restatement of the code.
Match the surrounding density; do not narrate.

## Scope

Do what was asked. If you find a real problem outside the request, say so;
don't fix it silently in the same change.
