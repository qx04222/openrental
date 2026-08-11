#!/usr/bin/env bash
# Comprehensive real-browser full-stack UI campaign — 5 rounds, every page/every
# button, isolated test DB (dropped at the end → ZERO persisted test data),
# zero override. Includes the locked ERP guards (G1 no-rate, G3 override-reason).
# Usage: bash e2e/ui/run-full-ui.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
source e2e/migrations.sh

DB="${OPENRENTAL_FULLUI_DB:-mr_bin_ui}"; URL="postgresql://$(whoami)@localhost:5432/${DB}"
PORT="${OPENRENTAL_FULLUI_PORT:-3100}"; LOG="$(mktemp -t openrental_fullui.XXXXXX)"

cleanup(){ [ -n "${PID:-}" ] && kill "${PID}" 2>/dev/null || true; dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; createdb "${DB}"
psql "${URL}" -v ON_ERROR_STOP=1 -q -f e2e/schema.sql
# Schema fixture is baseline-through-137; apply every newer migration from the
# single shared manifest so the browser campaign never runs on a stale schema.
apply_e2e_migrations "${URL}"
DATABASE_URL="${URL}" NODE_ENV=development npx tsx server/db/seed.ts
psql "${URL}" -q -c "INSERT INTO feature_flags (key,enabled,\"createdAt\",\"updatedAt\") VALUES ('credit_orders',true,NOW(),NOW()),('batch_operations',true,NOW(),NOW()),('conflict_warning',true,NOW(),NOW()) ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled"

DATABASE_URL="${URL}" NODE_ENV=development PORT="${PORT}" \
  RENTAL_CREATE_RATE_MAX=100000 TRPC_RATE_MAX=1000000 VERIFY_SESSION_RATE_MAX=100000 \
  npm run dev > "${LOG}" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1 && break; sleep 0.5; done

# priced model + 2 units (R3) and a no-rate model + 1 unit (R4 G1)
( cd e2e && OPENRENTAL_BASE_URL="http://localhost:${PORT}" python3 -W ignore - <<'PY'
from harness import api_admin, trpc
a=api_admin()
trpc(a,'equipmentCategories.create',{'name':'UI价类'})
trpc(a,'equipmentModels.create',{'category':'UI价类','brand':'UIB','model':'UI-2T挖机','dailyRate':'280.00','weeklyRate':'1400.00','equipmentType':'machine'})
for s in ['UA','UB']: trpc(a,'rentalFleet.create',{'brand':'UIB','model':'UI-2T挖机','category':'UI价类','serialNumber':'UI-'+s,'currentStatus':'available'})
trpc(a,'equipmentCategories.create',{'name':'无价类'})
trpc(a,'equipmentModels.create',{'category':'无价类','brand':'NPB','model':'无价UI挖机','equipmentType':'machine'})
trpc(a,'rentalFleet.create',{'brand':'NPB','model':'无价UI挖机','category':'无价类','serialNumber':'NP-1','currentStatus':'available'})
print('fixture ok')
PY
)

# run the WHOLE suite N times (default 5)
( cd e2e/ui && SOP_UI_BASE="http://localhost:${PORT}" python3 -W ignore full_ui.py "${FULLUI_PASSES:-5}" )
