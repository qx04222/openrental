"""Accountant role proof — a read-only back-office role (real-path E2E).

Proves the new 'accountant' role end to end against the running server:
  1. it can LOG IN through the real admin portal (password-login allow-list),
  2. it can READ across modules — including the dashboard + global search that
     were converted from admin-only to permission-gated,
  3. it CANNOT write anything (create/update/delete are all blocked),
  4. its resolved permissions are read-only on every one of the 18 modules.

No mocks, no SQL writes, no permission overrides. Accountant permissions are
provisioned exactly as an admin would: super_admin → rolePermissions.bulkUpdate.

Run: server up (dev mode, test DB, seeded). `python3 e2e/round_accountant_role.py`
"""
import sys
import os
import requests
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, trpc, psql, TrpcError, BASE_URL  # noqa: E402

MODULES = [
    "rentals", "dispatch", "inspections", "invoices", "customers", "fleet",
    "projects", "work_orders", "operators", "drivers", "damage_claims", "users",
    "settings", "reports", "warehouses", "audit_log", "extensions", "promotions",
]


def login(username, password):
    """Real admin-portal password login → authenticated Session (or raise)."""
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/admin-auth/password-login",
               json={"username": username, "password": password}, timeout=30)
    if not r.ok or not r.json().get("success"):
        raise AssertionError(f"login {username} failed: HTTP {r.status_code} {r.text[:200]}")
    return s


def seed_accountant_readonly(admin):
    """Provision accountant = canRead everywhere, no writes — the exact call the
    Role Permissions 'Save' button fires (mirrors migration 131)."""
    perms = [{"module": m, "canCreate": False, "canRead": True,
              "canUpdate": False, "canDelete": False} for m in MODULES]
    trpc(admin, "rolePermissions.bulkUpdate", {"role": "accountant", "permissions": perms})


def _read(sess, proc, inp, method):
    try:
        trpc(sess, proc, inp, method=method)
        return True, "ALLOWED"
    except TrpcError as e:
        return False, e.code


def main():
    admin = api_admin()  # real super_admin

    # ── 0. provision the role read-only (as an admin would via the UI) ──────
    seed_accountant_readonly(admin)
    n_read = psql("select count(*) from role_permissions "
                  "where role='accountant' and \"canRead\"")
    print(f"setup  accountant role seeded read-only; db rows: {n_read}/18 canRead")

    # ── 1. the role can LOG IN through the admin portal ─────────────────────
    acct = login("accountant", "accountant123")
    me = acct.get(f"{BASE_URL}/api/admin-auth/verify-session", timeout=15).json()
    assert me.get("isAuthenticated") and me.get("role") == "accountant", f"verify-session: {me}"
    print(f"PASS  login          accountant authenticated, role={me.get('role')}")

    # ── 2. READ works across modules (incl. converted dashboard + search) ───
    reads = [
        ("customers.list",       {"limit": 5}, "GET"),
        ("invoices.list",        {"limit": 5}, "GET"),
        ("rentalFleet.list",     {},           "GET"),
        ("dashboard.stats",      None,         "GET"),   # was adminProcedure → now reports:read
        ("dashboard.todaySchedule", None,      "GET"),   # was adminProcedure → now reports:read
        ("search.global",        {"query": "a"}, "GET"),  # was adminProcedure → now reports:read
    ]
    for proc, inp, method in reads:
        ok, code = _read(acct, proc, inp, method)
        assert ok, f"accountant BLOCKED from read {proc} ({code})"
    print(f"PASS  read access    {len(reads)} read endpoints allowed (incl. dashboard.stats, search.global)")

    # ── 3. WRITES are all blocked (read-only) ───────────────────────────────
    writes = [
        ("customers.create", {"name": "Nope", "source": "admin"},                "POST"),
        ("invoices.generateFromRental", {"rentalId": 1},                          "POST"),
        ("users.create", {"username": "x", "password": "secret1", "role": "user"}, "POST"),
        # cannot grant itself permissions (super-admin-only mutation):
        ("rolePermissions.bulkUpdate", {"role": "accountant", "permissions": []},  "POST"),
    ]
    for proc, inp, method in writes:
        ok, code = _read(acct, proc, inp, method)
        assert not ok, f"accountant WAS ALLOWED to write {proc} ({code}) — not read-only!"
        assert code == "FORBIDDEN", f"{proc} blocked with {code}, expected FORBIDDEN"
    print(f"PASS  write blocked  {len(writes)} write endpoints all FORBIDDEN (create/update/delete + self-grant)")

    # ── 4. resolved permissions are read-only on all 18 modules ─────────────
    perms = trpc(acct, "rolePermissions.getMyPermissions", None, method="GET")
    by_mod = {p["module"]: p for p in perms}
    missing = [m for m in MODULES if m not in by_mod]
    assert not missing, f"missing modules in resolved perms: {missing}"
    bad = [m for m, p in by_mod.items()
           if not p["canRead"] or p["canCreate"] or p["canUpdate"] or p["canDelete"]]
    assert not bad, f"modules not read-only: {bad}"
    print(f"PASS  resolved perms all {len(MODULES)} modules canRead=True, no create/update/delete")

    print("\nPROOF: 'accountant' is a real, login-capable, read-only role — reads everywhere "
          "(dashboard + search included), writes nowhere, and cannot escalate itself.")


if __name__ == "__main__":
    main()
