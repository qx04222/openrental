#!/usr/bin/env bash
# Real-BROWSER SOP UI campaign. Isolated test DB + dev server (live React UI),
# seeds a priced-equipment fixture, runs sop_ui.py (12 rounds), tears the DB down.
# Production NEVER touched. Usage: bash e2e/ui/run-sop-ui.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
source e2e/migrations.sh

DB="${OPENRENTAL_SOP_DB:-mr_bin_sop}"; URL="postgresql://$(whoami)@localhost:5432/${DB}"
PORT="${OPENRENTAL_SOP_PORT:-3100}"; LOG="$(mktemp -t openrental_sop_ui.XXXXXX)"

cleanup(){ [ -n "${PID:-}" ] && kill "${PID}" 2>/dev/null || true; dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; createdb "${DB}"
psql "${URL}" -v ON_ERROR_STOP=1 -q -f e2e/schema.sql
# Schema fixture is baseline-through-137; apply every newer migration from the
# single shared manifest so the browser campaign never runs on a stale schema.
apply_e2e_migrations "${URL}"
DATABASE_URL="${URL}" NODE_ENV=development npx tsx server/db/seed.ts
psql "${URL}" -q -c "INSERT INTO feature_flags (key,enabled,\"createdAt\",\"updatedAt\") VALUES ('credit_orders',true,NOW(),NOW()),('credit_limit',false,NOW(),NOW()) ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled"

# Raise verify-session limit: rapid automated navigation otherwise trips the
# 60/min cap and bounces to the login page (a test artifact, not a product issue).
DATABASE_URL="${URL}" NODE_ENV=development PORT="${PORT}" \
  RENTAL_CREATE_RATE_MAX=1000 TRPC_RATE_MAX=100000 VERIFY_SESSION_RATE_MAX=100000 \
  npm run dev > "${LOG}" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1 && break; sleep 0.5; done

# priced-equipment fixture via the real endpoints (run from e2e/ so harness imports)
( cd e2e && OPENRENTAL_BASE_URL="http://localhost:${PORT}" python3 -W ignore - <<'PY'
from harness import api_admin, trpc
a=api_admin()
trpc(a,'equipmentCategories.create',{'name':'UI挖机'})
trpc(a,'equipmentModels.create',{'category':'UI挖机','brand':'UIB','model':'UI-2T挖机','dailyRate':'280.00','weeklyRate':'1400.00','equipmentType':'machine'})
for s in ['UI-A','UI-B']: trpc(a,'rentalFleet.create',{'brand':'UIB','model':'UI-2T挖机','category':'UI挖机','serialNumber':s,'currentStatus':'available'})
print('fixture ok')
PY
)

# run the campaign from e2e/ui so `uikit` imports
( cd e2e/ui && SOP_UI_BASE="http://localhost:${PORT}" python3 -W ignore sop_ui.py )
