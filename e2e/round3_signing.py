"""Round 3 — portal contract signing + evidence chain (real-path E2E).

Regressions for three confirmed defects:
- R3-01: re-signing kept the original contractSignedAt (COALESCE) but recomputed
  signatureContractHash from a new timestamp, desyncing them so getForRental
  reported hashMatch=false (legal proof self-invalidated). Fix: signing is now
  idempotent — once signed it returns the original, unchanged.
- R3-02: customer phones are stored un-normalized, but the OTP customer lookup
  (requestOTP AND verifyOTP) matched on the exact normalized string, locking out
  every customer who typed a number without "+1" — i.e. almost all of them. Fix:
  match on the last 10 digits.
- R3-03: signContract set contractSignedAt via sql`COALESCE(.., ${now})`, binding
  a JS Date inside a raw sql fragment, which serializes to a locale string under
  postgres-js (prepare:false) and crashed the whole query — ALL portal signing
  was broken. Fix: plain Date assignment (the re-sign guard makes COALESCE moot).

Run: server up (dev mode, test DB). `python3 e2e/round3_signing.py`
"""
import sys
import os
import time
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, api_anon, trpc, TrpcError, login_customer  # noqa: E402

# Un-normalized phone on purpose (no leading +1) — exercises R3-02.
PHONE = os.environ.get("R3_PHONE", "4165557001")
EMAIL = os.environ.get("R3_EMAIL", "round3.sign@example.com")


def _owned_unsigned_order(admin):
    try:
        trpc(admin, "customers.create",
             {"name": "R3 Sign", "email": EMAIL, "phone": PHONE, "source": "admin"})
    except TrpcError:
        pass
    return trpc(api_anon(), "rentals.create", {
        "customerName": "R3 Sign", "customerEmail": EMAIL, "customerPhone": PHONE,
        "equipmentDescription": "Excavator", "startDate": "2026-11-01",
        "endDate": "2026-11-10", "deliveryMethod": "pickup",
    })["id"]


def test_signing_and_evidence():
    admin = api_admin()
    oid = _owned_unsigned_order(admin)

    # R3-02: un-normalized customer can complete OTP login.
    cust = login_customer(PHONE)

    # R3-03: signing succeeds (no Date-in-sql crash).
    s1 = trpc(cust, "customerPortal.signContract",
              {"rentalId": oid, "signature": "A" * 60})
    assert s1.get("signedAt"), "first sign did not return signedAt"
    ev1 = trpc(admin, "signatureEvidence.getForRental",
               {"rentalId": oid}, method="GET")
    assert ev1["hashMatch"] is True, "evidence hashMatch false after first sign"

    # R3-01: re-sign is idempotent — evidence stays intact and timestamp stable.
    time.sleep(0.05)
    s2 = trpc(cust, "customerPortal.signContract",
              {"rentalId": oid, "signature": "B" * 60})
    ev2 = trpc(admin, "signatureEvidence.getForRental",
               {"rentalId": oid}, method="GET")
    assert s2["signedAt"] == ev1["signedAt"], "re-sign changed the signed timestamp"
    assert ev2["hashMatch"] is True, "re-sign corrupted evidence (hashMatch false)"
    assert ev1["signedAt"] == ev2["signedAt"], "contractSignedAt not stable"
    print(f"PASS: signing + evidence intact across re-sign (order {oid})")


if __name__ == "__main__":
    test_signing_and_evidence()
    print("ROUND3 SIGNING OK")
