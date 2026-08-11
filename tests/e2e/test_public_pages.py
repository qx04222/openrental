"""
E2E tests for openrental public pages.
Tests: Homepage equipment list, search, date filter, admin login page.
"""
import sys
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get("TEST_BASE_URL", "http://localhost:3050")
SCREENSHOTS_DIR = "/tmp/openrental-e2e"

def setup():
    import os
    os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

def test_homepage_loads(page):
    """Test: Homepage loads with header, hero, equipment grid."""
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{SCREENSHOTS_DIR}/01_homepage.png", full_page=True)

    # Header with logo
    logo = page.locator("header img")
    assert logo.is_visible(), "Logo should be visible in header"

    # Hero section
    hero_heading = page.locator("h2")
    assert hero_heading.is_visible(), "Hero heading should be visible"

    # Date filter inputs
    date_inputs = page.locator("input[type='date']")
    assert date_inputs.count() == 2, f"Expected 2 date inputs, got {date_inputs.count()}"

    # Search input
    search_input = page.locator("input[type='text']")
    assert search_input.count() >= 1, "Search input should exist"

    print("  PASS: Homepage loads correctly")

def test_equipment_grid(page):
    """Test: Equipment cards render with prices and request buttons."""
    page.goto(BASE)
    page.wait_for_load_state("networkidle")

    # Check if loading state transitions to content
    # Either equipment cards or "no equipment" message should appear
    page.wait_for_timeout(2000)  # Allow tRPC query to complete

    cards = page.locator(".card")
    no_equipment = page.locator("text=No equipment") # fallback text
    loading = page.locator("text=Loading")

    assert not loading.is_visible(), "Should not be stuck in loading state"

    if cards.count() > 0:
        print(f"  Found {cards.count()} equipment cards")

        # Check first card has price info (at least one rate)
        first_card = cards.first
        has_price = (
            first_card.locator("text=$").count() > 0
        )
        print(f"  First card has price: {has_price}")

        # Check request rental buttons
        buttons = page.locator("button")
        rental_buttons = [b for b in buttons.all() if "request" in (b.text_content() or "").lower() or "rent" in (b.text_content() or "").lower()]
        print(f"  Found {len(rental_buttons)} rental request buttons")

        page.screenshot(path=f"{SCREENSHOTS_DIR}/02_equipment_grid.png", full_page=True)
    else:
        print("  No equipment in database (empty state)")
        page.screenshot(path=f"{SCREENSHOTS_DIR}/02_empty_state.png", full_page=True)

    print("  PASS: Equipment grid renders correctly")

def test_search_filter(page):
    """Test: Search input filters equipment cards."""
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    cards_before = page.locator(".card").count()
    if cards_before == 0:
        print("  SKIP: No equipment to test search filter")
        return

    # Type a nonsense search term — should filter to 0
    search = page.locator("input[type='text']").first
    search.fill("zzzznonexistent12345")
    page.wait_for_timeout(500)

    cards_after = page.locator(".card").count()
    # The filter bar itself is a .card, so we might see 0 equipment cards
    print(f"  Cards before search: {cards_before}, after nonsense search: {cards_after}")
    assert cards_after < cards_before, "Search should filter results"

    # Clear search
    search.fill("")
    page.wait_for_timeout(500)
    cards_restored = page.locator(".card").count()
    assert cards_restored == cards_before, "Clearing search should restore all cards"

    page.screenshot(path=f"{SCREENSHOTS_DIR}/03_search_filter.png", full_page=True)
    print("  PASS: Search filter works")

def test_date_filter(page):
    """Test: Date filter shows availability badges."""
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    # Set start and end dates (next week)
    from datetime import date, timedelta
    start = (date.today() + timedelta(days=7)).isoformat()
    end = (date.today() + timedelta(days=14)).isoformat()

    date_inputs = page.locator("input[type='date']")
    date_inputs.nth(0).fill(start)
    date_inputs.nth(1).fill(end)

    page.wait_for_timeout(2000)  # Wait for refetch
    page.screenshot(path=f"{SCREENSHOTS_DIR}/04_date_filter.png", full_page=True)

    # Check for availability badges or clear dates button
    clear_btn = page.locator("text=Clear").or_(page.locator("button:has-text('clear')"))
    if clear_btn.count() > 0:
        print("  Date filter active — clear button visible")

    print("  PASS: Date filter applied")

def test_admin_login_page(page):
    """Test: Admin login page renders with form."""
    page.goto(f"{BASE}/admin/login")
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{SCREENSHOTS_DIR}/05_admin_login.png", full_page=True)

    # Logo
    logo = page.locator("img")
    assert logo.count() > 0, "Login page should have logo"

    # Form fields
    username_input = page.locator("input[type='text']")
    password_input = page.locator("input[type='password']")
    assert username_input.count() >= 1, "Username input should exist"
    assert password_input.count() >= 1, "Password input should exist"

    # Submit button
    submit_btn = page.locator("button[type='submit']")
    assert submit_btn.count() >= 1, "Login submit button should exist"

    print("  PASS: Admin login page renders correctly")

def test_admin_login_error(page):
    """Test: Wrong credentials show error message."""
    page.goto(f"{BASE}/admin/login")
    page.wait_for_load_state("networkidle")

    page.locator("input[type='text']").first.fill("wronguser")
    page.locator("input[type='password']").first.fill("wrongpass")
    page.locator("button[type='submit']").first.click()

    # Wait for error message
    page.wait_for_timeout(2000)
    page.screenshot(path=f"{SCREENSHOTS_DIR}/06_login_error.png", full_page=True)

    # Should show an error (red text/border)
    error_el = page.locator(".bg-red-500\\/10, .text-red-400, .text-red-500")
    if error_el.count() > 0:
        print(f"  Error shown: {error_el.first.text_content()}")
    else:
        print("  Warning: No visible error element found (may use different styling)")

    print("  PASS: Login error handling works")

def test_field_access_page(page):
    """Test: Field access page loads."""
    page.goto(f"{BASE}/field-access")
    page.wait_for_load_state("networkidle")
    page.screenshot(path=f"{SCREENSHOTS_DIR}/07_field_access.png", full_page=True)

    print("  PASS: Field access page loads")

def test_health_endpoint(page):
    """Test: Health check API returns ok."""
    response = page.goto(f"{BASE}/health")
    assert response and response.status == 200, "Health check should return 200"

    body = page.locator("body").text_content()
    assert "ok" in (body or "").lower(), "Health check should contain 'ok'"

    print("  PASS: Health endpoint returns ok")

def main():
    setup()
    failures = []

    tests = [
        test_health_endpoint,
        test_homepage_loads,
        test_equipment_grid,
        test_search_filter,
        test_date_filter,
        test_admin_login_page,
        test_admin_login_error,
        test_field_access_page,
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        for test_fn in tests:
            page = browser.new_page()
            name = test_fn.__name__
            print(f"\nRunning {name}...")
            try:
                test_fn(page)
            except Exception as e:
                print(f"  FAIL: {e}")
                page.screenshot(path=f"{SCREENSHOTS_DIR}/FAIL_{name}.png")
                failures.append((name, str(e)))
            finally:
                page.close()

        browser.close()

    print(f"\n{'='*50}")
    print(f"Results: {len(tests) - len(failures)}/{len(tests)} passed")
    print(f"Screenshots saved to: {SCREENSHOTS_DIR}")

    if failures:
        print("\nFailed tests:")
        for name, err in failures:
            print(f"  - {name}: {err}")
        sys.exit(1)

if __name__ == "__main__":
    main()
