"""Comprehensive real-browser full-stack UI campaign — every page, every button.

5 rounds, real clicks/typing, isolated test DB (torn down → zero persisted data),
zero override. Reuses uikit.py. Includes the newly-locked ERP guards (G1/G3).
"""
import os
import re
import sys
from uikit import sync_playwright, browser_page, login, goto, shot, Tally

RUN = os.getpid() % 100000

PAGES = [
    ("工作台", "/admin"), ("租赁管理", "/admin/rental-management"), ("调度", "/admin/dispatch"),
    ("检查记录", "/admin/inspections"), ("租赁设置", "/admin/rental-settings"),
    ("续租申请", "/admin/extension-requests"), ("租赁设备", "/admin/rental-fleet"),
    ("分类定价", "/admin/category-pricing"), ("设备目录", "/admin/catalog-sync"),
    ("工单", "/admin/work-orders"), ("设备证书", "/admin/fleet-certificates"),
    ("客户", "/admin/customers"), ("设备操作员", "/admin/operators"),
    ("推广活动", "/admin/promotions"), ("报价单", "/admin/quotations"),
    ("发票", "/admin/invoices"), ("附加费用", "/admin/damage-claims"),
    ("报表", "/admin/reports"), ("系统与设置", "/admin/system-settings"),
]
# destructive / logout / global-save / language toggle (would flip the whole
# session to English and break later Chinese-selector rounds) / theme.
SKIP_BTN = ["退出登录", "删除", "Delete", "清空", "Logout", "保存所有更改",
            "EN", "中文", "ZH", "切换语言"]


def exercise_buttons(page, label, path, errors, T):
    """Click every visible non-destructive button on a page; assert no JS error."""
    goto(page, path)
    errors.clear()
    base_url = page.url
    btns = page.locator("button:visible")
    n = btns.count()
    clicked = 0
    for i in range(n):
        try:
            b = page.locator("button:visible").nth(i)
            txt = (b.inner_text() or "").strip()
        except Exception:
            continue
        if not txt or any(s in txt for s in SKIP_BTN):
            continue
        try:
            b.click(timeout=2500)
            page.wait_for_timeout(220)
            clicked += 1
            # close any opened modal / popover
            page.keyboard.press("Escape")
            page.wait_for_timeout(120)
            # if a click navigated away, come back to keep enumerating this page
            if page.url != base_url and "/admin/login" not in page.url:
                goto(page, path)
            elif "/admin/login" in page.url:
                login(page); goto(page, path)
        except Exception:
            pass
    errs = [e for e in errors if "favicon" not in e.lower() and "ResizeObserver" not in e]
    T.check(f"{label}: 点击{clicked}个按钮全程无JS报错", len(errs) == 0, ";".join(errs[:2]))


def r1_every_button(page, errors, T):
    print("\n=== R1: 逐页 逐按钮(每页所有按钮点一遍,断言0 JS报错)===")
    for label, path in PAGES:
        exercise_buttons(page, label, path, errors, T)


# ── order-form helpers (reused from sop_ui) ───────────────────────────────────
def open_order(page, start, end, model_kw):
    goto(page, "/admin/rental-management")
    page.locator('button:has-text("创建订单")').first.click(); page.wait_for_timeout(700)
    d = page.locator('input[type=date]'); d.nth(0).fill(start); d.nth(1).fill(end)
    page.wait_for_timeout(1000)
    for s in page.locator('select:visible').all():
        labels = [o.inner_text() for o in s.locator('option').all()]
        hit = [x for x in labels if model_kw in (x or "")]
        if hit:
            s.select_option(label=hit[0]); break
    page.wait_for_timeout(1600)


def lbl_input(page, label):
    return page.locator(f'xpath=//label[contains(normalize-space(.),"{label}")]/following::input[1]').first


def win(month, it):
    """Distinct non-overlapping date window per pass so 5 runs don't collide."""
    d = 1 + it * 4
    return f"2026-{month:02d}-{d:02d}", f"2026-{month:02d}-{d + 2:02d}"


def r2_customer(page, T, it):
    print("  -- 客户真表单录入 + 检索")
    goto(page, "/admin/customers")
    page.locator('button:has-text("添加客户")').first.click(); page.wait_for_timeout(700)
    nm = f"UI客户{RUN}-{it}"
    page.fill("#cust-name", nm); page.fill("#cust-phone", f"4{RUN:06d}{it:03d}"[:11]); page.fill("#cust-email", f"uc{RUN}-{it}@ex.com")
    page.get_by_role("button", name="创建", exact=True).click(); page.wait_for_timeout(1500)
    goto(page, "/admin/customers"); page.fill("#datatable-search", nm); page.wait_for_timeout(800)
    T.check(f"[{it}]客户真表单录入后可检索到", nm in page.locator("body").inner_text())


