## What this changes

<!-- One change per PR. If you are fixing a bug and refactoring, split them. -->

## Why

<!-- The problem, not the diff. -->

## Verification

- [ ] `npm run verify` passes (tsc + lint + tests + build)
- [ ] Added a test that **fails without this change** — I broke the fix and watched it go red
- [ ] Touches money? Conservation still holds and is asserted
- [ ] Touches the schema? Migration is idempotent **and** `drizzle/schema.ts` is updated in this commit
- [ ] User-facing strings exist in both `en` and `zh`

## Notes for the reviewer

<!-- Anything you are unsure about, or deliberately left out. -->
