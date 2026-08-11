#!/usr/bin/env bash

# Schema for e2e runs: the single baseline, plus any migration added after it.
# Every new sql/NNN_*.sql must be idempotent, so re-applying the list is safe.
E2E_MIGRATIONS=(
  "sql/000_baseline.sql"
)

apply_e2e_migrations() {
  local database_url="$1"
  local migration
  for migration in "${E2E_MIGRATIONS[@]}"; do
    psql "${database_url}" -v ON_ERROR_STOP=1 -q -f "${migration}"
  done
}
