"""SOP real-BROWSER UI campaign — 12 rounds, zero override, real clicks/typing.

Drives the live React UI (Vite dev) at SOP_UI_BASE against the isolated test DB.
Every round performs real navigation/typing/clicking and asserts on-screen state.
Equipment master-data is a fixture (1 priced model + 2 units, brand UIB).
"""
import os
import re
import sys
from uikit import sync_playwright, browser_page, login, goto, shot, Tally

# Unique date window per run so re-runs don't collide on unit availability.
_D = 5 + (os.getpid() % 20)
ORD_START, ORD_END = f"2026-08-{_D:02d}", f"2026-08-{_D + 2:02d}"

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


def lbl_input(page, label):
    return page.locator(f'xpath=//label[contains(normalize-space(.),"{label}")]/following::input[1]').first


def open_order_modal(page, start, end, pick_model=True):
    goto(page, "/admin/rental-management")
    page.locator('button:has-text("创建订单")').first.click()
    page.wait_for_timeout(700)
    d = page.locator('input[type=date]')
    d.nth(0).fill(start); d.nth(1).fill(end)
    page.wait_for_timeout(1000)
    if pick_model:
        for s in page.locator('select:visible').all():
            labels = [o.inner_text() for o in s.locator('option').all()]
            if any('UI挖机' in (x or '') for x in labels):
                s.select_option(label=[x for x in labels if 'UI挖机' in x][0]); break
        page.wait_for_timeout(1600)


def cur_amounts(page):
    body = page.locator('body').inner_text()
    return re.findall(r'CA\$([0-9,]+\.[0-9]{2})', body), body


# ── ROUNDS ───────────────────────────────────────────────────────────────────
def r1_smoke(page, errors, T):
    print("\n=== UI R1: 全菜单真实导航(渲染+0错误)===")
    for label, path in PAGES:
        errors.clear(); goto(page, path)
        body = page.locator("body").inner_text()
        T.check(f"{label} 渲染且无JS报错",
                ("正在验证身份" not in body) and len(body.strip()) > 40
                and len([e for e in errors if "favicon" not in e.lower()]) == 0)


def r2_order_price(page, T):
    print("\n=== UI R2: 新建订单真实输入 → 屏幕报价正确(押金单列/总额不含押金)===")
    open_order_modal(page, ORD_START, ORD_END)
    amts, body = cur_amounts(page)
    T.check("可用台数显示『2 台中 2 台可用』", "2 台中 2 台可用" in body)
    T.check("无未翻译占位符 {{ }}", "{{" not in body, [w for w in body.split() if "{{" in w][:3])
    T.check("自动总计=CA$727.72(租560+保84+税83.72)", "727.72" in amts, amts[:6])
    dep = lbl_input(page, "押金").input_value()
    T.check("★押金单列且=1100", dep.replace(",", "").startswith("1100"), f"dep={dep}")
    T.check("★押金未并入总额(总额≠1827.72)", "1827.72" not in amts, amts[:6])


def r3_order_submit(page, T):
    print("\n=== UI R3: 提交订单 → 列表出现且金额非$0/非含押金 ===")
    lbl_input(page, "姓名").fill("UI主流程客户")
    lbl_input(page, "电话").fill("4165550301")
    page.locator('.fixed button:has-text("创建订单"), [role=dialog] button:has-text("创建订单")').last.click()
    page.wait_for_timeout(2000)
    goto(page, "/admin/rental-management")
    body = page.locator("body").inner_text()
    T.check("订单列表含新客户", "UI主流程客户" in body)
    T.check("列表金额含 727.72(非$0/非含押金)", "727.72" in body, body[:60])


def r4_customer(page, T):
    print("\n=== UI R4: 客户真实录入 + 检索 ===")
    goto(page, "/admin/customers")
    page.locator('button:has-text("添加客户")').first.click(); page.wait_for_timeout(700)
    page.fill("#cust-name", "UI测试客户甲")
    page.fill("#cust-phone", "4165550402")
    page.fill("#cust-email", "uikehu@example.com")
    page.get_by_role("button", name="创建", exact=True).click()
    page.wait_for_timeout(1500)
    goto(page, "/admin/customers")
    page.fill("#datatable-search", "UI测试客户甲")
    page.wait_for_timeout(800)
    T.check("新客户出现在列表/检索", "UI测试客户甲" in page.locator("body").inner_text())


def r5_invoice_page(page, T):
    print("\n=== UI R5: 发票页 标签/汇总卡/筛选(验证此前修复)===")
    goto(page, "/admin/invoices")
    body = page.locator("body").inner_text()
    for tab in ["全部", "草稿", "已发送", "未付", "部分付款", "已付", "逾期"]:
        T.check(f"发票标签『{tab}』存在", tab in body)
    T.check("汇总卡『需收款提醒』存在", "需收款提醒" in body or "需收款" in body)
    T.check("筛选『按客户筛选』存在", "按客户" in body)
    T.check("筛选『日期类型』存在", "日期类型" in body)


