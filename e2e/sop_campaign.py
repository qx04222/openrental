"""SOP ERP flow — human-level E2E, 3 rounds, ZERO override.

Walks the documented SOP end to end against the REAL running server + isolated
test DB, through the REAL authenticated tRPC endpoints (the same calls the UI
fires). NO price override, NO skipInspectionCheck, NO permission bypass, NO raw
SQL writes. Reads use psql (read-only) only for assertions.

Run via e2e/run-sop.sh (sets OPENRENTAL_BASE_URL / OPENRENTAL_DEV_LOG / OPENRENTAL_TEST_DB).
"""
import os
import sys
from harness import api_admin, api_anon, trpc, psql, TrpcError

RUN = os.getpid() % 100000  # unique-ish suffix so re-runs don't collide on names

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}: {name}" + (f"  [{detail}]" if detail and not cond else ""))


def approx(a, b, tol=0.02):
    return abs(float(a) - float(b)) <= tol


# ─────────────────────────────────────────────────────────────────────────────
def build_priced_asset(admin, tag):
    """SOP 1: 设备目录建型号 → 分类定价(型号费率) → 录设备(挂型号,自身不另设价)."""
    cat = trpc(admin, "equipmentCategories.create", {"name": f"{tag}-Cat"})
    # 型号带费率(= 分类级费率;设备本身不另设价,报价应回退到型号/分类费率)
    model = trpc(admin, "equipmentModels.create", {
        "category": f"{tag}-Cat", "brand": tag, "model": f"{tag}-Excavator",
        "dailyRate": "280.00", "weeklyRate": "1400.00", "monthlyRate": "5000.00",
        "equipmentType": "machine",
    })
    fleet = trpc(admin, "rentalFleet.create", {
        "brand": tag, "model": f"{tag}-Excavator", "category": f"{tag}-Cat",
        "serialNumber": f"{tag}-SN-001", "currentStatus": "available",
    })
    return cat, model, fleet["id"]


def quote_two_days(actor, fleet_id, start, end, insurance="basic"):
    return trpc(actor, "rentals.previewMultiItemQuote", {
        "startDate": start, "endDate": end, "deliveryMethod": "pickup",
        "taxProvince": "ON", "insuranceType": insurance,
        "items": [{"equipmentModelId": None, "fleetIds": [fleet_id],
                   "itemType": "machine", "quantity": 1}],
    }, method="GET")


def make_order_from_quote(admin, fleet_id, q, cust, start, end):
    """SOP 2.1: 租赁管理→新建订单,把报价原样下单(不override/不priceMatch)."""
    return trpc(admin, "rentals.adminCreate", {
        "customerName": cust["name"], "customerEmail": cust["email"],
        "customerPhone": cust["phone"],
        "rentalFleetId": fleet_id, "startDate": start, "endDate": end,
        "deliveryMethod": "pickup", "insuranceType": "basic",
        "rentalFee": f'{q["rentalFee"]:.2f}', "freightCost": f'{q["freightCost"]:.2f}',
        "insuranceCost": f'{q["insuranceCost"]:.2f}', "taxAmount": f'{q["taxAmount"]:.2f}',
        "depositAmount": f'{q["depositAmount"]:.2f}', "totalAmount": f'{q["totalAmount"]:.2f}',
    })


def activate(admin, rid):
    """Real status transitions pending → approved → active."""
    trpc(admin, "rentals.updateStatus", {"id": rid, "status": "approved"})
    trpc(admin, "rentals.updateStatus", {"id": rid, "status": "active"})


def return_inspection(admin, rid, fleet_id):
    """SOP 2.4: 真实归还验收(管理员发令牌→外部验收提交),置 returnInspectionCompleted."""
    tok = trpc(admin, "inspections.createToken",
               {"rentalId": rid, "rentalFleetId": fleet_id, "inspectionType": "return"})
    trpc(api_anon(), "inspections.createWithToken", {
        "token": tok["token"], "type": "return", "rentalId": rid, "rentalFleetId": fleet_id,
        "overallCondition": "good", "fuelLevelPercent": 100, "inspectorName": "SOP Inspector",
        "damageSeverity": "none",
    })


def invoice_for(admin, rid):
    rows = trpc(admin, "invoices.list", {"rentalId": rid}, method="GET")
    rentals = [r for r in rows if r["invoices"].get("type") == "rental"]
    return rentals[0]["invoices"] if rentals else (rows[0]["invoices"] if rows else None)


