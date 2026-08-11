"""Disposable two-unit browser acceptance for rental asset progress."""
import os
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from harness import TrpcError, api_admin, api_anon, psql, trpc, ui_login_admin  # noqa: E402


BASE_URL = os.environ.get("OPENRENTAL_BASE_URL", "http://localhost:3114")
ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs" / "qa" / "evidence"


def assert_stage(rows, fleet_id, stage, inspection=None):
    row = next(item for item in rows if item["rentalFleetId"] == fleet_id)
    assert row["stage"] == stage, row
    if inspection:
        assert row["returnInspection"] == inspection, row
    return row


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    admin = api_admin()
    tag = os.getpid() % 100000
    category = f"Progress QA {tag}"
    customer = f"Progress Browser Customer {tag}"

    trpc(admin, "equipmentCategories.create", {"name": category})
    model_id = trpc(admin, "equipmentModels.create", {
        "category": category,
        "brand": "ProgressQA",
        "model": f"Twin-{tag}",
        "dailyRate": "225.00",
        "weeklyRate": "1100.00",
        "equipmentType": "machine",
    })["id"]
    fleet_ids = []
    for suffix in ("A", "B"):
        fleet_ids.append(trpc(admin, "rentalFleet.create", {
            "brand": "ProgressQA",
            "model": f"Twin-{tag}",
            "category": category,
            "serialNumber": f"PROGRESS-{tag}-{suffix}",
            "assetNumber": f"QA-{tag}-{suffix}",
            "currentStatus": "available",
            "equipmentModelId": model_id,
        })["id"])

    quote = trpc(admin, "rentals.previewMultiItemQuote", {
        "startDate": "2026-10-01",
        "endDate": "2026-10-04",
        "deliveryMethod": "pickup",
        "taxProvince": "ON",
        "insuranceType": "basic",
        "items": [{
            "equipmentModelId": model_id,
            "fleetIds": fleet_ids,
            "itemType": "machine",
            "quantity": 2,
        }],
    }, method="GET")
    rental = trpc(admin, "rentals.adminCreateWithItems", {
        "customerName": customer,
        "customerPhone": f"4168{tag:06d}"[:10],
        "startDate": "2026-10-01",
        "endDate": "2026-10-04",
        "deliveryMethod": "pickup",
        "taxProvince": "ON",
        "insuranceType": "basic",
        "priceMatchEnabled": True,
        "priceMatchCompetitor": "Disposable acceptance baseline",
        "priceMatchAmount": "1000.00",
        "priceMatchNote": "Deterministic billable total for progress acceptance",
        "rentalFee": "1000.00",
        "freightCost": "0.00",
        "insuranceCost": "150.00",
        "taxAmount": "149.50",
        "depositAmount": "0.00",
        "totalAmount": "1299.50",
        "items": [{
            "equipmentModelId": model_id,
            "availableFleetIds": fleet_ids,
            "itemType": "machine",
            "quantity": 2,
        }],
    })
    rental_id = rental["rental"]["id"]

    pricing = [float(value) for value in psql(
        f'SELECT concat_ws(\'|\', "rentalFee", "freightCost", "insuranceCost", "taxAmount", "depositAmount", "totalAmount") FROM rental_requests WHERE id={rental_id}'
    ).split("|")]
    rental_fee, freight, insurance, tax, deposit, before_total = pricing
    expected_invoice_total = rental_fee + freight + insurance + tax
    assert abs(before_total - expected_invoice_total) < 0.02, pricing
    assert before_total > 0 and float(quote["totalAmount"]) > 0
    trpc(admin, "rentals.updateStatus", {"id": rental_id, "status": "approved"})
    assert int(psql(f'SELECT count(*) FROM dispatch_orders WHERE "rentalRequestId"={rental_id}')) == 0
    approved = trpc(admin, "rentalAssetProgress.byRental", {"rentalId": rental_id}, method="GET")
    assert len(approved) == 2
    assert all(row["stage"] == "entry_ready" and row["deliveryTransport"] == "disabled" for row in approved)

    trpc(admin, "rentals.updateStatus", {"id": rental_id, "status": "active"})
    for fleet_id in fleet_ids:
        trpc(admin, "rentalAssetProgress.startReturn", {"rentalId": rental_id, "rentalFleetId": fleet_id})
    try:
        trpc(admin, "rentals.closeRental", {"id": rental_id})
        raise AssertionError("completion unexpectedly succeeded without return evidence")
    except TrpcError as error:
        assert error.code == "PRECONDITION_FAILED", error

    token = trpc(admin, "inspections.createToken", {
        "rentalId": rental_id,
        "rentalFleetId": fleet_ids[0],
        "inspectionType": "return",
    })["token"]
    trpc(api_anon(), "inspections.createWithToken", {
        "token": token,
        "type": "return",
        "rentalId": rental_id,
        "rentalFleetId": fleet_ids[0],
        "overallCondition": "good",
        "damageSeverity": "none",
    })
    trpc(admin, "rentalAssetProgress.bypassInspection", {
        "rentalId": rental_id,
        "rentalFleetId": fleet_ids[1],
        "inspectionType": "return",
        "reason": "Disposable acceptance: remote-yard supervisor verified unit",
    })
    ready = trpc(admin, "rentalAssetProgress.byRental", {"rentalId": rental_id}, method="GET")
    assert_stage(ready, fleet_ids[0], "return_ready", "completed")
    assert_stage(ready, fleet_ids[1], "return_ready", "bypassed")

    page_errors = []
    bad_responses = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        admin_page = browser.new_page(viewport={"width": 1440, "height": 1100})
        admin_page.on("pageerror", lambda error: page_errors.append(f"admin: {error}"))
        admin_page.on("response", lambda response: bad_responses.append((response.status, response.url)) if response.status >= 500 else None)
        ui_login_admin(admin_page)
        admin_page.goto(f"{BASE_URL}/admin", wait_until="networkidle")
        expect(admin_page.locator('a[href="/admin/dispatch"]')).to_have_count(0)
        mobile_admin_page = browser.new_page(viewport={"width": 430, "height": 932})
        mobile_admin_page.goto(f"{BASE_URL}/admin", wait_until="networkidle")
        expect(mobile_admin_page.locator('a[href="/admin/dispatch"]')).to_have_count(0)
        mobile_admin_page.close()
        admin_page.goto(f"{BASE_URL}/admin/rental-management", wait_until="networkidle")
        row = admin_page.locator("tr").filter(has_text=customer)
        expect(row).to_have_count(1)
        row.click()
        expect(admin_page.get_by_text("Equipment lifecycle progress")).to_be_visible()
        expect(admin_page.get_by_text("Inspected", exact=True)).to_be_visible()
        expect(admin_page.get_by_text("Admin bypass", exact=True).first).to_be_visible()
        expect(admin_page.get_by_text("Dispatch", exact=True)).to_have_count(0)
        expect(admin_page.get_by_text("Return complete — ready to close", exact=True)).to_be_visible()
        expect(admin_page.get_by_text("Review the actual return time and additional charges. Closing finalizes billing and releases the equipment.", exact=True)).to_be_visible()
        admin_page.get_by_role("button", name="Review and close", exact=True).click()
        expect(admin_page.get_by_role("heading", name="Close Rental", exact=True)).to_be_visible()
        expect(admin_page.get_by_text("Before closing, confirm every unit has been physically picked up", exact=False)).to_have_count(0)
        admin_page.get_by_role("button", name="Cancel", exact=True).click()
        admin_page.screenshot(path=str(EVIDENCE / "rental-asset-progress-admin-ready.png"), full_page=True)

        field_page = browser.new_page(viewport={"width": 430, "height": 932})
        field_page.on("pageerror", lambda error: page_errors.append(f"field: {error}"))
        field_page.on("response", lambda response: bad_responses.append((response.status, response.url)) if response.status >= 500 else None)
        field_page.goto(f"{BASE_URL}/field-access", wait_until="networkidle")
        field_page.get_by_role("button", name="Login with password").click()
        field_page.get_by_label("Username").fill("inspector")
        field_page.get_by_label("Password").fill("field123")
        field_page.locator('form button[type="submit"]').click()
        field_page.wait_for_url("**/field-dashboard")
        field_page.goto(f"{BASE_URL}/field-deliveries", wait_until="networkidle")
        field_page.get_by_role("button", name="Return tasks 2").click()
        expect(field_page.get_by_text(customer).first).to_be_visible()
        expect(field_page.get_by_text("Inspected", exact=True)).to_be_visible()
        expect(field_page.get_by_text("Admin bypass", exact=True).first).to_be_visible()
        expect(field_page.get_by_text("Dispatch off", exact=True).first).to_be_visible()
        expect(field_page.get_by_role("button", name="Review and close", exact=True)).to_have_count(0)
        for suffix in ("A", "B"):
            expect(field_page.get_by_text(f"PROGRESS-{tag}-{suffix}", exact=True)).to_be_visible()
            expect(field_page.get_by_text(f"QA-{tag}-{suffix}", exact=True)).to_have_count(0)
        field_page.screenshot(path=str(EVIDENCE / "rental-asset-progress-pwa-ready.png"), full_page=True)

        trpc(admin, "rentals.closeRental", {"id": rental_id})
        admin_page.wait_for_timeout(11_000)
        expect(admin_page.get_by_text("Completed", exact=True).first).to_be_visible()
        field_page.get_by_role("button", name="Completed 2").click()
        expect(field_page.get_by_text(customer).first).to_be_visible()
        field_page.screenshot(path=str(EVIDENCE / "rental-asset-progress-pwa-completed.png"), full_page=True)

        # Re-enable dispatch in the disposable environment and prove that the
        # unified card still carries the old operator-critical logistics data.
        trpc(admin, "featureFlags.setEnabled", {
            "key": "dispatch_workflow",
            "enabled": True,
            "reason": "Disposable acceptance: verify legacy dispatch details",
        })
        dispatch_customer = f"Dispatch Detail Customer {tag}"
        dispatch_phone = f"4167{tag:06d}"[:10]
        dispatch_address = "55 Dispatch Test Rd, Toronto, ON"
        dispatch_rental = trpc(admin, "rentals.adminCreateWithItems", {
            "customerName": dispatch_customer,
            "customerPhone": dispatch_phone,
            "startDate": "2026-10-10",
            "endDate": "2026-10-12",
            "deliveryMethod": "delivery",
            "deliveryAddress": dispatch_address,
            "taxProvince": "ON",
            "insuranceType": "basic",
            "priceMatchEnabled": True,
            "priceMatchCompetitor": "Disposable dispatch acceptance",
            "priceMatchAmount": "500.00",
            "priceMatchNote": "Deterministic dispatch-detail fixture",
            "rentalFee": "500.00",
            "freightCost": "0.00",
            "insuranceCost": "75.00",
            "taxAmount": "74.75",
            "depositAmount": "0.00",
            "totalAmount": "649.75",
            "items": [{
                "equipmentModelId": model_id,
                "availableFleetIds": [fleet_ids[0]],
                "itemType": "machine",
                "quantity": 1,
            }],
        })["rental"]["id"]
        trpc(admin, "rentals.updateStatus", {"id": dispatch_rental, "status": "approved"})
        dispatch_id = int(psql(
            f'SELECT id FROM dispatch_orders WHERE "rentalRequestId"={dispatch_rental} AND "orderType"=\'delivery\''
        ))
        driver_id = int(psql("""
            INSERT INTO drivers (name, phone, "userId")
            SELECT 'Progress QA Driver', '4165550199', id FROM users WHERE username='inspector'
            RETURNING id
        """).splitlines()[0])
        trpc(admin, "dispatch.assignDriver", {"id": dispatch_id, "driverId": driver_id})
        trpc(admin, "dispatch.update", {
            "id": dispatch_id,
            "deliveryAddress": dispatch_address,
            "notes": "Call the site foreman before arrival",
            "distance": "18.25",
        })

        field_page.reload(wait_until="networkidle")
        field_page.get_by_role("button", name="Entry 1").click()
        expect(field_page.get_by_text(dispatch_customer).first).to_be_visible()
        expect(field_page.get_by_text(dispatch_address, exact=False)).to_be_visible()
        expect(field_page.get_by_text(dispatch_phone, exact=True)).to_be_visible()
        expect(field_page.get_by_text("Call the site foreman before arrival", exact=False)).to_be_visible()
        expect(field_page.get_by_text("18.25 km", exact=False)).to_be_visible()
        field_page.get_by_label("Driver notes").fill("Disposable route verified")
        field_page.get_by_role("button", name="Mark in transit").click()
        expect(field_page.get_by_text("In transit", exact=True).first).to_be_visible()
        assert psql(f'SELECT "driverNotes" FROM dispatch_orders WHERE id={dispatch_id}') == "Disposable route verified"
        trpc(admin, "featureFlags.setEnabled", {
            "key": "dispatch_workflow",
            "enabled": False,
            "reason": "Disposable acceptance: restore safe default",
        })
        browser.close()

    assert not page_errors, page_errors
    assert not bad_responses, bad_responses
    assert psql(f"SELECT status FROM rental_requests WHERE id={rental_id}") == "completed"
    assert all(psql(f'SELECT "currentStatus" FROM rental_fleet WHERE id={fleet_id}') == "available" for fleet_id in fleet_ids)
    invoice_total = float(psql(f'SELECT "totalAmount" FROM invoices WHERE "rentalId"={rental_id} AND "deletedAt" IS NULL ORDER BY id DESC LIMIT 1'))
    assert abs(invoice_total - expected_invoice_total) < 0.02, (
        f"billable={expected_invoice_total:.2f} deposit={deposit:.2f} "
        f"saved order={before_total:.2f} invoice={invoice_total:.2f}"
    )
    completed = trpc(admin, "rentalAssetProgress.byRental", {"rentalId": rental_id}, method="GET")
    assert all(row["stage"] == "completed" for row in completed)
    for fleet_id in fleet_ids:
        timeline = trpc(admin, "rentalAssetProgress.timeline", {"rentalId": rental_id, "rentalFleetId": fleet_id}, method="GET")
        assert any(event["eventType"] == "completed" for event in timeline)

    print(f"ASSET PROGRESS BROWSER ACCEPTANCE OK rental={rental_id} fleets={fleet_ids}")
    print(f"pricing billable={expected_invoice_total:.2f} deposit={deposit:.2f} order={before_total:.2f} invoice={invoice_total:.2f} dispatches=0")
    print(f"evidence={EVIDENCE}")


if __name__ == "__main__":
    main()
