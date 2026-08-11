#!/usr/bin/env bash
#
# SOP ERP-flow E2E (3 rounds, zero override). Stands up an ISOLATED local
# Postgres from the schema fixture + post-snapshot migrations, seeds base
# accounts + the feature flags the flow needs, starts the dev server against it,
# runs e2e/sop_campaign.py, then TEARS THE DB DOWN (test-data deletion guarantee).
#
# Touches production NEVER. Usage: bash e2e/run-sop.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${OPENRENTAL_SOP_DB:-mr_bin_sop}"
DB_URL="postgresql://$(whoami)@localhost:5432/${DB_NAME}"
PORT="${OPENRENTAL_SOP_PORT:-3100}"
LOG="$(mktemp -t openrental_sop_server.XXXXXX)"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "${SERVER_PID}" 2>/dev/null || true
  dropdb --if-exists "${DB_NAME}" >/dev/null 2>&1 || true   # delete all test data
}
trap cleanup EXIT

echo "==> Recreating isolated DB ${DB_NAME}"
dropdb --if-exists "${DB_NAME}" >/dev/null 2>&1 || true
createdb "${DB_NAME}"
psql "${DB_URL}" -v ON_ERROR_STOP=1 -q -f sql/000_baseline.sql
echo "==> Applying post-snapshot migrations"
apply_e2e_migrations "${DB_URL}"
echo "==> Seeding base accounts + feature flags"
DATABASE_URL="${DB_URL}" NODE_ENV=development npx tsx server/db/seed.ts
psql "${DB_URL}" -q -c "INSERT INTO feature_flags (key, enabled, \"createdAt\", \"updatedAt\")
  VALUES ('credit_orders', false, NOW(), NOW()), ('credit_limit', false, NOW(), NOW())
  ON CONFLICT (key) DO NOTHING"

echo "==> Starting dev server on :${PORT}"
DATABASE_URL="${DB_URL}" NODE_ENV=development PORT="${PORT}" \
  RENTAL_CREATE_RATE_MAX=1000 TRPC_RATE_MAX=100000 npm run dev > "${LOG}" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1 && break; sleep 0.5; done

echo "==> Running SOP campaign"
OPENRENTAL_BASE_URL="http://localhost:${PORT}" OPENRENTAL_DEV_LOG="${LOG}" OPENRENTAL_TEST_DB="${DB_NAME}" \
  python3 -W ignore e2e/sop_campaign.py
