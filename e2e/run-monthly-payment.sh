#!/usr/bin/env bash
# Focused real-path verification: payment on a multi-invoice (credit/挂账 monthly)
# order updates only the paid invoice's status. Fully-migrated isolated test DB
# (schema fixture is pinned to mig 108, so apply 109..127 on top), dropped at end.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${OPENRENTAL_MONTHLY_DB:-mr_bin_monthly}"; URL="postgresql://$(whoami)@localhost:5432/${DB}"
PORT="${OPENRENTAL_MONTHLY_PORT:-3104}"; LOG="$(mktemp -t openrental_monthly.XXXXXX)"
cleanup(){ [ -n "${PID:-}" ] && kill "${PID}" 2>/dev/null || true; dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; createdb "${DB}"
psql "${URL}" -v ON_ERROR_STOP=1 -q -f sql/000_baseline.sql
for f in $(ls sql/1[0-2][0-9]_*.sql 2>/dev/null | sort -t/ -k2 -n); do
  psql "${URL}" -q -f "$f" >/dev/null 2>&1 || true   # idempotent; fixture already has ≤108
done
DATABASE_URL="${URL}" NODE_ENV=development npx tsx server/db/seed.ts >/dev/null
psql "${URL}" -q -c "INSERT INTO feature_flags (key,enabled,\"createdAt\",\"updatedAt\") VALUES ('credit_orders',true,NOW(),NOW()) ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled" >/dev/null

DATABASE_URL="${URL}" NODE_ENV=development PORT="${PORT}" \
  RENTAL_CREATE_RATE_MAX=100000 TRPC_RATE_MAX=1000000 VERIFY_SESSION_RATE_MAX=100000 \
  npm run dev > "${LOG}" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1 && break; sleep 0.5; done

OPENRENTAL_BASE_URL="http://localhost:${PORT}" OPENRENTAL_DEV_LOG="${LOG}" python3 -W ignore e2e/round_monthly_payment.py
