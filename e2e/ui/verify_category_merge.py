"""Focused real-browser check for the category-merge fix.

A category that spans TWO brand-models (e.g. Northline NX-25 + Cedarworks CW-70) must
appear as ONE entry in the order-form equipment dropdown — with the availability
of BOTH models combined — and an order must auto-assign any unit in the category.
Seed is created by run-category-merge.sh.
"""
import sys
from playwright.sync_api import sync_playwright
from uikit import browser_page, login, goto, Tally

CAT = "双品牌2吨挖机"


def lbl_input(page, label):
    return page.locator(f'xpath=//label[contains(normalize-space(.),"{label}")]/following::input[1]').first


def main():
    T = Tally()
    with sync_playwright() as p:
        b, page, _errors = browser_page(p)
        login(page)
        goto(page, "/admin/rental-management")
        page.locator('button:has-text("创建订单")').first.click()
        page.wait_for_timeout(900)
        d = page.locator('input[type=date]')
        d.nth(0).fill("2026-09-05")
        d.nth(1).fill("2026-09-07")
        page.wait_for_timeout(1400)

        # Locate the equipment-category dropdown (the select whose options mention CAT).
        target, opts = None, []
        for s in page.locator('select:visible').all():
            labels = [o.inner_text() for o in s.locator('option').all()]
            if any(CAT in (x or "") for x in labels):
                target, opts = s, labels
                break
        T.check("找到含该类别的设备下拉", target is not None, str(opts)[:160])

        cat_opts = [x for x in opts if CAT in x]
        T.check(f"该类别在下拉中只有1条(两品牌机型已合并),实际={len(cat_opts)}", len(cat_opts) == 1, str(cat_opts))
        T.check("合并可用台数=2/2(跨两品牌求和)", any("2/2" in x for x in cat_opts), str(cat_opts))

        if cat_opts:
            target.select_option(label=cat_opts[0])
            page.wait_for_timeout(1600)
            # Auto-assign (no specific unit) + create — exercises the category-pool
            # resolution in the single-item path (server picks a unit of either brand).
            lbl_input(page, "姓名").fill("类别合并验证")
            lbl_input(page, "电话").fill("4160000777")
            page.locator('.fixed button:has-text("创建订单"), [role=dialog] button:has-text("创建订单")').last.click()
            page.wait_for_timeout(2600)
            goto(page, "/admin/rental-management")
            page.wait_for_timeout(900)
            T.check("按类别下单(自动派台)成功→列表可见", "类别合并验证" in page.locator("body").inner_text())
        b.close()

    ok = T.done("类别合并验证")
    sys.exit(0 if ok else 1)


main()