# ═════════════════════════════════════════════════════════════════════════════
def round1():
    print("\n=== ROUND 1: 主流程 (建资料→建单→验收→关单→发票→收款→同步) ===")
    admin = api_admin()
    start, end = "2026-08-01", "2026-08-03"  # 2 天
    cat, model, fleet_id = build_priced_asset(admin, f"SOP1R{RUN}")

    q = quote_two_days(admin, fleet_id, start, end)
    # ★ 红线:报价用分类/型号费率;押金单列、不进总额
    check("报价租金=2天×$280=560", approx(q["rentalFee"], 560), f'rentalFee={q["rentalFee"]}')
    check("保险=15%×560=84", approx(q["insuranceCost"], 84), f'ins={q["insuranceCost"]}')
    check("税=13%×(560+84)=83.72", approx(q["taxAmount"], 83.72), f'tax={q["taxAmount"]}')
    check("★押金>0且=1.5×税后向上取整50=1100", approx(q["depositAmount"], 1100), f'dep={q["depositAmount"]}')
    check("★总额=租+运+保+税(不含押金)", approx(q["totalAmount"], 560 + 0 + 84 + 83.72),
          f'total={q["totalAmount"]}')
    check("★总额≠(租+运+保+税+押金)即押金确未计入", not approx(q["totalAmount"], 560 + 84 + 83.72 + q["depositAmount"]),
          f'total={q["totalAmount"]} dep={q["depositAmount"]}')

    cust = {"name": f"SOP1 客户 {RUN}", "email": f"sop1r{RUN}@example.com", "phone": f"41655{RUN:05d}"[:11]}
    order = make_order_from_quote(admin, fleet_id, q, cust, start, end)
    rid = order["id"]
    db_total = psql(f"select \"totalAmount\" from rental_requests where id={rid}")
    check("订单入库总额=报价总额(不含押金)", approx(db_total, q["totalAmount"]), f'db={db_total}')

    activate(admin, rid)
    # ★ 不验收不能关单 — 先证明会被拦
    try:
        trpc(admin, "rentals.closeRental", {"id": rid})
        check("★未验收关单应被拦", False, "closeRental succeeded without inspection")
    except TrpcError as e:
        check("★未验收关单被拦(PRECONDITION_FAILED)", e.code == "PRECONDITION_FAILED", e.code)

    return_inspection(admin, rid, fleet_id)
    ri = psql(f"select \"returnInspectionCompleted\" from rental_requests where id={rid}")
    check("归还验收后标记完成", ri == "t", f'flag={ri}')

    trpc(admin, "rentals.closeRental", {"id": rid})  # 无 skipInspectionCheck
    st = psql(f"select status from rental_requests where id={rid}")
    check("关单后订单=已完成", st == "completed", f'status={st}')
    rel = psql(f"select \"currentStatus\" from rental_fleet where id={fleet_id}")
    check("关单后设备释放回可用", rel == "available", f'fleet={rel}')

    inv = invoice_for(admin, rid)
    check("关单自动生成发票", inv is not None)
    if inv:
        check("★发票总额=订单总额(无押金/无逾期费)", approx(inv["totalAmount"], q["totalAmount"]),
              f'inv={inv["totalAmount"]}')
        lf = psql(f"select count(*) from invoice_line_items where \"invoiceId\"={inv['id']} and \"lineType\"='late_fee'")
        check("发票无逾期费明细", lf == "0", f'late_fee_lines={lf}')

    # SOP 3.2 在订单上记全额收款 → 发票自动同步
    trpc(admin, "rentalPrepayments.create", {
        "rentalRequestId": rid, "amount": f'{q["totalAmount"]:.2f}',
        "paymentMethod": "cash", "paymentDate": "2026-08-03"})
    inv2 = invoice_for(admin, rid)
    check("★收款后发票自动=已付", inv2 and inv2["status"] == "paid", f'status={inv2 and inv2["status"]}')
    check("★发票余额=0", inv2 and approx(inv2["balanceDue"], 0), f'bal={inv2 and inv2["balanceDue"]}')
    pm = trpc(admin, "rentals.paymentStatusMap", None, method="GET")
    mine = next((p for p in pm if p["id"] == rid), None)
    check("订单收款状态=已收齐(与发票一致)", mine and approx(mine["prepaid"], mine["total"]) and mine["total"] > 0,
          f'{mine}')
    print(f"  (round1 rid={rid} fleet={fleet_id})")


def run_overdue_cron():
    """Run the REAL overdue cron job against the test DB (not a bypass — the
    actual scheduled job, invoked out-of-band because there's no HTTP trigger)."""
    import subprocess, getpass
    db = os.environ.get("OPENRENTAL_TEST_DB", "mr_bin_sop")
    url = f"postgresql://{getpass.getuser()}@localhost:5432/{db}"
    code = ("import('./server/jobs/overdueCron.ts').then(m=>m.runOverdueCron())"
            ".then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})")
    subprocess.run(["npx", "tsx", "-e", code], cwd="..",
                   env={**os.environ, "DATABASE_URL": url, "NODE_ENV": "development"},
                   check=True, capture_output=True, timeout=120)


