"""Role-Permissions proof — does toggling a permission in the admin UI actually
change what a role can do? (real-path E2E)

Reproduces the EXACT calls the /admin/role-permissions page fires:
  - the "Save Changes" button sends `rolePermissions.bulkUpdate` with the full
    18-module CRUD matrix for the edited role (mirrors handleSave()).
We flip ONE flag (field_staff × customers × read) and prove the live backend
enforcement (moduleGuard) flips with it, then flip it back.

No mocks, no SQL writes, no permission overrides — only real super_admin and
real field_staff sessions through the running server.

Run: server up (dev mode, test DB). `python3 e2e/round_roleperms_proof.py`
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, api_field, trpc, psql, TrpcError  # noqa: E402

# Mirror shared/authRules.ts MODULES — the same 18 rows the UI renders.
MODULES = [
    "rentals", "dispatch", "inspections", "invoices", "customers", "fleet",
    "projects", "work_orders", "operators", "drivers", "damage_claims", "users",
    "settings", "reports", "warehouses", "audit_log", "extensions", "promotions",
]

ROLE = "field_staff"
MOD = "customers"


def _build_matrix(admin, role, override):
    """Reconstruct the full CRUD matrix for `role` (as the UI does on Save):
    start from whatever rows exist, then apply our single-flag override."""
    existing = trpc(admin, "rolePermissions.listForRole", {"role": role}, method="GET")
    by_mod = {r["module"]: r for r in existing}
    perms = []
    for m in MODULES:
        base = by_mod.get(m, {})
        row = {
            "module": m,
            "canCreate": bool(base.get("canCreate", False)),
            "canRead": bool(base.get("canRead", False)),
            "canUpdate": bool(base.get("canUpdate", False)),
            "canDelete": bool(base.get("canDelete", False)),
        }
        if m == override[0]:
            row[override[1]] = override[2]
        perms.append(row)
    return perms


def _save(admin, role, module, action, value):
    """The exact mutation the 'Save Changes' button fires."""
    perms = _build_matrix(admin, role, (module, action, value))
    trpc(admin, "rolePermissions.bulkUpdate", {"role": role, "permissions": perms})


def _can_read_customers(field):
    try:
        trpc(field, "customers.list", {"limit": 5}, method="GET")
        return True, "ALLOWED"
    except TrpcError as e:
        return False, e.code


def _db_flag():
    return psql(
        f"select \"canRead\" from role_permissions "
        f"where role='{ROLE}' and module='{MOD}'"
    ) or "(no row)"


def _my_read_perm(field):
    perms = trpc(field, "rolePermissions.getMyPermissions", None, method="GET")
    row = next((p for p in perms if p["module"] == MOD), None)
    return bool(row and row["canRead"])


def main():
    admin = api_admin()   # real super_admin session
    field = api_field()   # real field_staff session

    # ── 1. BASELINE: field_staff has no customers-read row → denied ──────────
    allowed, code = _can_read_customers(field)
    assert not allowed, f"baseline: field_staff unexpectedly READ customers ({code})"
    print(f"PASS  baseline      field_staff customers.list -> {code}   db.canRead={_db_flag()}")

    # ── 2. TOGGLE ON (UI: tick customers·Read, click Save) ──────────────────
    _save(admin, ROLE, MOD, "canRead", True)
    field = api_field()  # fresh session, as the affected user would re-load
    allowed, code = _can_read_customers(field)
    assert allowed, f"after enable: field_staff still blocked ({code})"
    assert _my_read_perm(field), "getMyPermissions did not report customers.canRead=true (menu would stay hidden)"
    print(f"PASS  toggle ON      field_staff customers.list -> {code}    db.canRead={_db_flag()}  getMyPermissions.canRead=True")

    # ── 3. TOGGLE OFF (UI: untick customers·Read, click Save) ───────────────
    _save(admin, ROLE, MOD, "canRead", False)
    field = api_field()
    allowed, code = _can_read_customers(field)
    assert not allowed, f"after disable: field_staff still has access ({code})"
    assert not _my_read_perm(field), "getMyPermissions still reports canRead=true after disable"
    print(f"PASS  toggle OFF     field_staff customers.list -> {code}   db.canRead={_db_flag()}  getMyPermissions.canRead=False")

    print("\nPROOF: a single permission toggle saved from the admin UI flips the live "
          "backend enforcement (moduleGuard) AND the user's resolved permissions in lockstep.")


if __name__ == "__main__":
    main()
