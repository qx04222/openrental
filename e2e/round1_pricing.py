"""Round 1 — public-flow pricing integrity (real-path E2E against the running app).

Regression for DEFECT R1-01: the public `rentals.create` mutation only
recomputed prices server-side when a `rentalFleetId` was supplied. Without one,
client-supplied money (rentalFee/total/deposit/...) was trusted and persisted,
and the credit-limit check read the client's totalAmount — enabling under-billing
and a credit-limit bypass via a direct API call carrying only an
equipmentDescription. Fix: discard all client money on the no-fleet branch
(unpriced lead; admin prices later).

Run: server must be up (dev mode, test DB). `python3 e2e/round1_pricing.py`
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_anon, api_admin, trpc, TrpcError  # noqa: E402

UNIQUE = os.environ.get("R1_TAG", "r1tamper")


def test_no_fleet_create_discards_client_money():
    anon = api_anon()
    email = f"{UNIQUE}@example.com"
    res = trpc(anon, "rentals.create", {
        "customerName": "R1 Tamper",
        "customerEmail": email,
        "customerPhone": "4165550009",
        "equipmentDescription": "30-ton Excavator (real value ~$5000)",
        "startDate": "2026-07-01",
        "endDate": "2026-07-31",
        "deliveryMethod": "pickup",
        # Attacker-chosen amounts — the server must NOT trust these:
        "rentalFee": "0.01",
        "insuranceCost": "0.00",
        "freightCost": "0.00",
        "taxAmount": "0.00",
        "depositAmount": "0.01",
        "totalAmount": "0.01",
    })
    rid = res["id"]
    admin = api_admin()
    r = trpc(admin, "rentals.getById", {"id": rid}, method="GET")["rental_requests"]
    # Server-authoritative: client money is discarded (unpriced lead).
    assert r["rentalFee"] is None, f"rentalFee leaked client value: {r['rentalFee']}"
    assert r["totalAmount"] is None, f"totalAmount leaked client value: {r['totalAmount']}"
    assert r["depositAmount"] is None, f"depositAmount leaked client value: {r['depositAmount']}"
    # The lead itself is still created (describe-equipment path preserved).
    assert r["status"] == "pending"
    assert "Excavator" in (r["equipmentDescription"] or "")
    print("PASS: no-fleet create discards client money (id=%s)" % rid)


if __name__ == "__main__":
    test_no_fleet_create_discards_client_money()
    print("ROUND1 PRICING OK")
