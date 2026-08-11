"""Shared helpers for the real-browser SOP UI campaign (Playwright)."""
import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("SOP_UI_BASE", "http://localhost:3100")
SHOT = "/tmp/sopui"


def browser_page(p, lang="zh"):
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1440, "height": 1000},
                        locale="zh-CN", extra_http_headers={"Accept-Language": "zh-CN"})
    page = ctx.new_page()
    page.set_default_timeout(20000)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
    return b, page, errors


def login(page, user="admin", pw="admin123"):
    page.goto(f"{BASE}/admin/login")
    page.wait_for_load_state("networkidle")
    page.fill("#login-username", user)
    page.fill("#login-password", pw)
    page.click("button[type=submit]")
    # land on dashboard (URL leaves /login)
    page.wait_for_url(lambda u: "/admin/login" not in u, timeout=20000)
    # the dashboard async-verifies the session before rendering — wait it out
    try:
        page.wait_for_selector("text=正在验证身份", state="detached", timeout=15000)
    except Exception:
        pass
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(700)


def goto(page, path):
    page.goto(f"{BASE}{path}")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(400)


def shot(page, name):
    page.screenshot(path=f"{SHOT}/{name}.png", full_page=True)


class Tally:
    def __init__(self):
        self.p, self.f = [], []

    def check(self, name, cond, detail=""):
        (self.p if cond else self.f).append(name)
        print(f"  {'PASS' if cond else 'FAIL'}: {name}" + (f"  [{detail}]" if (detail and not cond) else ""))

    def done(self, label=""):
        print(f"=== {label} {len(self.p)} PASS / {len(self.f)} FAIL ===")
        return len(self.f) == 0