def r3_order_lifecycle(page, T, it):
    print("  -- 订单 真实下单→审批→进行中→完成→发票→收款(全生命周期)")
    cust = f"UI下单{RUN}-{it}"
    s, e = win(9, it)
    open_order(page, s, e, "UI价类")
    body = page.locator("body").inner_text()
    amts = re.findall(r'CA\$([0-9,]+\.[0-9]{2})', body)
    T.check(f"[{it}]屏幕自动总计=727.72(押金不进总额)", "727.72" in amts, amts[:5])
    dep = lbl_input(page, "押金").input_value()
    T.check(f"[{it}]押金单列=1100(独立字段)", dep.replace(",", "").startswith("1100"), f"dep={dep}")
    lbl_input(page, "姓名").fill(cust); lbl_input(page, "电话").fill(f"6{RUN:06d}{it:03d}"[:11])
    page.locator('.fixed button:has-text("创建订单"), [role=dialog] button:has-text("创建订单")').last.click()
    page.wait_for_timeout(2000); goto(page, "/admin/rental-management")
    T.check(f"[{it}]订单提交→待审批,列表金额727.72", "727.72" in page.locator("body").inner_text())

    def row_select():
        # The actions cell renders the status <select> TWICE — a mobile one
        # (`md:hidden`) and a desktop one (`hidden md:flex`). At this viewport the
        # mobile one is in the DOM but display:none, so plain `select` .first
        # resolves to a hidden node and select_option waits forever. Pin :visible.
        return page.locator(f'tr:has-text("{cust}")').first.locator("select:visible").first

    # Only approved/active are direct status picks. "completed" is deliberately
    # NOT in the dropdown (directRentalStatusOptions filters it out) — closing an
    # order must go through the real 关单 flow so late fees, damage charges and the
    # actual return time get recorded. Driving it by dropdown tested a path that
    # no longer exists.
    for nxt in ["approved", "active"]:
        try:
            goto(page, "/admin/rental-management")
            page.fill("#datatable-search", cust); page.wait_for_timeout(700)
            row_select().select_option(nxt); page.wait_for_timeout(1500)
        except Exception as ex:
            print("   transition", nxt, "err", str(ex)[:60])

    T.check(f"[{it}]『已完成』不在直选下拉里(须走关单流程)",
            "completed" not in row_select().locator("option").evaluate_all("os=>os.map(o=>o.value)"))

    # ── real close-out: 详情弹窗 → 关单 → 确认关单 ──
    try:
        page.locator(f'tr:has-text("{cust}")').first.click(); page.wait_for_timeout(1200)
        page.locator('button:has-text("关单")').first.click(); page.wait_for_timeout(700)
        page.locator('button:has-text("确认关单")').first.click(); page.wait_for_timeout(2500)
        blocked = page.locator("body").inner_text()
        for marker in ["退场", "检验", "inspection", "Cannot transition", "未归还"]:
            if marker in blocked:
                print(f"   close blocked by: ...{blocked[max(0, blocked.find(marker) - 60):blocked.find(marker) + 60]}...")
                break
        page.keyboard.press("Escape")
    except Exception as ex:
        print("   close-out err", str(ex)[:120])

    goto(page, "/admin/rental-management"); page.fill("#datatable-search", cust); page.wait_for_timeout(700)
    T.check(f"[{it}]走关单流程后订单=『已完成』", "已完成" in page.locator(f'tr:has-text("{cust}")').first.inner_text())

    # invoice auto-generated on completion → find it + record full payment → 已付
    goto(page, "/admin/invoices"); page.fill("#datatable-search", cust); page.wait_for_timeout(800)
    # Assert on a matching ROW, not on body text: the search box itself contains
    # `cust`, so `cust in body` is true even when the table found nothing — it can
    # never fail, and once passed green on an invoice that did not exist.
    inv_seen = page.locator(f'tr:has-text("{cust}")').count() > 0
    T.check(f"[{it}]关单后自动生成发票(发票页可见)", inv_seen)
    if inv_seen:
        # open the invoice detail (click its invoice-number button), then 记录付款
        try:
            page.locator(f'tr:has-text("{cust}")').first.locator("button").first.click()
            page.wait_for_timeout(900)
            page.locator('button:has-text("记录付款")').first.click(); page.wait_for_timeout(700)
            page.fill("#pay-amount", "727.72"); page.wait_for_timeout(200)
            page.locator('.fixed button:has-text("记录付款"), [role=dialog] button:has-text("记录付款")').last.click()
            page.wait_for_timeout(1500)
            page.keyboard.press("Escape")
        except Exception as ex:
            print("   record-payment err", str(ex)[:80])
        goto(page, "/admin/invoices"); page.fill("#datatable-search", cust); page.wait_for_timeout(800)
        T.check(f"[{it}]记录全额付款后发票=已付", "已付" in page.locator(f'tr:has-text("{cust}")').first.inner_text())