def r6_invoice_overflow(page, T):
    print("\n=== UI R6: 发票汇总卡片不溢出(金额在卡片内)===")
    goto(page, "/admin/invoices")
    page.wait_for_timeout(500)
    # find the outstanding amount element; assert it doesn't overflow its card
    over = page.evaluate("""() => {
      const els = [...document.querySelectorAll('div')].filter(d => /CA\\$/.test(d.textContent||'') && d.children.length===0);
      let bad = 0;
      for (const e of els) { if (e.scrollWidth > e.clientWidth + 2) bad++; }
      return bad;
    }""")
    T.check("无金额文字溢出容器", over == 0, f"overflowing={over}")


def r7_invoice_filter(page, T):
    print("\n=== UI R7: 发票 按客户/按日期 筛选真实操作 ===")
    goto(page, "/admin/invoices")
    page.wait_for_timeout(500)
    # date inputs in the filter bar
    dates = page.locator('input[type=date]:visible')
    T.check("筛选含日期输入框", dates.count() >= 2, f"count={dates.count()}")
    if dates.count() >= 2:
        dates.nth(0).fill("2099-01-01"); dates.nth(1).fill("2099-12-31")
        page.wait_for_timeout(900)
        body = page.locator("body").inner_text()
        T.check("未来日期筛选→无数据(空态)", ("未找到" in body or "暂无" in body or "No invoices" in body or "No " in body), body[-80:])


def r8_fleet_availability(page, T):
    print("\n=== UI R8: 租赁设备页 渲染 + 设备目录页 ===")
    goto(page, "/admin/rental-fleet")
    body = page.locator("body").inner_text()
    T.check("租赁设备列出夹具设备(UI-2T挖机/UIB)", ("UI-2T挖机" in body or "UIB" in body))
    goto(page, "/admin/category-pricing")
    ok = False
    for _ in range(5):
        if "UI挖机" in page.locator("body").inner_text():
            ok = True; break
        page.wait_for_timeout(800)
    if not ok:
        shot(page, "r8_pricing_fail")
    T.check("分类定价显示已建分类 UI挖机", ok)


def r9_language(page, T):
    print("\n=== UI R9: 切换英文 → 页面英文渲染 ===")
    goto(page, "/admin/invoices")
    page.wait_for_timeout(600)
    shot(page, "r9_before_en")
    try:
        page.locator('button:has-text("EN")').first.click()
        page.wait_for_timeout(1500)  # in-memory i18n switch — do NOT reload
    except Exception:
        pass
    shot(page, "r9_after_en")
    body = page.locator("body").inner_text()
    T.check("切EN后出现英文标签(Draft/Paid/Overdue)", any(w in body for w in ["Draft", "Paid", "Overdue", "Unpaid"]), body[:60])
    # switch back
    try:
        page.locator('button:has-text("中"), button:has-text("ZH"), button:has-text("EN")').first.click()
    except Exception:
        pass


def r10_dashboard(page, T):
    print("\n=== UI R10: 工作台/报表 带数据渲染 ===")
    goto(page, "/admin")
    body = page.locator("body").inner_text()
    T.check("工作台渲染统计卡", any(w in body for w in ["租赁", "设备", "客户", "订单"]))
    goto(page, "/admin/reports")
    T.check("报表页渲染无报错", len(page.locator("body").inner_text().strip()) > 40)


def r11_order_dates_guard(page, T):
    print("\n=== UI R11: 订单日期前置 — 未选日期时设备区提示 ===")
    goto(page, "/admin/rental-management")
    page.locator('button:has-text("创建订单")').first.click(); page.wait_for_timeout(700)
    body = page.locator("body").inner_text()
    T.check("未选日期提示先选租期", "请先选择" in body or "请先选有效" in body)
    page.keyboard.press("Escape")


def r12_renav(page, errors, T):
    print("\n=== UI R12: 回归 — 关键页二次导航稳定 ===")
    for label, path in [("租赁管理", "/admin/rental-management"), ("发票", "/admin/invoices"),
                        ("客户", "/admin/customers"), ("租赁设备", "/admin/rental-fleet")]:
        errors.clear(); goto(page, path)
        T.check(f"{label} 二次导航稳定无报错", len([e for e in errors if "favicon" not in e.lower()]) == 0)


if __name__ == "__main__":
    with sync_playwright() as p:
        b, page, errors = browser_page(p)
        login(page)
        T = Tally()
        r1_smoke(page, errors, T)
        r2_order_price(page, T)
        r3_order_submit(page, T)
        r4_customer(page, T)
        r5_invoice_page(page, T)
        r6_invoice_overflow(page, T)
        r7_invoice_filter(page, T)
        r8_fleet_availability(page, T)
        r9_language(page, T)
        r10_dashboard(page, T)
        r11_order_dates_guard(page, T)
        r12_renav(page, errors, T)
        ok = T.done("UI CAMPAIGN TOTAL")
        b.close()
        sys.exit(0 if ok else 1)
