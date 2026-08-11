"""Round 2 — status-lookup & portal-auth ownership/enumeration (real-path E2E).

No defect found; these are positive regression guards proving the
email-ownership and OTP anti-enumeration invariants hold against the running app.

Run: server up (dev mode, test DB). `python3 e2e/round2_auth.py`
"""
import sys
import os
import time
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_anon, api_admin, trpc, TrpcError, log_pos, DEV_LOG  # noqa: E402


def _seed_order(admin):
    """Create a real customer + a real (no-fleet) order to own."""
    email = "round2.owner@example.com"
    try:
        trpc(admin, "customers.create", {"name": "R2 Owner", "email": email,
                                         "phone": "+14165552222", "source": "admin"})
    except TrpcError:
        pass
    res = trpc(api_anon(), "rentals.create", {
        "customerName": "R2 Owner", "customerEmail": email, "customerPhone": "4165552222",
        "equipmentDescription": "Skid Steer", "startDate": "2026-08-01", "endDate": "2026-08-10",
        "deliveryMethod": "pickup",
    })
    return res["id"], email


def test_lookup_requires_matching_email():
    admin = api_admin()
    rid, email = _seed_order(admin)
    anon = api_anon()
    # Correct id + WRONG email → no leak.
    r = trpc(anon, "rentals.lookupByIdAndEmail",
             {"orderRef": str(rid), "email": "attacker@evil.com"}, method="GET")
    assert r is None, "lookup leaked an order to a non-owner email"
    # Correct id + correct email → returns the order.
    ok = trpc(anon, "rentals.lookupByIdAndEmail",
              {"orderRef": str(rid), "email": email}, method="GET")
    assert ok and ok["id"] == rid, "owner could not look up own order"
    print("PASS: lookup requires matching email")


def test_customer_update_requires_ownership():
    admin = api_admin()
    rid, _ = _seed_order(admin)
    anon = api_anon()
    try:
        trpc(anon, "rentals.customerUpdate",
             {"id": rid, "email": "attacker@evil.com", "customerNotes": "HIJACK"})
        raise AssertionError("customerUpdate allowed a non-owner to modify the order")
    except TrpcError as e:
        assert e.code == "NOT_FOUND", f"unexpected error: {e.code} {e.message}"
    print("PASS: customerUpdate requires ownership")


def test_otp_no_send_to_unregistered_phone():
    anon = api_anon()
    unreg = "+19998887777"
    pos = log_pos()
    r = trpc(anon, "customerAuth.requestOTP", {"phone": unreg})
    assert "registered" in r["message"]  # generic, non-enumerating
    time.sleep(0.4)
    with open(DEV_LOG, errors="replace") as f:
        f.seek(pos)
        tail = f.read()
    assert f"To: {unreg}" not in tail, "OTP SMS sent to an unregistered phone"
    print("PASS: no OTP sent to unregistered phone (anti-enumeration)")


if __name__ == "__main__":
    test_lookup_requires_matching_email()
    test_customer_update_requires_ownership()
    test_otp_no_send_to_unregistered_phone()
    print("ROUND2 AUTH OK")