# ═════════════════════════════════════════════════════════════════════════════
def round2():
    print("\n=== ROUND 2: 边界/隔离 (可用台数/信用单/逾期判定/未付·提醒) ===")
    admin = api_admin()
    tag = f"SOP2R{RUN}"
    start, end = "2026-09-01", "2026-09-03"
    # 挂账(信用单)是受开关控制的功能 — 开启它是合法的管理员配置,不是override。
    trpc(admin, "featureFlags.setEnabled", {"key": "credit_orders", "enabled": True})

    # R2-A 维护设备不算可用 + 三处一致
    trpc(admin, "equipmentCategories.create", {"name": f"{tag}-Cat"})
    model = trpc(admin, "equipmentModels.create", {
        "category": f"{tag}-Cat", "brand": tag, "model": f"{tag}-Exc",
        "dailyRate": "200.00", "equipmentType": "machine"})
    mid = model["id"]
    u1 = trpc(admin, "rentalFleet.create", {"brand": tag, "model": f"{tag}-Exc", "category": f"{tag}-Cat", "serialNumber": f"{tag}-A", "currentStatus": "available"})["id"]
    u2 = trpc(admin, "rentalFleet.create", {"brand": tag, "model": f"{tag}-Exc", "category": f"{tag}-Cat", "serialNumber": f"{tag}-B", "currentStatus": "available"})["id"]
    trpc(admin, "rentalFleet.update", {"id": u2, "currentStatus": "maintenance"})  # 一台维护
    ma = trpc(admin, "rentals.modelAvailability", {"equipmentModelId": mid, "startDate": start, "endDate": end}, method="GET")
    fa = trpc(admin, "rentalFleet.listWithAvailability", {"startDate": start, "endDate": end}, method="GET")
    mine = [f for f in fa if f.get("equipmentModelId") == mid]
    avail_unit = sum(1 for f in mine if f["availabilityStatus"] == "available")
    check("型号可用台数排除维护(2台中1可用)", ma["available"] == 1 and ma["total"] == 2, f'ma={ma}')
    check("★逐台与型号汇总一致", ma["available"] == avail_unit, f'ma={ma["available"]} units={avail_unit}')

    # R2-B 信用(挂账)单不设结束日(哨兵)
    credit = trpc(admin, "rentals.adminCreate", {
        "customerName": f"{tag} 挂账", "customerPhone": f"4166{RUN:05d}"[:11],
        "rentalFleetId": u1, "startDate": start, "isCreditOrder": True,
        "deliveryMethod": "pickup", "insuranceType": "basic"})
    cyear = psql(f"select extract(year from \"endDate\") from rental_requests where id={credit['id']}")
    check("★信用单结束日=2099哨兵(永不逾期)", cyear == "2099", f'year={cyear}')

    # R2-C 逾期判定:过期未还→逾期;过期但已验收/信用单→不逾期(跑真实cron)
    # 两单都"过期"但占用同一台的不同(不重叠)窗口,避免可用性冲突。
    o_open = trpc(admin, "rentals.adminCreate", {"customerName": f"{tag} 逾期", "customerPhone": f"4167{RUN:05d}"[:11], "rentalFleetId": u1, "startDate": "2026-06-01", "endDate": "2026-06-05", "deliveryMethod": "pickup", "insuranceType": "basic"})["id"]
    activate(admin, o_open)
    o_ret = trpc(admin, "rentals.adminCreate", {"customerName": f"{tag} 已还", "customerPhone": f"4168{RUN:05d}"[:11], "rentalFleetId": u1, "startDate": "2026-06-08", "endDate": "2026-06-12", "deliveryMethod": "pickup", "insuranceType": "basic"})["id"]
    activate(admin, o_ret)
    return_inspection(admin, o_ret, u1)  # 已归还验收但未关单
    run_overdue_cron()
    s_open = psql(f"select status from rental_requests where id={o_open}")
    s_ret = psql(f"select status from rental_requests where id={o_ret}")
    s_credit = psql(f"select status from rental_requests where id={credit['id']}")
    check("★过期未还 → 逾期", s_open == "overdue", f'status={s_open}')
    check("★过期但已验收 → 不逾期(仍进行中)", s_ret == "active", f'status={s_ret}')
    check("★信用单 → 不逾期", s_credit != "overdue", f'status={s_credit}')

    # R2-D 未付标签 + 30天收款提醒(开单很久前、开发票、未付)
    old = trpc(admin, "rentals.adminCreate", {"customerName": f"{tag} 久欠", "customerPhone": f"4169{RUN:05d}"[:11], "rentalFleetId": u1, "startDate": "2026-04-01", "endDate": "2026-04-05", "deliveryMethod": "pickup", "insuranceType": "basic", "rentalFee": "800.00", "freightCost": "0", "insuranceCost": "120.00", "taxAmount": "119.60", "totalAmount": "1039.60"})["id"]
    inv = trpc(admin, "invoices.generateFromRental", {"rentalId": old})
    invid = inv.get("invoiceId") if isinstance(inv, dict) else None
    if invid:
        trpc(admin, "invoices.updateStatus", {"id": invid, "status": "sent"})
    unpaid = trpc(admin, "invoices.list", {"status": "unpaid"}, method="GET")
    check("未付标签含这张已开未付发票", any(r["invoices"]["id"] == invid for r in unpaid), f'invid={invid}')
    summ = trpc(admin, "invoices.summary", None, method="GET")
    check("★顶部需收款提醒计数>0(久欠未付)", summ.get("reminderCount", 0) > 0, f'reminder={summ.get("reminderCount")}')


