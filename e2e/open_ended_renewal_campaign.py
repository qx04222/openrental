"""Disposable browser campaign for rolling renewal and return operations."""
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from harness import api_admin, api_anon, psql, trpc, ui_login_admin  # noqa: E402


BASE_URL = os.environ.get("OPENRENTAL_BASE_URL", "http://localhost:3115")
ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs" / "qa" / "evidence" / "open-ended-renewal"


def iso_day(value: date) -> str:
    return value.isoformat()


def run_domain(code: str):
    result = subprocess.run(
        ["npx", "tsx", "-e", code],
        cwd=ROOT,
        env=os.environ.copy(),
        text=True,
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0:
        raise AssertionError(f"domain command failed\nstdout={result.stdout}\nstderr={result.stderr}")
    return result.stdout.strip()


def create_rental(admin, model_id, fleet_ids, customer, start_day, end_day, amount):
    rental = trpc(admin, "rentals.adminCreateWithItems", {
        "customerName": customer,
        "customerPhone": f"4169{os.getpid() % 1000000:06d}"[:10],
        "startDate": iso_day(start_day),
        "endDate": iso_day(end_day),
        "deliveryMethod": "pickup",
        "taxProvince": "ON",
        "insuranceType": "basic",
        "priceMatchEnabled": True,
        "priceMatchCompetitor": "Disposable rolling acceptance",
        "priceMatchAmount": f"{amount:.2f}",
        "priceMatchNote": "Deterministic disposable rolling-renewal fixture",
        "rentalFee": f"{amount:.2f}",
        "freightCost": "0.00",
        "insuranceCost": "0.00",
        "taxAmount": f"{amount * 0.13:.2f}",
        "depositAmount": "0.00",
        "totalAmount": f"{amount * 1.13:.2f}",
        "items": [{
            "equipmentModelId": model_id,
            "availableFleetIds": fleet_ids,
            "itemType": "machine",
            "quantity": len(fleet_ids),
        }],
    })["rental"]
    trpc(admin, "rentals.updateStatus", {"id": rental["id"], "status": "approved"})
    trpc(admin, "rentals.updateStatus", {"id": rental["id"], "status": "active"})
    return rental["id"]


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    admin = api_admin()
    tag = os.getpid() % 100000
    today = date.today()
    now = datetime.now(timezone.utc).replace(microsecond=0)
    category = f"Rolling QA {tag}"
    operations_customer = f"Rolling Operations Customer {tag}"
    settlement_customer = f"Rolling Settlement Customer {tag}"
    review_customer = f"Rolling Review Customer {tag}"

    trpc(admin, "featureFlags.setEnabled", {
        "key": "rolling_renewal_operations",
        "enabled": True,
        "reason": "Disposable browser acceptance",
    })
    trpc(admin, "equipmentCategories.create", {"name": category})
    model_id = trpc(admin, "equipmentModels.create", {
        "category": category,
        "brand": "RollingQA",
        "model": f"R28-{tag}",
        "dailyRate": "100.00",
        "weeklyRate": "600.00",
        "monthlyRate": "2000.00",
        "equipmentType": "machine",
    })["id"]

    fleets = {}
    for suffix in ("SETTLE", "A", "B", "REVIEW"):
        fleets[suffix] = trpc(admin, "rentalFleet.create", {
            "brand": "RollingQA",
            "model": f"R28-{tag}",
            "category": category,
            "serialNumber": f"ROLLING-{tag}-{suffix}",
            "assetNumber": f"FLEET-ROLL-{tag}-{suffix}",
            "currentStatus": "available",
            "equipmentModelId": model_id,
        })["id"]

    # Boundary/idempotency fixture: a valid future-dated rolling rental, then
    # call the real settlement service with a simulated date after day 28.
    settlement_end = today + timedelta(days=10)
    settlement_id = create_rental(
        admin, model_id, [fleets["SETTLE"]], settlement_customer,
        today + timedelta(days=1), settlement_end, 1000,
    )
    trpc(admin, "rollingRentals.start", {"rentalId": settlement_id, "confirmedAt": now})
    term_id = int(psql(f'SELECT id FROM rental_rolling_terms WHERE "rentalRequestId"={settlement_id}'))
    next_boundary = datetime.combine(settlement_end + timedelta(days=28), time.min, tzinfo=timezone.utc)
    settlement_code = f"""
      import {{ getDb, closePool }} from './server/db/index.ts';
      import {{ settleRollingBoundary }} from './server/services/rollingSettlement.ts';
      (async () => {{
        const db = await getDb();
        if (!db) throw new Error('db unavailable');
        const result = await settleRollingBoundary(db, {{ termId: {term_id}, now: new Date('{(next_boundary + timedelta(days=1)).isoformat()}') }});
        console.log(JSON.stringify(result));
        await closePool();
        process.exit(0);
      }})().catch((error) => {{ console.error(error); process.exit(1); }});
    """
    run_domain(settlement_code)
    run_domain(settlement_code)
    assert int(psql(f"SELECT count(*) FROM invoices WHERE \"sourceKey\" LIKE 'rolling:{settlement_id}:%'")) == 1

    # Historical orders stay untouched until an administrator confirms them.
    # They must still be visible as renewal-review candidates on the dashboard
    # and rental list instead of disappearing inside the standard count.
    review_id = create_rental(
        admin, model_id, [fleets["REVIEW"]], review_customer,
        today - timedelta(days=10), today - timedelta(days=1), 750,
    )

    # Two-unit operational fixture proves responsibility-aware overdue state,
    # per-unit pickup, inspection/bypass, completion, and availability release.
    operations_end = today + timedelta(days=5)
    operations_id = create_rental(
        admin, model_id, [fleets["A"], fleets["B"]], operations_customer,
        today, operations_end, 1800,
    )
    trpc(admin, "rollingRentals.start", {"rentalId": operations_id, "confirmedAt": now})
    ready_at = datetime.now(timezone.utc).replace(microsecond=0)
    trpc(admin, "rollingRentals.customerReady", {
        "rentalId": operations_id,
        "customerReadyAt": ready_at,
        "scheduledPickupAt": ready_at + timedelta(hours=2),
    })
    trpc(admin, "rollingRentals.setResponsibility", {
        "rentalId": operations_id,
        "responsibility": "customer",
        "reason": "Disposable acceptance: customer site access delayed",
    })
    overdue_at = datetime.combine(operations_end + timedelta(days=2), time.min, tzinfo=timezone.utc)
    overdue_code = f"""
      import {{ closePool }} from './server/db/index.ts';
      import {{ runOverdueCron }} from './server/jobs/overdueCron.ts';
      (async () => {{ console.log(JSON.stringify(await runOverdueCron({{ now: new Date('{overdue_at.isoformat()}') }}))); await closePool(); process.exit(0); }})()
        .catch((error) => {{ console.error(error); process.exit(1); }});
    """
    run_domain(overdue_code)
    assert psql(f"SELECT status FROM rental_requests WHERE id={operations_id}") == "overdue"
    overdue_progress = trpc(admin, "rentalAssetProgress.byRental", {"rentalId": operations_id}, method="GET")
    assert all(item["operationalState"] == "customer_overdue" for item in overdue_progress)

    trpc(admin, "rollingRentals.setResponsibility", {
        "rentalId": operations_id,
        "responsibility": "company",
        "reason": "Disposable acceptance: pickup transport was the actual delay",
    })
    run_domain(overdue_code)
    assert psql(f"SELECT status FROM rental_requests WHERE id={operations_id}") == "active"
    ready_progress = trpc(admin, "rentalAssetProgress.byRental", {"rentalId": operations_id}, method="GET")
    assert all(item["operationalState"] == "awaiting_pickup" for item in ready_progress)
    assert int(psql(f'SELECT count(*) FROM dispatch_orders WHERE "rentalRequestId"={operations_id}')) == 0

    stats_before = trpc(admin, "dashboard.stats", None, method="GET")
    assert stats_before["rentals"]["rolling"] >= 1
    assert stats_before["rentals"]["renewalReview"] >= 1
    assert stats_before["rentals"]["awaitingPickup"] >= 1
    assert all(psql(f'SELECT "currentStatus" FROM rental_fleet WHERE id={fleet_id}') == "rented" for fleet_id in fleets.values())

    page_errors = []
    bad_responses = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        admin_page = browser.new_page(viewport={"width": 1440, "height": 1100})
        admin_page.on("pageerror", lambda error: page_errors.append(f"admin: {error}"))
        admin_page.on("response", lambda response: bad_responses.append((response.status, response.url)) if response.status >= 500 else None)
        ui_login_admin(admin_page)
        admin_page.goto(f"{BASE_URL}/admin", wait_until="networkidle")
        expect(admin_page.get_by_text("Rental operations", exact=True)).to_be_visible()
        expect(admin_page.get_by_text("Awaiting pickup", exact=True)).to_be_visible()
        expected_breakdown = (
            f'{stats_before["rentals"]["rolling"]} confirmed · '
            f'{stats_before["rentals"]["renewalReview"]} to review'
        )
        expect(admin_page.get_by_text(expected_breakdown, exact=True)).to_be_visible()
        admin_page.goto(f"{BASE_URL}/admin/rental-management?rolling=all", wait_until="networkidle")
        expect(admin_page.get_by_text("Rolling and renewal-review rentals:", exact=False)).to_be_visible()
        review_row = admin_page.locator("tr").filter(has_text=review_customer)
        expect(review_row).to_have_count(1)
        expect(review_row.get_by_text("Renewal review", exact=True)).to_be_visible()
        confirmed_row = admin_page.locator("tr").filter(has_text=settlement_customer)
        expect(confirmed_row).to_have_count(1)
        expect(confirmed_row.get_by_text("Rolling", exact=True)).to_be_visible()
        admin_page.screenshot(path=str(EVIDENCE / "admin-rolling-list.png"), full_page=True)

        admin_page.set_viewport_size({"width": 430, "height": 932})
        admin_page.reload(wait_until="networkidle")
        expect(admin_page.get_by_text(review_customer, exact=True).first).to_be_visible()
        expect(admin_page.get_by_text("Renewal review", exact=True).first).to_be_visible()
        admin_page.screenshot(path=str(EVIDENCE / "admin-rolling-list-mobile.png"), full_page=True)
        admin_page.set_viewport_size({"width": 1440, "height": 1100})
        admin_page.goto(f"{BASE_URL}/admin/rental-management?tab=active", wait_until="networkidle")
        row = admin_page.locator("tr").filter(has_text=operations_customer)
        expect(row).to_have_count(1)
        row.click()
        expect(admin_page.get_by_text("Open-ended rolling rental", exact=True)).to_be_visible()
        expect(admin_page.get_by_text("Awaiting physical pickup", exact=True).first).to_be_visible()
        for suffix in ("A", "B"):
            expect(admin_page.get_by_text(f"ROLLING-{tag}-{suffix}", exact=True).first).to_be_visible()
        admin_page.screenshot(path=str(EVIDENCE / "admin-awaiting-pickup.png"), full_page=True)

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
        field_page.get_by_role("button", name="Return pending 2", exact=True).click()
        expect(field_page.get_by_text(operations_customer).first).to_be_visible()
        expect(field_page.get_by_role("button", name="Confirm physical pickup")).to_have_count(2)
        for suffix in ("A", "B"):
            expect(field_page.get_by_text(f"ROLLING-{tag}-{suffix}", exact=True).first).to_be_visible()
            expect(field_page.get_by_text(f"FLEET-ROLL-{tag}-{suffix}", exact=True)).to_have_count(0)
        field_page.screenshot(path=str(EVIDENCE / "pwa-awaiting-pickup.png"), full_page=True)

        for suffix in ("A", "B"):
            card = field_page.locator("article").filter(has_text=f"ROLLING-{tag}-{suffix}")
            pickup_button = card.get_by_role("button", name="Confirm physical pickup")
            expect(pickup_button).to_have_count(1)
            with field_page.expect_response(
                lambda response: "rollingRentals.pickup" in response.url and response.request.method == "POST"
            ) as pickup_response:
                pickup_button.click()
            assert pickup_response.value.ok, pickup_response.value.status
            expect(pickup_button).to_have_count(0, timeout=10_000)
        expect(field_page.get_by_role("button", name="Confirm physical pickup")).to_have_count(0)

        token = trpc(admin, "inspections.createToken", {
            "rentalId": operations_id,
            "rentalFleetId": fleets["A"],
            "inspectionType": "return",
        })["token"]
        trpc(api_anon(), "inspections.createWithToken", {
            "token": token,
            "type": "return",
            "rentalId": operations_id,
            "rentalFleetId": fleets["A"],
            "overallCondition": "good",
            "damageSeverity": "none",
        })
        trpc(admin, "rentalAssetProgress.bypassInspection", {
            "rentalId": operations_id,
            "rentalFleetId": fleets["B"],
            "inspectionType": "return",
            "reason": "Disposable acceptance: supervisor verified second unit",
        })
        field_page.reload(wait_until="networkidle")
        field_page.get_by_role("button", name="Return pending 2", exact=True).click()
        expect(field_page.get_by_text("Inspected", exact=True)).to_be_visible()
        expect(field_page.get_by_text("Admin bypass", exact=True).first).to_be_visible()
        expect(field_page.get_by_text("Picked up — return inspection required", exact=True).first).to_be_visible()
        field_page.screenshot(path=str(EVIDENCE / "pwa-awaiting-inspection.png"), full_page=True)

        trpc(admin, "rentals.closeRental", {"id": operations_id})
        field_page.wait_for_timeout(11_000)
        completed_tab = field_page.get_by_role("button", name="Completed 2", exact=True)
        completed_tab.click()
        expect(completed_tab).to_have_class(re.compile(r"bg-slate-950"))
        expect(field_page.get_by_text(operations_customer).first).to_be_visible()
        field_page.screenshot(path=str(EVIDENCE / "pwa-completed.png"), full_page=True)
        browser.close()

    assert not page_errors, page_errors
    assert not bad_responses, bad_responses
    assert psql(f"SELECT status FROM rental_requests WHERE id={operations_id}") == "completed"
    assert psql(f'SELECT status FROM rental_rolling_terms WHERE "rentalRequestId"={operations_id}') == "ended"
    assert all(psql(f'SELECT "currentStatus" FROM rental_fleet WHERE id={fleets[suffix]}') == "available" for suffix in ("A", "B"))
    completed = trpc(admin, "rentalAssetProgress.byRental", {"rentalId": operations_id}, method="GET")
    assert all(item["stage"] == "completed" and item["operationalState"] == "completed" for item in completed)
    stats_after = trpc(admin, "dashboard.stats", None, method="GET")
    assert stats_after["fleet"]["available"] >= stats_before["fleet"]["available"] + 2

    print(json.dumps({
        "ok": True,
        "settlementRentalId": settlement_id,
        "operationsRentalId": operations_id,
        "reviewRentalId": review_id,
        "fleetIds": fleets,
        "boundaryInvoiceCount": 1,
        "customerDelayState": "customer_overdue",
        "finalState": "completed",
        "evidence": str(EVIDENCE),
    }, indent=2))


if __name__ == "__main__":
    main()
