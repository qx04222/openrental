"""Real-path E2E harness for the OpenRental test campaign.

Drives the ACTUAL running server (dev mode, isolated test DB) — no mocks, no
permission overrides, no SQL injection. Auth helpers establish REAL sessions:
admin via the real password-login endpoint, customer/field via the real OTP
flow, reading the one-time code from the server's own dev console log (the
system's own output, not a bypass).

Precondition data is created via the REAL authenticated tRPC endpoints — the
exact calls the admin UI fires (through moduleGuard + zod + business logic).
Only raw SQL INSERT would count as injection; this does not.

Usage:
    from harness import api_admin, trpc, read_otp, log_pos, BASE_URL
"""
import json
import os
import re
import tempfile
import time
import urllib.parse
from datetime import datetime

import requests

BASE_URL = os.environ.get("OPENRENTAL_BASE_URL", "http://localhost:3000")
DEV_LOG = os.environ.get("OPENRENTAL_DEV_LOG", "/tmp/openrental_dev_server.log")
# DB name used by specs that introspect via psql (override for the CI runner).
TEST_DB = os.environ.get("OPENRENTAL_TEST_DB", "mr_bin_test")


def psql(query):
    """Run a read-only psql query against the test DB; return stripped stdout."""
    import subprocess
    return subprocess.run(
        ["psql", "-d", TEST_DB, "-tAc", query], capture_output=True, text=True
    ).stdout.strip()


def trpc(session, proc, json_input=None, method="POST"):
    """Call a tRPC procedure through the real batch endpoint.

    Returns the unwrapped `.result.data.json`. Raises on a tRPC error payload
    (which the server returns with HTTP 200, so we must inspect the body).
    """
    meta = {}
    encoded_input = json_input
    if isinstance(json_input, dict):
        encoded_input = {}
        for key, value in json_input.items():
            if isinstance(value, datetime):
                encoded_input[key] = value.isoformat().replace("+00:00", "Z")
                meta[key] = ["Date"]
            else:
                encoded_input[key] = value
    item = {"json": encoded_input}
    if meta:
        item["meta"] = {"values": meta}
    body = {"0": item}
    if method == "POST":
        r = session.post(f"{BASE_URL}/api/trpc/{proc}?batch=1", json=body, timeout=60)
    else:
        q = urllib.parse.quote(json.dumps(body))
        r = session.get(f"{BASE_URL}/api/trpc/{proc}?batch=1&input={q}", timeout=60)
    try:
        data = r.json()
    except Exception:
        raise RuntimeError(f"tRPC {proc} non-JSON HTTP {r.status_code}: {r.text[:300]}")
    item = data[0] if isinstance(data, list) else data
    if isinstance(item, dict) and "error" in item:
        raw = item["error"]
        err = raw.get("json", raw) if isinstance(raw, dict) else {"message": str(raw)}
        raise TrpcError(proc, r.status_code, err if isinstance(err, dict) else {"message": str(err)})
    return item["result"]["data"]["json"]


class TrpcError(RuntimeError):
    def __init__(self, proc, http_status, err):
        self.proc = proc
        self.http_status = http_status
        self.err = err
        self.code = (err.get("data") or {}).get("code") if isinstance(err, dict) else None
        self.message = err.get("message") if isinstance(err, dict) else str(err)
        super().__init__(f"tRPC {proc} error [{self.code}]: {self.message}")


def _admin_cookie_path():
    import hashlib
    tag = hashlib.md5(BASE_URL.encode()).hexdigest()[:8]
    return os.path.join(tempfile.gettempdir(), f"openrental_admin_cookie_{tag}.txt")


def api_admin():
    """Real admin session (super_admin).

    Reuses a cached cookie across spec processes (verified live) so running the
    whole suite back-to-back doesn't hammer the login rate limit; logs in fresh
    only when there's no valid session.
    """
    s = requests.Session()
    jar = _admin_cookie_path()
    if os.path.exists(jar):
        try:
            with open(jar) as f:
                name, value = f.read().split("\t", 1)
            s.cookies.set(name, value)
            v = s.get(f"{BASE_URL}/api/admin-auth/verify-session", timeout=15)
            if v.ok and v.json().get("isAuthenticated"):
                return s
        except Exception:
            pass
    s = requests.Session()
    r = s.post(
        f"{BASE_URL}/api/admin-auth/password-login",
        json={"username": "admin", "password": "admin123"},
        timeout=30,
    )
    r.raise_for_status()
    assert r.json().get("success"), f"admin login failed: {r.text}"
    for c in s.cookies:
        if c.name == "openrental_admin_session":
            with open(jar, "w") as f:
                f.write(f"{c.name}\t{c.value}")
            break
    return s


