#!/usr/bin/env bash
#
# Real-path E2E runner. Stands up an isolated Postgres from the schema fixture,
# seeds the base accounts, starts the dev server, and runs every e2e/round*.py
# against it. Used both locally and in CI (.github/workflows/e2e.yml).
#
# Local:   bash e2e/run-all.sh
# CI:      set DATABASE_URL_TEST + PG* to the service DB; the DB is assumed empty.
#
set -euo pipefail
cd "$(dirname "$0")/.."
source e2e/migrations.sh

DB_NAME="${OPENRENTAL_TEST_DB:-mr_bin_e2e}"
DB_URL="${DATABASE_URL_TEST:-postgresql://$(whoami)@localhost:5432/${DB_NAME}}"
PORT="${OPENRENTAL_PORT:-3100}"
LOG="$(mktemp -t openrental_e2e_server.XXXXXX)"

echo "==> Preparing database ${DB_NAME}"
# Recreate only when using the local default; in CI the service DB is already empty.
if [ -z "${DATABASE_URL_TEST:-}" ]; then
  dropdb --if-exists "${DB_NAME}" >/dev/null 2>&1 || true
  createdb "${DB_NAME}"
fi
psql "${DB_URL}" -v ON_ERROR_STOP=1 -q -f sql/000_baseline.sql
apply_e2e_migrations "${DB_URL}"

echo "==> Seeding base accounts"
DATABASE_URL="${DB_URL}" NODE_ENV=development npx tsx server/db/seed.ts

echo "==> Starting server on :${PORT}"
DATABASE_URL="${DB_URL}" NODE_ENV=development PORT="${PORT}" \
  RENTAL_CREATE_RATE_MAX=1000 TRPC_RATE_MAX=100000 npm run dev > "${LOG}" 2>&1 &
SERVER_PID=$!
trap 'kill ${SERVER_PID} 2>/dev/null || true' EXIT
READY_LINE="running on http://localhost:${PORT}/"

for _ in $(seq 1 60); do
  grep -Fq "${READY_LINE}" "${LOG}" 2>/dev/null && break
  sleep 0.5
done
if ! grep -Fq "${READY_LINE}" "${LOG}" 2>/dev/null; then
  echo "!! server failed to start"; cat "${LOG}"; exit 1
fi

echo "==> Running e2e specs"
export OPENRENTAL_BASE_URL="http://localhost:${PORT}"
export OPENRENTAL_DEV_LOG="${LOG}"
export OPENRENTAL_TEST_DB="${DB_NAME}"
fail=0
for spec in e2e/round*.py e2e/fullstack_campaign.py; do
  echo "----- ${spec} -----"
  if ! python3 -W ignore "${spec}"; then fail=1; echo "!! FAILED: ${spec}"; fi
done

if [ "${fail}" -eq 0 ]; then echo "==> ALL E2E SPECS PASSED"; else echo "==> E2E FAILURES"; fi
exit "${fail}"
