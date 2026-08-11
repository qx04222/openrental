"""Real-path E2E — recording a payment on a MULTI-invoice order (credit/挂账
monthly billing) updates only that invoice's status, never the other months'.

Before the fix, the order-level prepayment ledger was applied in full to EVERY
invoice on the order, so paying month 1 marked month 2 paid too. This drives the
real flow: credit order → 2 monthly charge-invoices → pay invoice 1 → assert
invoice 1 = paid AND invoice 2 = still unpaid (status + amounts).
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, trpc  # noqa: E402


def inv(admin, iid):
    return trpc(admin, "invoices.getById", {"id": iid}, method="GET")["invoices"]


def main():
    admin = api_admin()

    # Credit (挂账) orders are gated behind the credit_orders feature flag, which
    # ships disabled by default. Enabling it is legitimate admin configuration —
    # this whole round exercises the credit-order multi-month payment flow, so it
    # must turn the feature on first (same as sop_campaign.py round2).
    trpc(admin, "featureFlags.setEnabled", {"key": "credit_orders", "enabled": True})

    # Fixture: a category/model + one available unit.
    model = trpc(admin, "equipmentModels.create", {
        "category": "月结类", "brand": "MB", "model": "MB-月结机",
        "dailyRate": "280.00", "weeklyRate": "1400.00", "equipmentType": "machine",
    })
    mid = model["id"]
    trpc(admin, "rentalFleet.create", {
        "brand": "MB", "model": "MB-月结机", "category": "月结类",
        "serialNumber": "MB-1", "currentStatus": "available",
    })

    # Open-ended credit (挂账) order — the multi-month tenant.
    order = trpc(admin, "rentals.adminCreate", {
        "customerName": "月结租户", "customerPhone": "4160000888",
        "startDate": "2026-07-01", "isCreditOrder": True,
        "equipmentModelId": mid, "rentalFee": "280.00", "insuranceType": "basic",
    })
    oid = order["id"]

    # Month 1 → invoice 1.
    trpc(admin, "rentalCharges.create", {"rentalRequestId": oid, "chargeType": "adjustment", "amount": "1000.00", "description": "7月租金"})
    inv1_id = trpc(admin, "rentalCharges.generateInvoice", {"rentalRequestId": oid})["invoiceId"]
    # Month 2 → invoice 2.
    trpc(admin, "rentalCharges.create", {"rentalRequestId": oid, "chargeType": "adjustment", "amount": "1000.00", "description": "8月租金"})
    inv2_id = trpc(admin, "rentalCharges.generateInvoice", {"rentalRequestId": oid})["invoiceId"]

    assert inv1_id != inv2_id, "expected two distinct invoices on one order"
    t1 = float(inv(admin, inv1_id)["totalAmount"])
    t2 = float(inv(admin, inv2_id)["totalAmount"])
    s2_before = inv(admin, inv2_id)["status"]
    print(f"  two invoices: #{inv1_id} total={t1}, #{inv2_id} total={t2} (status {s2_before})")

    fails = []

    # Pay invoice 1 in full.
    trpc(admin, "invoices.recordPayment", {
        "invoiceId": inv1_id, "amount": t1, "paymentMethod": "cash", "paymentDate": "2026-07-05"})

    i1 = inv(admin, inv1_id)
    i2 = inv(admin, inv2_id)

    def check(name, cond, detail=""):
        print(f"  {'PASS' if cond else 'FAIL'}: {name}" + (f"  [{detail}]" if (detail and not cond) else ""))
        if not cond:
            fails.append(name)

    check("月1 发票录入付款后→已付(paid)", i1["status"] == "paid", i1["status"])
    check("月1 amountPaid = 该发票金额", abs(float(i1["amountPaid"]) - t1) < 0.01, i1["amountPaid"])
    check("★月2 发票未被串账标记为已付", i2["status"] != "paid", i2["status"])
    check("★月2 amountPaid = 0(付款没漏到下月)", abs(float(i2["amountPaid"])) < 0.01, i2["amountPaid"])
    check("★月2 balanceDue = 该发票全额仍欠", abs(float(i2["balanceDue"]) - t2) < 0.01, i2["balanceDue"])

    # Now pay invoice 2 too → it flips, invoice 1 stays paid.
    trpc(admin, "invoices.recordPayment", {
        "invoiceId": inv2_id, "amount": t2, "paymentMethod": "cash", "paymentDate": "2026-08-05"})
    i1b = inv(admin, inv1_id)
    i2b = inv(admin, inv2_id)
    check("月2 付款后→已付", i2b["status"] == "paid", i2b["status"])
    check("月1 仍为已付(未被回退)", i1b["status"] == "paid", i1b["status"])
    check("月1 金额不受月2付款影响", abs(float(i1b["amountPaid"]) - t1) < 0.01, i1b["amountPaid"])

    print(f"\n=== 月结多发票付款 {7 - len(fails)} PASS / {len(fails)} FAIL ===")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
