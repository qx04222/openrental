"""Real-path E2E — extra charges (fuel/damage) flow into balance, refund & reports.

Reproduces the reported bug: adding a gas fee did NOT count toward the order
total, so a refund returned the full prepayment minus only the base rent (over-
refunding by the gas fee + its tax). Drives the ACTUAL server + isolated DB via
the real authenticated tRPC endpoints — no mocks, no SQL injection.

Verifies:
  R1  rentals.getById exposes extraChargesOwed (subtotal + tax) for the gas fee.
  R2  recordRefund caps the refund at base + extras (rejects the old, larger
      "base-only" overpayment; accepts the correct, smaller one).
  R3  accountsReceivable owing on an unpaid order INCLUDES the gas fee + tax.
  R4  incomeStatement recognizes the extra charge as revenue (extraCharges line).
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from harness import api_admin, trpc, TrpcError  # noqa: E402

# Ontario HST. tax_rates may be seeded or empty; either way calculateTax and the
# report CTE both resolve ON to 13% (seeded row or the ON-13% fallback).
RATE = 0.13


def make_model(admin, tag):
    m = trpc(admin, "equipmentModels.create", {
        "category": f"附加类{tag}", "brand": "XC", "model": f"XC-{tag}",
        "dailyRate": "200.00", "weeklyRate": "1000.00", "equipmentType": "machine",
    })
    trpc(admin, "rentalFleet.create", {
        "brand": "XC", "model": f"XC-{tag}", "category": f"附加类{tag}",
        "serialNumber": f"XC-{tag}-1", "currentStatus": "available",
    })
    return m["id"]


def get_owed(admin, oid):
    gb = trpc(admin, "rentals.getById", {"id": oid}, method="GET")
    base = float(gb["rental_requests"]["totalAmount"])
    extras = gb.get("extraChargesOwed") or {}
    return base, extras


def main():
    admin = api_admin()
    fails = []

    # ── R1 + R2: gas fee in the balance + refund cap ─────────────────────────
    print("R1/R2 加油费进入余额 + 退款封顶")
    mid = make_model(admin, "A")
    order = trpc(admin, "rentals.adminCreate", {
        "customerName": "附加费客户A", "customerPhone": "4160000201",
        "startDate": "2026-07-01", "endDate": "2026-07-08",
        "equipmentModelId": mid, "rentalFee": "280.00",
        "insuranceType": "basic", "taxProvince": "ON",
    })
    oid = order["id"]
    base, _ = get_owed(admin, oid)  # base = rent + tax (insurance none, no freight)

    # Add a $21 gas fee → immediately 'accepted'.
    trpc(admin, "damageClaims.create", {
        "rentalId": oid, "chargeType": "fuel", "amount": 21, "description": "gas fee",
    })
    base2, extras = get_owed(admin, oid)
    exp_tax = round(21 * RATE, 2)
    if abs(extras.get("subtotal", -1) - 21.0) > 0.005:
        fails.append(f"R1: extraChargesOwed.subtotal expected 21, got {extras.get('subtotal')}")
    elif abs(extras.get("tax", -1) - exp_tax) > 0.005:
        fails.append(f"R1: extraChargesOwed.tax expected {exp_tax}, got {extras.get('tax')}")
    elif abs(extras.get("total", -1) - (21 + exp_tax)) > 0.005:
        fails.append(f"R1: extraChargesOwed.total expected {21 + exp_tax}, got {extras.get('total')}")
    else:
        print(f"  ✓ getById.extraChargesOwed = {extras} (base ${base2})")

    owed = round(base2 + extras.get("total", 0), 2)

    # Overpay: prepay base + $100, convert to rent.
    prepaid = round(base2 + 100, 2)
    trpc(admin, "rentalPrepayments.create", {
        "rentalRequestId": oid, "amount": f"{prepaid:.2f}", "paymentMethod": "cash",
    })
    trpc(admin, "rentalPrepayments.convertToRent", {"rentalRequestId": oid})

    # Old (buggy) overpayment ignored extras: prepaid - base. New: prepaid - owed.
    old_overpaid = round(prepaid - base2, 2)        # e.g. 100.00
    correct_overpaid = round(prepaid - owed, 2)      # e.g. 100 - 23.73 = 76.27

    # ★ Refunding the old, larger amount must now be REJECTED (exceeds owed).
    try:
        trpc(admin, "rentalPrepayments.recordRefund", {
            "rentalRequestId": oid, "amount": f"{old_overpaid:.2f}", "paymentMethod": "cash",
        })
        fails.append(f"R2: refund of {old_overpaid} (base-only) should have been rejected (owed includes gas fee)")
    except TrpcError as e:
        print(f"  ✓ over-refund of ${old_overpaid} rejected (gas fee now counts): {e.message[:60]}")

    # ★ The correct refund (base + extras basis) is accepted; order nets to 0.
    trpc(admin, "rentalPrepayments.recordRefund", {
        "rentalRequestId": oid, "amount": f"{correct_overpaid:.2f}", "paymentMethod": "cash",
    })
    ledger = trpc(admin, "rentalPrepayments.list", {"rentalRequestId": oid}, method="GET")
    applied_net = round(sum(float(p["amount"]) for p in ledger if p.get("appliedAt")), 2)
    if abs(applied_net - owed) > 0.01:
        fails.append(f"R2: after correct refund, applied net {applied_net} should equal owed {owed}")
    else:
        print(f"  ✓ refund ${correct_overpaid} accepted; applied net ${applied_net} == owed ${owed}")

    # ── R3 + R4: reports include the gas fee ─────────────────────────────────
    # AR / income statement only count active|completed (and, for income, invoiced)
    # orders, so drive B through the REAL lifecycle: approve → active → complete
    # (completion generates the rental invoice and merges the accepted gas fee).
    print("R3 应收账款含附加费 + R4 收入表确认附加费收入")
    order_b = trpc(admin, "rentals.adminCreate", {
        "customerName": "附加费客户B-AR", "customerPhone": "4160000202",
        "startDate": "2026-07-02", "endDate": "2026-07-09",
        "equipmentModelId": mid, "rentalFee": "500.00",
        "insuranceType": "basic", "taxProvince": "ON",
    })
    oidb = order_b["id"]
    baseb, _ = get_owed(admin, oidb)
    trpc(admin, "damageClaims.create", {
        "rentalId": oidb, "chargeType": "fuel", "amount": 100, "description": "gas fee B",
    })
    trpc(admin, "rentals.updateStatus", {"id": oidb, "status": "approved"})
    trpc(admin, "rentals.updateStatus", {"id": oidb, "status": "active"})
    # earlyReturn: close before the period ends (test dates are in the future).
    trpc(admin, "rentals.updateStatus", {"id": oidb, "status": "completed", "earlyReturn": True})
    exp_owing_b = round(baseb + 100 + round(100 * RATE, 2), 2)  # base + gas + gas tax

    ar = trpc(admin, "reports.accountsReceivable", {}, method="GET")
    row_b = next((o for o in ar["orders"] if o["id"] == oidb), None)
    if not row_b:
        fails.append("R3: order B not found in accountsReceivable (active/completed)")
    elif abs(row_b["owing"] - exp_owing_b) > 0.02:
        fails.append(f"R3: AR owing for B expected {exp_owing_b} (incl gas+tax), got {row_b['owing']}")
    else:
        print(f"  ✓ AR owing ${row_b['owing']} includes the $100 gas fee + tax (base ${baseb})")

    # Completion creates a DRAFT invoice; the income statement counts only issued
    # invoices, so send it (this also stamps issueDate, used by FIRST_INV_CTE).
    inv_list = trpc(admin, "invoices.list", {"rentalId": oidb}, method="GET")
    for it in inv_list:
        row = it.get("invoices", it)
        if row.get("status") == "draft":
            trpc(admin, "invoices.updateStatus", {"id": row["id"], "status": "sent"})
    inc = trpc(admin, "reports.incomeStatement", {}, method="GET")
    extra_rev = float(inc["current"].get("extraCharges", 0))
    if extra_rev < 100 - 0.005:
        fails.append(f"R4: incomeStatement extraCharges expected >= 100, got {extra_rev}")
    else:
        print(f"  ✓ incomeStatement extraCharges = ${extra_rev} (>= the $100 gas fee)")

    print()
    if fails:
        print(f"✗ {len(fails)} FAILURE(S):")
        for f in fails:
            print(f"   - {f}")
        sys.exit(1)
    print("✓ ALL ROUNDS PASSED — extra charges flow into balance, refund cap & reports")


if __name__ == "__main__":
    main()
