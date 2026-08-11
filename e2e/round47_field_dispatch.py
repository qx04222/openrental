"""Rounds 4 & 7 — field auth + dispatch state machine (real-path E2E).

Regressions:
- R4-1 (P1): fieldAuth requestOTP/verifyOTP matched users.phone exactly while
  users are stored un-normalized -> field staff locked out of OTP login. Fix:
  last-10-digit match (sibling of R3-02).
- R7-1 (P1): dispatch.assignDriver forced status='assigned' without checking the
  current state -> a terminal (completed/cancelled) dispatch could be illegally
  revived. Fix: only allow assigning from pending/assigned.

(R4-2 fuel-charge client-trust, R4-3 confirm race, R7-3 updateMyStatus IDOR are
fixed in code + covered by tsc; they need heavier fixtures to drive end-to-end.)

Run: server up (dev mode, test DB). `python3 e2e/round47_field_dispatch.py`
"""
import sys
import os
import time
import requests
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, trpc, TrpcError, log_pos, read_otp  # noqa: E402


def test_field_staff_unnormalized_phone_can_login():
    admin = api_admin()
    try:
        admin and trpc(admin, "users.create", {
            "username": "r47field", "name": "R47 Field", "phone": "4165557047",
            "password": "field999", "role": "field_staff"})
    except TrpcError:
        pass
    for variant in ["4165557047", "416-555-7047"]:
        s = requests.Session()
        pos = log_pos()
        trpc(s, "fieldAuth.requestOTP", {"phone": variant})
        time.sleep(0.4)
        code = read_otp(variant, since_pos=pos)
        r = trpc(s, "fieldAuth.verifyOTP", {"phone": variant, "code": code})
        assert r, f"field OTP login failed for {variant}"
    print("PASS: field staff with un-normalized phone can OTP-login")


def test_assign_driver_blocked_from_terminal_state():
    admin = api_admin()
    drv = trpc(admin, "drivers.create", {"name": "R47 Driver"})
    drvId = drv["id"]
    d = trpc(admin, "dispatch.create", {"orderType": "delivery"})
    did = d["id"]
    # Assigning from 'pending' is allowed.
    trpc(admin, "dispatch.assignDriver", {"id": did, "driverId": drvId})
    # Drive it to a terminal state (cancelled is reachable from assigned).
    trpc(admin, "dispatch.updateStatus", {"id": did, "status": "cancelled"})
    # Now assigning a driver must be rejected (no illegal revival).
    try:
        trpc(admin, "dispatch.assignDriver", {"id": did, "driverId": drvId})
        raise AssertionError("assignDriver revived a cancelled dispatch")
    except TrpcError as e:
        assert e.code == "PRECONDITION_FAILED", f"unexpected: {e.code} {e.message}"
    print("PASS: assignDriver blocked from terminal state")


if __name__ == "__main__":
    test_field_staff_unnormalized_phone_can_login()
    test_assign_driver_blocked_from_terminal_state()
    print("ROUND47 OK")
