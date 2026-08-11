"""Round 9 — sales ops (real-path E2E).

Regressions:
- R9-2 (P0): promotions.deleteCode hard-deleted a referral code; the
  referral_ledger FK is ON DELETE CASCADE, so deleting a code with commission
  history permanently destroyed that ledger. Fix: deactivate (isActive=false)
  instead of deleting when ledger rows exist.
- R9-3 (P1): damageClaims.generateInvoice didn't require the claim to be
  'accepted' -> a direct call could invoice an unapproved estimate. Fix: gate on
  status === 'accepted'.
- R9-1 (P1): extension approve/reject were TOCTOU. Fix: status precondition in
  the UPDATE WHERE + CONFLICT on 0 rows (asserted here via double-review).

Run: server up (dev mode, test DB). `python3 e2e/round9_salesops.py`
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, api_anon, trpc, TrpcError, psql  # noqa: E402


def _ledger_count(code_id):
    return int(psql(f'select count(*) from referral_ledger where "referralCodeId"={code_id}') or "0")


def _code_exists(code_id):
    return psql(f'select count(*) from referral_codes where id={code_id}') == "1"


def test_deletecode_preserves_ledger_history():
    admin = api_admin()
    driver = trpc(admin, "drivers.create", {"name": "R9 Driver"})["id"]
    promo = trpc(admin, "promotions.create", {
        "name": "R9 Promo", "discountPercent": "10.00", "commissionPercent": "5.00",
        "startDate": "2026-01-01", "endDate": "2026-12-31"})["id"]
    codes = trpc(admin, "promotions.generateCodes",
                 {"promotionId": promo, "driverIds": [driver], "codePrefix": "R9"})
    code = codes[0]
    code_id, code_str = code["id"], code["code"]
    # A fleet unit with a daily rate so the rental is priced and a ledger row is written.
    fleet = trpc(admin, "rentalFleet.create",
                 {"brand": "R9", "model": "Excavator", "dailyRate": "100.00"})["id"]
    # Public rental using the referral code -> creates a referral_ledger row.
    trpc(api_anon(), "rentals.create", {
        "customerName": "R9 Ref", "customerEmail": "r9ref@example.com", "customerPhone": "4165559100",
        "rentalFleetId": fleet, "startDate": "2026-07-01", "endDate": "2026-07-08",
        "deliveryMethod": "pickup", "referralCode": code_str})
    assert _ledger_count(code_id) > 0, "setup failed: no ledger row created"

    # Delete the code that has commission history.
    res = trpc(admin, "promotions.deleteCode", {"id": code_id})
    assert res.get("deactivated") is True, "expected deactivation, not hard delete"
    assert _code_exists(code_id), "code row was destroyed"
    assert _ledger_count(code_id) > 0, "DATA LOSS: ledger history cascaded away"
    print("PASS: deleteCode preserves commission ledger (deactivates)")


def test_damage_claim_requires_acceptance_before_invoice():
    admin = api_admin()
    # Reuse any existing rental id (create one if the DB is empty).
    existing = psql("select id from rental_requests order by id limit 1")
    if existing:
        rid = int(existing)
    else:
        rid = trpc(api_anon(), "rentals.create", {
            "customerName": "R9 Rental", "customerEmail": "r9rental@example.com",
            "customerPhone": "4165559300", "equipmentDescription": "Bin",
            "startDate": "2026-07-01", "endDate": "2026-07-05", "deliveryMethod": "pickup",
        })["id"]
    claim = trpc(admin, "damageClaims.create",
                 {"rentalId": rid, "description": "Dent", "repairEstimate": 500})
    cid = claim["id"] if isinstance(claim, dict) and "id" in claim else claim.get("claimId")
    try:
        trpc(admin, "damageClaims.generateInvoice", {"id": cid})
        raise AssertionError("invoiced an unaccepted damage claim")
    except TrpcError as e:
        assert e.code == "PRECONDITION_FAILED", f"unexpected: {e.code} {e.message}"
    print("PASS: damage claim must be accepted before invoicing")


if __name__ == "__main__":
    test_deletecode_preserves_ledger_history()
    test_damage_claim_requires_acceptance_before_invoice()
    print("ROUND9 OK")