# ═════════════════════════════════════════════════════════════════════════════
def round3():
    print("\n=== ROUND 3: 回归 (重跑主流程 + 多机单 + 全程无override) ===")
    admin = api_admin()
    tag = f"SOP3R{RUN}"
    start, end = "2026-10-01", "2026-10-08"  # 7 天 → 走周租档
    trpc(admin, "equipmentCategories.create", {"name": f"{tag}-Cat"})
    model = trpc(admin, "equipmentModels.create", {"category": f"{tag}-Cat", "brand": tag, "model": f"{tag}-Exc", "dailyRate": "300.00", "weeklyRate": "1500.00", "equipmentType": "machine"})
    mid = model["id"]
    f1 = trpc(admin, "rentalFleet.create", {"brand": tag, "model": f"{tag}-Exc", "category": f"{tag}-Cat", "serialNumber": f"{tag}-1", "currentStatus": "available"})["id"]
    f2 = trpc(admin, "rentalFleet.create", {"brand": tag, "model": f"{tag}-Exc", "category": f"{tag}-Cat", "serialNumber": f"{tag}-2", "currentStatus": "available"})["id"]

    # 多机单(2台)经服务端报价
    q = trpc(admin, "rentals.previewMultiItemQuote", {
        "startDate": start, "endDate": end, "deliveryMethod": "pickup", "taxProvince": "ON", "insuranceType": "basic",
        "items": [{"equipmentModelId": mid, "fleetIds": [f1, f2], "itemType": "machine", "quantity": 2}]}, method="GET")
    # 7天:周租1500 优于 7×300=2100 → 取较优;2台
    check("多机单按最优档计价(周租优先)且×2台", approx(q["rentalFee"], 1500 * 2), f'rentalFee={q["rentalFee"]}')
    check("★多机单总额仍不含押金", approx(q["totalAmount"], q["rentalFee"] + q["freightCost"] + q["insuranceCost"] + q["taxAmount"]), f'total={q["totalAmount"]} dep={q["depositAmount"]}')

    # 主流程回归(单机)
    cust = {"name": f"{tag} 客户", "email": f"sop3r{RUN}@example.com", "phone": f"4160{RUN:05d}"[:11]}
    q1 = quote_two_days(admin, f1, "2026-10-20", "2026-10-22")
    order = make_order_from_quote(admin, f1, q1, cust, "2026-10-20", "2026-10-22")
    rid = order["id"]
    activate(admin, rid)
    return_inspection(admin, rid, f1)
    trpc(admin, "rentals.closeRental", {"id": rid})
    inv = invoice_for(admin, rid)
    check("回归:关单出发票且总额一致", inv and approx(inv["totalAmount"], q1["totalAmount"]), f'inv={inv and inv["totalAmount"]}')
    trpc(admin, "rentalPrepayments.create", {"rentalRequestId": rid, "amount": f'{q1["totalAmount"]:.2f}', "paymentMethod": "etransfer", "paymentDate": "2026-10-22"})
    inv2 = invoice_for(admin, rid)
    check("回归:收款后发票=已付", inv2 and inv2["status"] == "paid", f'status={inv2 and inv2["status"]}')


if __name__ == "__main__":
    round1()
    round2()
    round3()
    print(f"\n=== RESULT: {len(PASS)} PASS, {len(FAIL)} FAIL ===")
    if FAIL:
        print("FAILURES:", FAIL)
        sys.exit(1)
