"""Rounds 10 & 11 (real-path E2E).

- R11 (P1): customerPricingLookup bound a JS Date inside raw sql`` fragments
  (prepare:false) -> the query threw, was swallowed upstream, and the customer's
  negotiated price was silently dropped. Fix: bind an ISO string. Proven here by
  confirming a customer's custom fleet rate is actually applied on a real order.
- R10-1 (P1): recycleBin.restore did a raw UPDATE without checking the row
  exists -> silent success + false audit entry for a non-existent record. Fix:
  existence check -> NOT_FOUND.

Run: server up (dev mode, test DB). `python3 e2e/round1011_pricing_recycle.py`
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, api_anon, trpc, TrpcError  # noqa: E402


def test_customer_custom_pricing_is_applied():
    admin = api_admin()
    email = "r11pricing@example.com"
    try:
        cid = trpc(admin, "customers.create", {"name": "R11 Cust", "email": email, "source": "admin"})["id"]
    except TrpcError:  # already exists from a prior run — reuse it
        cid = trpc(admin, "customers.lookupByEmail", {"email": email}, method="GET")["customer"]["id"]
    fleet = trpc(admin, "rentalFleet.create",
                 {"brand": "R11", "model": "Loader", "dailyRate": "100.00"})["id"]
    # Customer-specific override: half price on this fleet unit.
    trpc(admin, "customerPricing.create", {
        "customerId": cid, "rentalFleetId": fleet, "dailyRate": "50.00",
        "validFrom": "2026-01-01"})
    # Public 1-day rental for this customer + fleet -> server recomputes price.
    rid = trpc(api_anon(), "rentals.create", {
        "customerName": "R11 Cust", "customerEmail": email, "customerPhone": "4165559200",
        "rentalFleetId": fleet, "startDate": "2026-07-01", "endDate": "2026-07-02",
        "deliveryMethod": "pickup"})["id"]
    fee = trpc(admin, "rentals.getById", {"id": rid}, method="GET")["rental_requests"]["rentalFee"]
    # If resolveCustomerPricing crashed (the bug), it would silently fall back to
    # the fleet default of 100. The custom 50 proves the lookup ran.
    assert float(fee) == 50.0, f"custom pricing not applied (rentalFee={fee}, expected 50)"
    print(f"PASS: customer custom pricing applied (rentalFee={fee})")


def test_restore_nonexistent_is_rejected():
    admin = api_admin()
    try:
        trpc(admin, "recycleBin.restore", {"entityType": "customer", "entityId": 999999})
        raise AssertionError("restore of a non-existent record succeeded")
    except TrpcError as e:
        assert e.code == "NOT_FOUND", f"unexpected: {e.code} {e.message}"
    print("PASS: restore of non-existent record -> NOT_FOUND")


if __name__ == "__main__":
    test_customer_custom_pricing_is_applied()
    test_restore_nonexistent_is_rejected()
    print("ROUND1011 OK")