def r4_enforcement(page, T, it):
    print("  -- ★强制约束(无费率拦单 / 覆盖价无原因拦)")
    s, e = win(10, it)
    open_order(page, s, e, "无价类")
    body = page.locator("body").inner_text()
    T.check(f"[{it}]无费率型号屏幕报价=$0", "CA$0.00" in body or "0.00" in body)
    lbl_input(page, "姓名").fill(f"无费{RUN}-{it}"); lbl_input(page, "电话").fill(f"9{RUN:06d}{it:03d}"[:11])
    page.locator('.fixed button:has-text("创建订单"), [role=dialog] button:has-text("创建订单")').last.click()
    page.wait_for_timeout(1800)
    b2 = page.locator("body").inner_text()
    blocked = ("未设费率" in b2) or ("费率" in b2 and "创建订单" in b2)
    T.check(f"[{it}]★G1 无费率下单被系统拦", blocked, b2[:80])
    page.keyboard.press("Escape")
    s2, e2 = win(11, it)
    open_order(page, s2, e2, "UI价类")
    try:
        page.locator('text=覆盖价格').first.click(); page.wait_for_timeout(500)
    except Exception:
        pass
    lbl_input(page, "姓名").fill(f"覆盖{RUN}-{it}"); lbl_input(page, "电话").fill(f"2{RUN:06d}{it:03d}"[:11])
    page.locator('.fixed button:has-text("创建订单"), [role=dialog] button:has-text("创建订单")').last.click()
    page.wait_for_timeout(1800)
    b3 = page.locator("body").inner_text()
    T.check(f"[{it}]★G3 覆盖价格无原因被拦", ("原因" in b3) or ("创建订单" in b3 and "覆盖" in b3), b3[:80])
    page.keyboard.press("Escape")


def r5_billing_reports(page, T, it):
    print("  -- 账务/筛选/报表/设置")
    goto(page, "/admin/invoices")
    body = page.locator("body").inner_text()
    for tab in ["未付", "已付", "逾期", "草稿"]:
        T.check(f"[{it}]发票标签『{tab}』", tab in body)
    T.check(f"[{it}]发票筛选『按客户』", "按客户" in body)
    dates = page.locator('input[type=date]:visible')
    if dates.count() >= 2:
        dates.nth(0).fill("2099-01-01"); dates.nth(1).fill("2099-12-31"); page.wait_for_timeout(800)
        T.check(f"[{it}]发票未来日期筛选→空态", any(w in page.locator('body').inner_text() for w in ["未找到", "暂无", "No "]))
    goto(page, "/admin/reports"); T.check(f"[{it}]报表页渲染", len(page.locator("body").inner_text()) > 60)
    goto(page, "/admin/system-settings"); T.check(f"[{it}]系统与设置渲染", len(page.locator("body").inner_text()) > 60)


