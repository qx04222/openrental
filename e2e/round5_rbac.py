"""Round 5 — RBAC / authorization boundaries (real-path E2E).

No defect found; positive guards proving role enforcement holds against the
running app with REAL sessions (no permission overrides).

Run: server up (dev mode, test DB). `python3 e2e/round5_rbac.py`
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_anon, api_admin, api_field, login_customer, trpc, TrpcError  # noqa: E402


def _expect_block(session, proc, inp, method, allowed_codes):
    try:
        trpc(session, proc, inp, method=method)
        return False, "ALLOWED"
    except TrpcError as e:
        return (e.code in allowed_codes), e.code


def test_anonymous_blocked_from_protected():
    anon = api_anon()
    for proc in ["rentals.list", "customers.list"]:
        ok, code = _expect_block(anon, proc, {"limit": 5}, "GET", {"UNAUTHORIZED"})
        assert ok, f"anon reached {proc} (code {code})"
    print("PASS: anonymous blocked from protected procs (UNAUTHORIZED)")


def test_field_staff_blocked_from_admin_modules():
    fs = api_field()
    cases = [
        ("rentals.list", {"limit": 5}, "GET"),
        ("customers.create", {"name": "X", "source": "admin"}, "POST"),
        ("users.list", {}, "GET"),
        ("signatureEvidence.getForRental", {"rentalId": 1}, "GET"),
    ]
    for proc, inp, method in cases:
        ok, code = _expect_block(fs, proc, inp, method, {"FORBIDDEN"})
        assert ok, f"field_staff reached {proc} (code {code})"
    print("PASS: field_staff blocked from admin modules (FORBIDDEN)")


def test_customer_session_cannot_reach_admin_or_other_tenants():
    admin = api_admin()
    phone = "4165556650"
    try:
        admin and trpc(admin, "customers.create",
                       {"name": "R5 Cust", "email": "r5cust@example.com", "phone": phone, "source": "admin"})
    except TrpcError:
        pass
    # Ensure a DIFFERENT customer's order exists for the cross-tenant check.
    trpc(api_anon(), "rentals.create", {
        "customerName": "R5 Other", "customerEmail": "r5other@example.com",
        "customerPhone": "4165556651", "equipmentDescription": "Bin",
        "startDate": "2026-07-01", "endDate": "2026-07-03", "deliveryMethod": "pickup"})
    cust = login_customer(phone)
    me = trpc(cust, "customerAuth.me", None, method="GET")
    # Customer session is not an admin/field user → admin procs UNAUTHORIZED.
    ok, code = _expect_block(cust, "rentals.list", {"limit": 5}, "GET", {"UNAUTHORIZED"})
    assert ok, f"customer reached admin proc (code {code})"
    # Cross-tenant order read → NOT_FOUND (scoped by customerId).
    from harness import psql
    rows = psql('select id,"customerId" from rental_requests where "customerId" is not null')
    other = next((int(l.split("|")[0]) for l in rows.strip().splitlines()
                  if int(l.split("|")[1]) != me["id"]), None)
    if other is not None:
        ok, code = _expect_block(cust, "customerPortal.orderDetail",
                                 {"id": other}, "GET", {"NOT_FOUND"})
        assert ok, f"customer read another tenant's order {other} (code {code})"
    print("PASS: customer session blocked from admin procs and cross-tenant reads")


if __name__ == "__main__":
    test_anonymous_blocked_from_protected()
    test_field_staff_blocked_from_admin_modules()
    test_customer_session_cannot_reach_admin_or_other_tenants()
    print("ROUND5 RBAC OK")
