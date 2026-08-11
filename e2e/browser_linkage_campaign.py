"""Disposable real-browser proof for rental lifecycle linkage.

The runner prepares and destroys the database. This campaign creates only test
records in that disposable database, then drives the rendered admin UI through
Playwright: login, approve, activate, verify blocked completion, inspect, and
complete. Database assertions prove the corresponding fleet/invoice linkage.
"""
import os
import sys

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, api_anon, psql, trpc  # noqa: E402


BASE_URL = os.environ.get("OPENRENTAL_BASE_URL", "http://localhost:3100")


def main():
    admin = api_admin()
    tag = os.getpid() % 100000
    customer = f"浏览器联动客户{tag}"

    trpc(admin, "equipmentCategories.create", {"name": f"浏览器类{tag}"})
    trpc(admin, "equipmentModels.create", {
        "category": f"浏览器类{tag}",
        "brand": "PW",
        "model": f"PW-{tag}",
        "dailyRate": "200.00",
        "weeklyRate": "1000.00",
        "equipmentType": "machine",
    })
    fleet_id = trpc(admin, "rentalFleet.create", {
        "brand": "PW",
        "model": f"PW-{tag}",
        "category": f"浏览器类{tag}",
        "serialNumber": f"PW-BROWSER-{tag}",
        "currentStatus": "available",
    })["id"]
    rental_id = trpc(admin, "rentals.adminCreate", {
        "customerName": customer,
        "customerPhone": f"416{tag:07d}"[:11],
        "rentalFleetId": fleet_id,
        "startDate": "2026-08-01",
        "endDate": "2026-08-02",
        "deliveryMethod": "pickup",
        "insuranceType": "basic",
        "rentalFee": "400.00",
        "freightCost": "0.00",
        "insuranceCost": "60.00",
        "taxAmount": "59.80",
        "depositAmount": "0.00",
        "totalAmount": "519.80",
    })["id"]

    page_errors = []
    bad_responses = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "response",
            lambda response: bad_responses.append((response.status, response.url))
            if response.status >= 500
            else None,
        )

        page.goto(f"{BASE_URL}/admin/login", wait_until="networkidle")
        page.locator("#login-username").fill("admin")
        page.locator("#login-password").fill("admin123")
        page.locator('form button[type="submit"]').click()
        page.wait_for_url("**/admin")
        expect(page.get_by_role("heading").first).to_be_visible()

        page.goto(f"{BASE_URL}/admin/rental-management", wait_until="networkidle")
        expect(page.locator("h1").first).to_be_visible()
        row = page.locator("tr").filter(has_text=customer)
        expect(row).to_have_count(1)
        status = row.locator("select")

        status.select_option("approved")
        expect(status).to_have_value("approved", timeout=15_000)
        assert psql(f"select status from rental_requests where id={rental_id}") == "approved"

        status.select_option("active")
        expect(status).to_have_value("active", timeout=15_000)
        assert psql(f"select status from rental_requests where id={rental_id}") == "active"
        assert psql(f'select "currentStatus" from rental_fleet where id={fleet_id}') == "rented"

        # Completion must be rejected until the assigned unit has a return inspection.
        page.once("dialog", lambda dialog: dialog.accept())
        status.select_option("completed")
        page.wait_for_timeout(1_000)
        assert psql(f"select status from rental_requests where id={rental_id}") == "active"

        token = trpc(admin, "inspections.createToken", {
            "rentalId": rental_id,
            "rentalFleetId": fleet_id,
            "inspectionType": "return",
        })["token"]
        trpc(api_anon(), "inspections.createWithToken", {
            "token": token,
            "type": "return",
            "rentalId": rental_id,
            "rentalFleetId": fleet_id,
            "overallCondition": "good",
            "damageSeverity": "none",
        })

        page.reload(wait_until="networkidle")
        row = page.locator("tr").filter(has_text=customer)
        status = row.locator("select")
        page.once("dialog", lambda dialog: dialog.accept())
        status.select_option("completed")
        expect(status).to_have_value("completed", timeout=15_000)

        assert psql(f"select status from rental_requests where id={rental_id}") == "completed"
        assert psql(f'select "currentStatus" from rental_fleet where id={fleet_id}') == "available"
        assert int(psql(f"select count(*) from invoices where \"rentalId\"={rental_id} and \"sourceKey\"='rental:{rental_id}:base'")) == 1

        page.screenshot(path="/tmp/openrental-browser-linkage.png", full_page=True)
        browser.close()

    assert not page_errors, f"browser page errors: {page_errors}"
    assert not bad_responses, f"server 5xx responses: {bad_responses}"
    print("BROWSER LINKAGE OK")
    print(f"rental={rental_id} fleet={fleet_id} screenshot=/tmp/openrental-browser-linkage.png")


if __name__ == "__main__":
    main()