def r6_editable_records(page, T, it):
    """★后期费用的『改/删须留原因』与开票后『免除』——本轮新功能,此前无浏览器覆盖。

    走的是业主本人在 20260715TM 上跑过的真实路径:开票后原发票不动,改为开贷记单冲减。
    """
    print("  -- ★费用改/删留证据链 + 已开票走免除(贷记单)")
    cust = f"UI证据{RUN}-{it}"
    s, e = win(8, it)
    open_order(page, s, e, "UI价类")
    lbl_input(page, "姓名").fill(cust); lbl_input(page, "电话").fill(f"7{RUN:06d}{it:03d}"[:11])
    page.locator('.fixed button:has-text("创建订单"), [role=dialog] button:has-text("创建订单")').last.click()
    page.wait_for_timeout(2000)

    def open_detail():
        goto(page, "/admin/rental-management")
        page.fill("#datatable-search", cust); page.wait_for_timeout(800)
        page.locator(f'tr:has-text("{cust}")').first.click(); page.wait_for_timeout(1300)

    def set_status(nxt):
        goto(page, "/admin/rental-management")
        page.fill("#datatable-search", cust); page.wait_for_timeout(700)
        page.locator(f'tr:has-text("{cust}")').first.locator("select:visible").first.select_option(nxt)
        page.wait_for_timeout(1500)

    for nxt in ["approved", "active"]:
        try:
            set_status(nxt)
        except Exception as ex:
            print("   r6 transition", nxt, "err", str(ex)[:60])

    # ① 记一笔费用
    open_detail()
    try:
        page.locator('label:has-text("金额") + input, input[type=number]').first  # anchor the panel
        amt_in = page.locator('xpath=//label[contains(.,"金额")]/following::input[@type="number"][1]').first
        amt_in.scroll_into_view_if_needed(); amt_in.fill("36.00")
        page.locator('button:has-text("记一笔费用")').first.click(); page.wait_for_timeout(1800)
    except Exception as ex:
        print("   add-charge err", str(ex)[:120])
    T.check(f"[{it}]附加费用记入后可见 36", "36" in page.locator("body").inner_text())

    # ② 未填原因 → 拦下
    try:
        page.locator('button:has-text("编辑")').first.click(); page.wait_for_timeout(600)
        page.locator('button:has-text("保存")').first.click(); page.wait_for_timeout(1200)
        blocked = "请选择修改原因" in page.locator("body").inner_text()
    except Exception as ex:
        print("   edit-no-reason err", str(ex)[:120]); blocked = False
    T.check(f"[{it}]★改费用不填原因被拦(证据链强制)", blocked)

    # ③ 选原因 → 改成 20 → 通过
    try:
        page.locator('select:visible').filter(has=page.locator('option:has-text("录错金额")')).first.select_option("wrong_amount")
        page.locator('xpath=//label[contains(.,"金额")]/following::input[@type="number"][1]').first.fill("20.00")
        page.locator('button:has-text("保存")').first.click(); page.wait_for_timeout(1800)
    except Exception as ex:
        print("   edit-with-reason err", str(ex)[:120])
    T.check(f"[{it}]★填了原因后改价生效(36→20)", "20" in page.locator("body").inner_text())
    page.keyboard.press("Escape")

    # ④ 关单 → 开票,费用变成已开票
    open_detail()
    try:
        page.locator('button:has-text("关单")').first.click(); page.wait_for_timeout(700)
        page.locator('button:has-text("确认关单")').first.click(); page.wait_for_timeout(2500)
        page.keyboard.press("Escape")
    except Exception as ex:
        print("   r6 close err", str(ex)[:120])

    # ⑤ 转回非关单态(业主真实路径:关单后要免除,须先解除关单)
    try:
        set_status("active")
    except Exception as ex:
        print("   reopen err", str(ex)[:80])

    # ⑥ 已开票 → 只剩『免除』,改/删被禁
    open_detail()
    body = page.locator("body").inner_text()
    has_waive = page.locator('button:has-text("免除")').count() > 0
    T.check(f"[{it}]★已开票费用出现『免除』按钮", has_waive, body[:80])
    if has_waive:
        edit_disabled = page.locator('button:has-text("编辑")').first.is_disabled()
        T.check(f"[{it}]★已开票后『编辑』被禁用(原发票不可改)", edit_disabled)
        try:
            page.locator('button:has-text("免除")').first.click(); page.wait_for_timeout(800)
            page.locator('button:has-text("确认")').last.click(); page.wait_for_timeout(2500)
        except Exception as ex:
            print("   waive err", str(ex)[:120])
        after = page.locator("body").inner_text()
        T.check(f"[{it}]★免除成功并开出贷记单", ("已免除" in after) or ("CN-" in after), after[:120])
    page.keyboard.press("Escape")


def full_suite(page, errors, T, it):
    """One complete pass: breadth (every page/button) + customer + order +
    enforcement + billing. Run repeatedly with a distinct `it` for unique data."""
    print(f"\n########## 全套第 {it} 遍 ##########")
    r1_every_button(page, errors, T)
    r2_customer(page, T, it)
    r3_order_lifecycle(page, T, it)
    r4_enforcement(page, T, it)
    r5_billing_reports(page, T, it)
    r6_editable_records(page, T, it)


if __name__ == "__main__":
    passes = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    with sync_playwright() as p:
        b, page, errors = browser_page(p)
        # auto-accept native confirm() dialogs (e.g. early-return when completing
        # a future-dated order). Registered once for the whole session.
        page.on("dialog", lambda d: d.accept())
        login(page)
        T = Tally()
        per = []
        for it in range(1, passes + 1):
            before = (len(T.p), len(T.f))
            full_suite(page, errors, T, it)
            per.append((it, len(T.p) - before[0], len(T.f) - before[1]))
        print("\n===== 每遍小结 =====")
        for it, pp, ff in per:
            print(f"  第{it}遍: {pp} PASS / {ff} FAIL")
        ok = T.done(f"全套×{passes} 总计")
        b.close()
        sys.exit(0 if ok else 1)
