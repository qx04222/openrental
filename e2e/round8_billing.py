"""Round 8 — invoices / billing integrity (real-path E2E).

Regressions:
- R8-2/R8-4 (P1): invoices.updateStatus had no transition guard, so a 'paid'
  invoice could be flipped to 'draft' and then deleted (delete only blocked
  status==='paid'), orphaning payment records. Fix: settled-state transition
  guard + delete blocks any invoice with recorded payments.
- R8-1 (P1) payment-date TZ and R8-3 (P2) contract-PDF subtotal label are fixed
  in code and verified separately (DB check: payment stored at Toronto midnight;
  PDF subtotal now pre-tax).

Run: server up (dev mode, test DB). `python3 e2e/round8_billing.py`
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, trpc, TrpcError  # noqa: E402


def test_paid_invoice_cannot_regress_or_be_deleted():
    admin = api_admin()
    cust = trpc(admin, "customers.create", {"name": "R8 E2E", "source": "admin"})["id"]
    iid = trpc(admin, "invoices.createManual", {
        "customerId": cust, "type": "manual",
        "lineItems": [{"description": "Svc", "quantity": 1, "unitPrice": 100}],
    })["invoiceId"]
    total = float(trpc(admin, "invoices.getById", {"id": iid}, method="GET")["invoices"]["totalAmount"])
    trpc(admin, "invoices.recordPayment", {
        "invoiceId": iid, "amount": total, "paymentMethod": "cash", "paymentDate": "2026-06-14"})
    status = trpc(admin, "invoices.getById", {"id": iid}, method="GET")["invoices"]["status"]
    assert status == "paid", f"expected paid, got {status}"

    # R8-2: cannot regress a paid invoice to draft.
    try:
        trpc(admin, "invoices.updateStatus", {"id": iid, "status": "draft"})
        raise AssertionError("paid invoice was allowed to regress to draft")
    except TrpcError as e:
        assert e.code == "PRECONDITION_FAILED", f"unexpected: {e.code}"

    # R8-4: cannot delete an invoice with recorded payments.
    try:
        trpc(admin, "invoices.delete", {"id": iid})
        raise AssertionError("paid invoice was allowed to be deleted")
    except TrpcError as e:
        assert e.code == "PRECONDITION_FAILED", f"unexpected: {e.code}"

    # paid -> credited (refund) is still allowed.
    trpc(admin, "invoices.updateStatus", {"id": iid, "status": "credited"})
    print("PASS: paid invoice can't regress/delete; refund (credited) still allowed")


if __name__ == "__main__":
    test_paid_invoice_cannot_regress_or_be_deleted()
    print("ROUND8 BILLING OK")
