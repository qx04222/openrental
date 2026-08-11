#!/usr/bin/env bash
# Focused real-browser verification of the category-merge fix: one category that
# spans TWO brand-models must show as ONE dropdown entry with combined
# availability, and ordering auto-assigns any unit in the category. Isolated test
# DB (dropped at the end → zero persisted data).
set -euo pipefail
cd "$(dirname "$0")/../.."
source e2e/migrations.sh

DB="${OPENRENTAL_CATMERGE_DB:-mr_bin_catmerge}"; URL="postgresql://$(whoami)@localhost:5432/${DB}"
PORT="${OPENRENTAL_CATMERGE_PORT:-3101}"; LOG="$(mktemp -t openrental_catmerge.XXXXXX)"

cleanup(){ [ -n "${PID:-}" ] && kill "${PID}" 2>/dev/null || true; dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; }
trap cleanup EXIT

dropdb --if-exists "${DB}" >/dev/null 2>&1 || true; createdb "${DB}"
psql "${URL}" -v ON_ERROR_STOP=1 -q -f e2e/schema.sql
# Schema fixture is baseline-through-137; apply every newer migration from the
# single shared manifest so the browser campaign never runs on a stale schema.
apply_e2e_migrations "${URL}"
DATABASE_URL="${URL}" NODE_ENV=development npx tsx server/db/seed.ts >/dev/null
psql "${URL}" -q -c "INSERT INTO feature_flags (key,enabled,\"createdAt\",\"updatedAt\") VALUES ('credit_orders',true,NOW(),NOW()),('batch_operations',true,NOW(),NOW()),('conflict_warning',true,NOW(),NOW()) ON CONFLICT (key) DO UPDATE SET enabled=EXCLUDED.enabled"

DATABASE_URL="${URL}" NODE_ENV=development PORT="${PORT}" \
  RENTAL_CREATE_RATE_MAX=100000 TRPC_RATE_MAX=1000000 VERIFY_SESSION_RATE_MAX=100000 \
  npm run dev > "${LOG}" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "http://localhost:${PORT}/" >/dev/null 2>&1 && break; sleep 0.5; done

# One category, TWO brand-models, one available unit each (combined 2/2 available).
( cd e2e && OPENRENTAL_BASE_URL="http://localhost:${PORT}" python3 -W ignore - <<'PY'
from harness import api_admin, trpc
a = api_admin()
trpc(a, 'equipmentCategories.create', {'name': '双品牌2吨挖机'})
trpc(a, 'equipmentModels.create', {'category': '双品牌2吨挖机', 'brand': 'SDLG', 'model': 'ER620X', 'dailyRate': '280.00', 'weeklyRate': '1400.00', 'equipmentType': 'machine'})
trpc(a, 'equipmentModels.create', {'category': '双品牌2吨挖机', 'brand': 'ARCPATH', 'model': 'AX18X', 'dailyRate': '280.00', 'weeklyRate': '1400.00', 'equipmentType': 'machine'})
trpc(a, 'rentalFleet.create', {'brand': 'SDLG', 'model': 'ER620X', 'category': '双品牌2吨挖机', 'serialNumber': 'CM-SDLG-1', 'currentStatus': 'available'})
trpc(a, 'rentalFleet.create', {'brand': 'ARCPATH', 'model': 'AX18X', 'category': '双品牌2吨挖机', 'serialNumber': 'CM-ARC-1', 'currentStatus': 'available'})
print('fixture ok')
PY
)

( cd e2e/ui && SOP_UI_BASE="http://localhost:${PORT}" python3 -W ignore verify_category_merge.py ) || { echo "=== server log tail ==="; grep -iE "error|exception|adminCreate|rental_requests|customers" "${LOG}" | tail -25; false; }
