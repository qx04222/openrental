#!/usr/bin/env bash
# Real-path verification for the extra-charge → balance/refund/reports fix.
# Stands up a FRESH isolated test DB, runs the driver, and DROPS the DB + kills
# the server on exit (trap) — guaranteeing zero test-data residue. Never touches
# any real/production database.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${OPENRENTAL_EXTRA_DB:-mr_bin_extra_charge}"; URL="postgresql://$(whoami)@localhost:5432/${DB}"
PORT="${OPENRENTAL_EXTRA_PORT:-3107}"; LOG="$(mktemp -t openrental_extra.XXXXXX)"
cleanup(){ [ -n "${PID:-}" ] && kill "${PID}" 2>/dev/null || true; dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; createdb "${DB}"
psql "${URL}" -v ON_ERROR_STOP=1 -q -f sql/000_baseline.sql
for f in $(ls sql/1[0-9][0-9]_*.sql 2>/dev/null | sort -t/ -k2 -n); do
  psql "${URL}" -q -f "$f" >/dev/null 2>&1 || true   # idempotent; fixture already has ≤108
done
DATABASE_URL="${URL}" NODE_ENV=development npx tsx server/db/seed.ts >/dev/null

DATABASE_URL="${URL}" NODE_ENV=development PORT="${PORT}" \
  RENTAL_CREATE_RATE_MAX=100000 TRPC_RATE_MAX=1000000 VERIFY_SESSION_RATE_MAX=100000 \
  npm run dev > "${LOG}" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1 && break; sleep 0.5; done

OPENRENTAL_BASE_URL="http://localhost:${PORT}" OPENRENTAL_DEV_LOG="${LOG}" python3 -W ignore e2e/round_extra_charge_refund.py
