"""Real-path E2E — 预收款 ↔ 发票收款联动 (feat/prepayment-invoice-link).

Drives the ACTUAL server against an isolated, throwaway test DB (dropped by the
runner on exit — zero residue). Three rounds:

  R1 主功能 — a 预收款/deposit recorded BEFORE the invoice exists is absorbed the
     moment the invoice is generated → invoice auto-shows 部分/已付 (the bug fix:
     generateInvoiceFromRental now re-allocates the ledger). Pre-fix: 0 / draft.

  R2 隔离 — on a multi-invoice (挂账月结) order, a 预收款 tagged to invoice #2
     settles ONLY #2; an untagged one falls FIFO onto the oldest open invoice.

  R3 回归 — bidirectional + reversal: a payment recorded on the INVOICE side
     shows up in the order's 预收款 ledger (录预收款=录收款), and deleting the
     prepayment reverts the invoice to unpaid.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from harness import TrpcError, api_admin, trpc  # noqa: E402


def inv(admin, iid):
    return trpc(admin, "invoices.getById", {"id": iid}, method="GET")["invoices"]


def order_bal(admin, oid):
    """Order-level (total, applied-net prepaid) as the LIST badge sees it
    (rentals.paymentStatusMap) — only applied prepayments, refunds netted."""
    m = trpc(admin, "rentals.paymentStatusMap", None, method="GET")
    row = next((x for x in m if x["id"] == oid), None)
    return (row["total"], row["prepaid"]) if row else (None, None)


def make_model(admin, tag):
    m = trpc(admin, "equipmentModels.create", {
        "category": f"联动类{tag}", "brand": "LK", "model": f"LK-{tag}",
        "dailyRate": "200.00", "weeklyRate": "1000.00", "equipmentType": "machine",
    })
    trpc(admin, "rentalFleet.create", {
        "brand": "LK", "model": f"LK-{tag}", "category": f"联动类{tag}",
        "serialNumber": f"LK-{tag}-1", "currentStatus": "available",
    })
    return m["id"]


def main():
    admin = api_admin()
    fails = []

    # ── R1: deposit-before-invoice auto-settles ──────────────────────────────
    print("R1 主功能: 预收款先于发票 → 生成发票自动结清")
    mid = make_model(admin, "R1")
    order = trpc(admin, "rentals.adminCreate", {
        "customerName": "联动客户R1", "customerPhone": "4160000101",
        "startDate": "2026-07-01", "endDate": "2026-07-08",
        "equipmentModelId": mid, "rentalFee": "1000.00",
        "insuranceType": "basic", "taxProvince": "ON",
    })
    oid = order["id"]
    # Deposit $50 collected BEFORE any invoice exists — recorded as HELD (待转).
    trpc(admin, "rentalPrepayments.create", {
        "rentalRequestId": oid, "amount": "50.00", "paymentMethod": "e_transfer",
    })
    gen = trpc(admin, "invoices.generateFromRental", {"rentalId": oid})
    iid = gen["invoiceId"]
    row = inv(admin, iid)
    total = float(row["totalAmount"])
    # ★ Held prepayment must NOT settle the invoice until manually converted.
    if abs(float(row["amountPaid"])) > 0.005:
        fails.append(f"R1: held prepayment must NOT settle invoice, got paid={row['amountPaid']}")
    else:
        print(f"  ✓ held $50 did NOT settle invoice #{iid} (paid=0, status={row['status']})")
    # ★ List badge (paymentStatusMap) must also exclude held money (consistency).
    _, list_prepaid = order_bal(admin, oid)
    if abs(list_prepaid) > 0.005:
        fails.append(f"R1: list badge must not count held money, paymentStatusMap prepaid={list_prepaid}")
    else:
        print("  ✓ list badge (paymentStatusMap) excludes held money too")
    # Manual step: 预付款转租金 → now the $50 applies.
    trpc(admin, "rentalPrepayments.convertToRent", {"rentalRequestId": oid})
    row = inv(admin, iid)
    if abs(float(row["amountPaid"]) - 50.0) > 0.005 or row["status"] != "partial":
        fails.append(f"R1: after convert expected paid=50/partial, got paid={row['amountPaid']} status={row['status']}")
    else:
        print(f"  ✓ after 转租金: invoice partial (paid={row['amountPaid']})")
    # Record the remaining balance (held), then convert → invoice fully paid.
    trpc(admin, "rentalPrepayments.create", {
        "rentalRequestId": oid, "amount": f"{total - 50.0:.2f}", "paymentMethod": "cash",
    })
    mid_row = inv(admin, iid)
    if abs(float(mid_row["amountPaid"]) - 50.0) > 0.005:
        fails.append(f"R1: 2nd held payment must not apply before convert, got paid={mid_row['amountPaid']}")
    trpc(admin, "rentalPrepayments.convertToRent", {"rentalRequestId": oid})
    row = inv(admin, iid)
    if abs(float(row["amountPaid"]) - total) > 0.005 or row["status"] != "paid":
        fails.append(f"R1: expected fully paid after convert, got paid={row['amountPaid']} status={row['status']}")
    else:
        print(f"  ✓ after 2nd 转租金: invoice PAID ({row['amountPaid']}/{total})")
    # 撤销转租金 → invoice reverts to unpaid; re-convert → paid again.
    trpc(admin, "rentalPrepayments.unconvert", {"rentalRequestId": oid})
    row = inv(admin, iid)
    if float(row["amountPaid"]) > 0.005 or row["status"] == "paid":
        fails.append(f"R1: unconvert should revert invoice to unpaid, got paid={row['amountPaid']} status={row['status']}")
    else:
        print(f"  ✓ 撤销转租金: invoice back to unpaid (status={row['status']})")
    trpc(admin, "rentalPrepayments.convertToRent", {"rentalRequestId": oid})
    if inv(admin, iid)["status"] != "paid":
        fails.append("R1: re-convert after unconvert should pay the invoice again")

    # ── R2: held gate + multi-invoice tagged vs FIFO ─────────────────────────
    print("R2 隔离: 待转→转租金后,指定发票 vs FIFO")
    trpc(admin, "featureFlags.setEnabled", {"key": "credit_orders", "enabled": True})
    mid2 = make_model(admin, "R2")
    corder = trpc(admin, "rentals.adminCreate", {
        "customerName": "月结客户R2", "customerPhone": "4160000202",
        "startDate": "2026-07-01", "isCreditOrder": True,
        "equipmentModelId": mid2, "rentalFee": "1000.00", "insuranceType": "basic",
    })
    coid = corder["id"]
    trpc(admin, "rentalCharges.create", {"rentalRequestId": coid, "chargeType": "adjustment", "amount": "1000.00", "description": "M1"})
    inv1 = trpc(admin, "rentalCharges.generateInvoice", {"rentalRequestId": coid})["invoiceId"]
    trpc(admin, "rentalCharges.create", {"rentalRequestId": coid, "chargeType": "adjustment", "amount": "1000.00", "description": "M2"})
    inv2 = trpc(admin, "rentalCharges.generateInvoice", {"rentalRequestId": coid})["invoiceId"]
    t1, t2 = float(inv(admin, inv1)["totalAmount"]), float(inv(admin, inv2)["totalAmount"])
    # Tag a payment to invoice #2 only (held). Before convert: nothing settles.
    trpc(admin, "rentalPrepayments.create", {
        "rentalRequestId": coid, "amount": f"{t2:.2f}", "paymentMethod": "cheque", "invoiceId": inv2,
    })
    if inv(admin, inv2)["status"] == "paid":
        fails.append("R2: tagged payment must stay held until converted")
    trpc(admin, "rentalPrepayments.convertToRent", {"rentalRequestId": coid})
    r1, r2 = inv(admin, inv1), inv(admin, inv2)
    print(f"  after convert(tag→#{inv2}): #{inv1} status={r1['status']} | #{inv2} status={r2['status']}")
    if r2["status"] != "paid":
        fails.append(f"R2: tagged invoice #{inv2} should be paid after convert, got {r2['status']}")
    if r1["status"] == "paid":
        fails.append(f"R2: untagged invoice #{inv1} must NOT be paid by a payment tagged to #{inv2}")
    # Untagged payment (held) → convert → FIFO onto the oldest open invoice (#1).
    trpc(admin, "rentalPrepayments.create", {
        "rentalRequestId": coid, "amount": f"{t1:.2f}", "paymentMethod": "cash",
    })
    trpc(admin, "rentalPrepayments.convertToRent", {"rentalRequestId": coid})
    r1 = inv(admin, inv1)
    if r1["status"] != "paid":
        fails.append(f"R2: untagged FIFO payment should settle oldest invoice #{inv1}, got {r1['status']}")
    else:
        print(f"  ✓ converted: tagged settled only #{inv2}; FIFO then settled #{inv1}")

    # ── R3: bidirectional + reversal ─────────────────────────────────────────
    print("R3 回归: 发票侧录收款入账本 + 删除回退")
    mid3 = make_model(admin, "R3")
    order3 = trpc(admin, "rentals.adminCreate", {
        "customerName": "回归客户R3", "customerPhone": "4160000303",
        "startDate": "2026-07-01", "endDate": "2026-07-08",
        "equipmentModelId": mid3, "rentalFee": "1000.00",
        "insuranceType": "basic", "taxProvince": "ON",
    })
    oid3 = order3["id"]
    iid3 = trpc(admin, "invoices.generateFromRental", {"rentalId": oid3})["invoiceId"]
    t3 = float(inv(admin, iid3)["totalAmount"])
    # Record from the INVOICE side.
    trpc(admin, "invoices.recordPayment", {
        "invoiceId": iid3, "amount": t3, "paymentMethod": "e_transfer", "paymentDate": "2026-07-02",
        "reference": "CHQ-001",
    })
    row3 = inv(admin, iid3)
    if row3["status"] != "paid":
        fails.append(f"R3: invoice-side payment should mark paid, got {row3['status']}")
    # …and it must appear in the ORDER's 预收款 ledger (录收款=录预收款, same ledger).
    ledger = trpc(admin, "rentalPrepayments.list", {"rentalRequestId": oid3}, method="GET")
    if not any(abs(float(p["amount"]) - t3) < 0.005 for p in ledger):
        fails.append("R3: invoice-side payment did not surface in the order prepayment ledger")
    else:
        print(f"  ✓ invoice-side payment ({t3}) visible in order ledger ({len(ledger)} entr.)")
    # A payment already on an issued invoice must NOT be deletable in place —
    # the editable guard forces the waive/credit-note path so the issued
    # document is never desynced. Assert the guard holds and the invoice stays paid.
    pid = ledger[0]["id"]
    try:
        trpc(admin, "rentalPrepayments.delete", {"id": pid, "reason": "other", "reasonNote": "e2e: must be rejected"})
        fails.append("R3: deleting an invoiced prepayment should be rejected by the editable guard")
    except TrpcError as e:
        if e.code != "PRECONDITION_FAILED":
            fails.append(f"R3: expected PRECONDITION_FAILED on invoiced-prepayment delete, got {e.code}")
        else:
            print("  ✓ invoiced-prepayment delete rejected → waive/credit-note path enforced")
    row3 = inv(admin, iid3)
    if row3["status"] != "paid" or float(row3["amountPaid"]) < t3 - 0.005:
        fails.append(f"R3: rejected delete must not disturb the invoice, got paid={row3['amountPaid']} status={row3['status']}")
    else:
        print(f"  ✓ invoice untouched after rejected delete → status={row3['status']} paid={row3['amountPaid']}")

    # ── R4: overpayment → record refund nets the order balance (no phantom debt) ─
    print("R4 退款: 超额预收 → 记录退款 → 余额归0(不再欠顾客)")
    mid4 = make_model(admin, "R4")
    order4 = trpc(admin, "rentals.adminCreate", {
        "customerName": "退款客户R4", "customerPhone": "4160000404",
        "startDate": "2026-07-01", "endDate": "2026-07-08",
        "equipmentModelId": mid4, "rentalFee": "300.00",
        "insuranceType": "basic", "taxProvince": "ON",
    })
    oid4 = order4["id"]
    iid4 = trpc(admin, "invoices.generateFromRental", {"rentalId": oid4})["invoiceId"]
    t4 = float(inv(admin, iid4)["totalAmount"])
    # Customer overpays $1000 (held → convert → applied).
    trpc(admin, "rentalPrepayments.create", {"rentalRequestId": oid4, "amount": "1000.00", "paymentMethod": "cash"})
    trpc(admin, "rentalPrepayments.convertToRent", {"rentalRequestId": oid4})

    tot, prepaid = order_bal(admin, oid4)
    overpaid = round(prepaid - tot, 2)
    print(f"  overpaid: total={tot} applied={prepaid} → 应退 {overpaid}")
    if overpaid <= 0:
        fails.append(f"R4: expected an overpayment, got applied={prepaid} total={tot}")
    # Guard: refunding more than owed is rejected.
    try:
        trpc(admin, "rentalPrepayments.recordRefund", {"rentalRequestId": oid4, "amount": f"{overpaid + 50:.2f}"})
        fails.append("R4: refund exceeding the overpayment should have been rejected")
    except Exception:
        pass
    # Record the real refund → order balance nets to 0.
    trpc(admin, "rentalPrepayments.recordRefund", {"rentalRequestId": oid4, "amount": f"{overpaid:.2f}", "paymentMethod": "cash"})
    tot2, prepaid2 = order_bal(admin, oid4)
    if abs(prepaid2 - tot2) > 0.005:
        fails.append(f"R4: after refund expected applied==total (balance 0), got applied={prepaid2} total={tot2}")
    else:
        print(f"  ✓ after 记录退款: order nets to 0 (applied={prepaid2}/{tot2}), invoice still paid={inv(admin, iid4)['status']}")
    # Invoice must remain settled (refund doesn't un-pay the rent).
    if inv(admin, iid4)["status"] != "paid":
        fails.append(f"R4: refund must not un-settle the invoice, got {inv(admin, iid4)['status']}")

    print()
    if fails:
        print(f"✗ {len(fails)} FAILURE(S):")
        for f in fails:
            print(f"   - {f}")
        sys.exit(1)
    print("✓ ALL 4 ROUNDS PASSED — 预收款 ↔ 发票联动 + 转租金 + 退款 verified")


if __name__ == "__main__":
    main()
