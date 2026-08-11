#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source e2e/migrations.sh

DB_NAME="mr_bin_progress_browser_${$}"
DB_URL="postgresql://$(whoami)@localhost:5432/${DB_NAME}"
PORT="${OPENRENTAL_PORT:-3114}"
LOG="$(mktemp -t openrental_progress_browser.XXXXXX)"
SERVER_PID=""

cleanup() {
  if [ -n "${SERVER_PID}" ]; then kill "${SERVER_PID}" >/dev/null 2>&1 || true; fi
  dropdb --if-exists "${DB_NAME}" >/dev/null 2>&1 || true
  LEFT="$(psql -d postgres -tAc "select count(*) from pg_database where datname='${DB_NAME}'")"
  if [ "${LEFT}" != "0" ]; then echo "!! disposable DB cleanup failed: ${DB_NAME}"; exit 1; fi
  rm -f "${LOG}"
}
trap cleanup EXIT

createdb "${DB_NAME}"
psql "${DB_URL}" -v ON_ERROR_STOP=1 -q -f sql/000_baseline.sql
apply_e2e_migrations "${DB_URL}"
DATABASE_URL="${DB_URL}" NODE_ENV=development npx tsx server/db/seed.ts >/dev/null

DATABASE_URL="${DB_URL}" NODE_ENV=development PORT="${PORT}" \
  RENTAL_CREATE_RATE_MAX=1000 TRPC_RATE_MAX=100000 npm run dev >"${LOG}" 2>&1 &
SERVER_PID=$!
READY_LINE="running on http://localhost:${PORT}/"
for _ in $(seq 1 60); do
  grep -Fq "${READY_LINE}" "${LOG}" 2>/dev/null && break
  sleep 0.5
done
if ! grep -Fq "${READY_LINE}" "${LOG}" 2>/dev/null; then cat "${LOG}"; exit 1; fi

OPENRENTAL_BASE_URL="http://localhost:${PORT}" OPENRENTAL_DEV_LOG="${LOG}" OPENRENTAL_TEST_DB="${DB_NAME}" \
  python3 -W ignore e2e/rental_asset_progress_campaign.py

if grep -iE "uncaught|unhandled|relation .* does not exist" "${LOG}"; then
  echo "!! server error signature detected"; exit 1
fi
echo "ASSET PROGRESS DISPOSABLE RUN PASSED; cleanup will remove ${DB_NAME}"