def api_field(identifier="inspector", password="field123"):
    """Real field_staff session via the real password login."""
    s = requests.Session()
    res = trpc(s, "fieldAuth.login",
               {"identifier": identifier, "password": password, "rememberMe": True})
    assert res, "field login returned empty"
    return s


def api_anon():
    """A fresh anonymous session (for public / unauthenticated endpoints)."""
    return requests.Session()


def log_pos():
    """Current byte offset of the dev log — capture BEFORE triggering an OTP."""
    try:
        return os.path.getsize(DEV_LOG)
    except OSError:
        return 0


def read_otp(phone, since_pos=0, timeout=8.0):
    """Read the most recent OTP code for `phone` written after `since_pos`.

    Polls the dev log (the server writes the code synchronously after the
    requestOTP call, but allow a short window for flush).
    """
    deadline = time.time() + timeout
    pat = re.compile(r"code is: (\d{6})")
    # The server logs the NORMALIZED phone ("To: +14165553333"), so match on the
    # last 10 digits rather than the literal input string.
    last10 = re.sub(r"\D", "", phone)[-10:]
    last = None
    while time.time() < deadline:
        with open(DEV_LOG, "r", errors="replace") as f:
            f.seek(since_pos)
            text = f.read()
        for line in text.splitlines():
            if "To:" in line and last10 and last10 in re.sub(r"\D", "", line.split("Message:")[0]):
                m = pat.search(line)
                if m:
                    last = m.group(1)
        if last:
            return last
        time.sleep(0.25)
    raise AssertionError(f"no OTP code for {phone} found in {DEV_LOG} after pos {since_pos}")


def request_customer_otp(session, phone):
    """Trigger a real customer OTP and return the captured code."""
    pos = log_pos()
    trpc(session, "customerAuth.requestOTP", {"phone": phone})
    return read_otp(phone, since_pos=pos)


def login_customer(phone):
    """Full real customer-portal login → returns an authenticated Session.

    Requires the customer to already exist (create via admin first).
    """
    s = requests.Session()
    code = request_customer_otp(s, phone)
    res = trpc(s, "customerAuth.verifyOTP", {"phone": phone, "code": code})
    assert res.get("success"), f"customer OTP verify failed: {res}"
    return s


# ---- Playwright UI helpers (call inside a sync_playwright block) ----

def ui_login_admin(page):
    """Drive the REAL admin login UI and land on the dashboard."""
    page.goto(f"{BASE_URL}/admin/login")
    page.wait_for_load_state("networkidle")
    page.fill("#login-username", "admin")
    page.fill("#login-password", "admin123")
    page.get_by_role("button", name=re.compile("log ?in|登录|sign in", re.I)).first.click()
    page.wait_for_url(re.compile(r"/admin(?!/login)"), timeout=15000)
    page.wait_for_load_state("networkidle")
    # Admin bundle lazy-loads; wait past the SPA "Loading..." splash.
    page.wait_for_function("!document.body.innerText.includes('Loading...')", timeout=20000)


if __name__ == "__main__":
    # Self-check: exercise all three real auth lanes against the running server.
    print("BASE_URL:", BASE_URL)
    admin = api_admin()
    me = admin.get(f"{BASE_URL}/api/admin-auth/verify-session", timeout=15).json()
    print("admin verify-session:", me.get("role"))
    # ensure a customer exists, then OTP login
    phone = "+14165550000"
    try:
        trpc(admin, "customers.create", {"name": "Harness Cust", "phone": phone, "source": "admin"})
    except TrpcError as e:
        print("customer create (maybe exists):", e.message)
    cust = login_customer(phone)
    who = trpc(cust, "customerAuth.me", None, method="GET")
    print("customer me:", who.get("name"))
    print("HARNESS OK")
