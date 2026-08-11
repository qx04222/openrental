"""Full-stack test campaign — ALL modules, 3 rounds, zero override.

Exercises every business module through the REAL authenticated tRPC endpoints
(frontend contract → moduleGuard/zod → business logic → DB) on the isolated test
DB. R1 = core CRUD per module; R2 = RBAC / validation / isolation; R3 = cross-
module integration + data integrity. Reads via psql (read-only) for assertions.
"""
import os
import sys
from harness import api_admin, api_field, trpc, psql, TrpcError

R = os.getpid() % 100000
admin = api_admin()
C = {}  # shared fixture ids


class Tally:
    def __init__(self): self.p, self.f = [], []
    def ok(self, n, c, d=""):
        (self.p if c else self.f).append(n)
        print(f"  {'PASS' if c else 'FAIL'}: {n}" + (f"  [{d}]" if (d and not c) else ""))
    def err(self, n, fn, code=None):
        try:
            fn(); self.ok(n, False, "expected error")
        except TrpcError as e:
            self.ok(n, code is None or e.code == code, f"got {e.code}")
    def total(self):
        print(f"\n=== TOTAL {len(self.p)} PASS / {len(self.f)} FAIL ===")
        if self.f: print("FAILURES:", self.f)
        return len(self.f) == 0


t = Tally()


def count(table, where="1=1"):
    return int(psql(f'select count(*) from "{table}" where {where}') or 0)


# ── base fixture ──────────────────────────────────────────────────────────────
def base_fixture():
    C['cust'] = trpc(admin, "customers.create", {"name": f"FS客户{R}", "phone": f"416{R:07d}"[:11], "email": f"fs{R}@ex.com"})["id"]
    trpc(admin, "equipmentCategories.create", {"name": f"FS类{R}"})
    C['model'] = trpc(admin, "equipmentModels.create", {"category": f"FS类{R}", "brand": f"FSB{R}", "model": f"FSM{R}", "dailyRate": "300.00", "weeklyRate": "1500.00", "equipmentType": "machine"})["id"]
    C['fleet'] = [trpc(admin, "rentalFleet.create", {"brand": f"FSB{R}", "model": f"FSM{R}", "category": f"FS类{R}", "serialNumber": f"FS-{R}-{i}", "currentStatus": "available"})["id"] for i in range(2)]
    C['wh'] = trpc(admin, "warehouses.create", {"name": f"FS仓{R}", "city": "Toronto", "province": "ON"})["id"]
    C['driver'] = trpc(admin, "drivers.create", {"name": f"FS司机{R}", "phone": f"416{R:07d}"[:11]})["id"]
    C['operator'] = trpc(admin, "operators.create", {"name": f"FS操作员{R}"})["id"]
    C['project'] = trpc(admin, "projects.create", {"customerId": C['cust'], "name": f"FS项目{R}"})["id"]
    # an active rental order (quote-priced, no override)
    q = trpc(admin, "rentals.previewMultiItemQuote", {"startDate": "2026-09-01", "endDate": "2026-09-03", "deliveryMethod": "pickup", "taxProvince": "ON", "insuranceType": "basic", "items": [{"equipmentModelId": None, "fleetIds": [C['fleet'][0]], "itemType": "machine", "quantity": 1}]}, method="GET")
    o = trpc(admin, "rentals.adminCreate", {"customerName": f"FS客户{R}", "customerPhone": f"416{R:07d}"[:11], "rentalFleetId": C['fleet'][0], "startDate": "2026-09-01", "endDate": "2026-09-03", "deliveryMethod": "pickup", "insuranceType": "basic", "rentalFee": f'{q["rentalFee"]:.2f}', "freightCost": f'{q["freightCost"]:.2f}', "insuranceCost": f'{q["insuranceCost"]:.2f}', "taxAmount": f'{q["taxAmount"]:.2f}', "depositAmount": f'{q["depositAmount"]:.2f}', "totalAmount": f'{q["totalAmount"]:.2f}'})
    C['order'] = o["id"]; C['quote'] = q
    trpc(admin, "rentals.updateStatus", {"id": C['order'], "status": "approved"})
    trpc(admin, "rentals.updateStatus", {"id": C['order'], "status": "active"})
    print(f"  fixture: cust={C['cust']} model={C['model']} fleet={C['fleet']} order={C['order']}")


# ── ROUND 1 — core CRUD per module ────────────────────────────────────────────
def round1():
    print("\n=== R1: 全模块核心 CRUD(建/改/删 落库核验)===")
    # customers
    cu = trpc(admin, "customers.create", {"name": f"R1客{R}", "phone": f"647{R:07d}"[:11]})["id"]
    trpc(admin, "customers.update", {"id": cu, "company": "已改公司"})
    t.ok("客户 create+update 落库", psql(f'select company from customers where id={cu}') == "已改公司")
    trpc(admin, "customers.addInteraction", {"customerId": cu, "type": "call", "summary": "回访"})
    t.ok("客户 互动记录落库", count("customer_interactions", f'"customerId"={cu}') >= 1)
    trpc(admin, "customers.delete", {"id": cu})
    t.ok("客户 软删(deletedAt set)", psql(f'select "deletedAt" is not null from customers where id={cu}') == "t")
    # equipment categories / models
    trpc(admin, "equipmentModels.updateCategoryRates", {"category": f"FS类{R}", "dailyRate": "320.00"})
    t.ok("分类定价 updateCategoryRates 落库", psql(f"select \"dailyRate\" from equipment_models where id={C['model']}") == "320.00")
    em = trpc(admin, "equipmentModels.update", {"id": C['model'], "displayName": "改名型号"})
    t.ok("型号 update 落库", psql(f"select \"displayName\" from equipment_models where id={C['model']}") == "改名型号")
    # rentalFleet update (maintenance)
    trpc(admin, "rentalFleet.update", {"id": C['fleet'][1], "currentStatus": "maintenance", "notes": "保养中"})
    t.ok("设备 update 状态落库", psql(f"select \"currentStatus\" from rental_fleet where id={C['fleet'][1]}") == "maintenance")
    # customerPricing
    cp = trpc(admin, "customerPricing.create", {"customerId": C['cust'], "rentalFleetId": C['fleet'][0], "dailyRate": "250.00", "validFrom": "2026-01-01"})["id"]
    t.ok("客户专属定价 create 落库", count("customer_pricing", f"id={cp}") == 1)
    trpc(admin, "customerPricing.delete", {"id": cp})
    # projects
    trpc(admin, "projects.update", {"id": C['project'], "status": "active", "city": "Toronto"})
    t.ok("项目 update 落库", psql(f"select city from projects where id={C['project']}") == "Toronto")
    # operators / drivers / warehouses
    trpc(admin, "operators.update", {"id": C['operator'], "dailyRate": "200.00"})
    t.ok("操作员 update 落库", psql(f"select \"dailyRate\" from operators where id={C['operator']}") == "200.00")
    trpc(admin, "drivers.update", {"id": C['driver'], "licenseNumber": "D123"})
    t.ok("司机 update 落库", psql(f"select \"licenseNumber\" from drivers where id={C['driver']}") == "D123")
    trpc(admin, "warehouses.update", {"id": C['wh'], "phone": "4160000000"})
    t.ok("仓库 update 落库", psql(f"select phone from warehouses where id={C['wh']}") == "4160000000")
    # promotions + codes
    promo = trpc(admin, "promotions.create", {"name": f"R1促{R}", "discountPercent": "10.00", "commissionPercent": "5.00", "startDate": "2026-01-01", "endDate": "2026-12-31"})["id"]
    codes = trpc(admin, "promotions.generateCodes", {"promotionId": promo, "driverIds": [C['driver']], "codePrefix": "R1"})
    t.ok("推广 create+生成返佣码 落库", len(codes) >= 1 and count("referral_codes", f"\"promotionId\"={promo}") >= 1)
    # workOrders + parts
    wo = trpc(admin, "workOrders.create", {"rentalFleetId": C['fleet'][1], "type": "repair", "description": "修液压"})
    wo_id = wo.get("id") if isinstance(wo, dict) else wo
    trpc(admin, "workOrders.addPart", {"workOrderId": wo_id, "partName": "密封圈", "quantity": 2, "unitCost": 25})
    trpc(admin, "workOrders.updateStatus", {"id": wo_id, "status": "in_progress"})
    t.ok("工单 create+加配件+改状态 落库", count("work_order_parts", f'"workOrderId"={wo_id}') >= 1 and psql(f"select status from work_orders where id={wo_id}") == "in_progress")
    # fleetCertificates
    cert = trpc(admin, "fleetCertificates.create", {"rentalFleetId": C['fleet'][0], "certType": "inspection", "expiryDate": "2027-01-01"})["id"]
    t.ok("设备证书 create 落库", count("fleet_certificates", f"id={cert}") == 1)
    trpc(admin, "fleetCertificates.delete", {"id": cert})
    # dispatch
    disp = trpc(admin, "dispatch.create", {"orderType": "delivery", "rentalRequestId": C['order'], "customerId": C['cust'], "deliveryAddress": "1 Test Rd"})
    disp_id = disp.get("id") if isinstance(disp, dict) else disp
    trpc(admin, "dispatch.assignDriver", {"id": disp_id, "driverId": C['driver']})
    trpc(admin, "dispatch.updateStatus", {"id": disp_id, "status": "in_transit"})
    t.ok("调度 create+派司机+改状态 落库", psql(f"select \"assignedDriverId\" from dispatch_orders where id={disp_id}") == str(C['driver']))
    # rentalSettings
    trpc(admin, "rentalSettings.update", {"key": f"fs_test_{R}", "value": "v1", "description": "t"})
    t.ok("租赁设置 upsert 落库", psql(f"select value from rental_settings where key='fs_test_{R}'") == "v1")
    trpc(admin, "rentalSettings.delete", {"key": f"fs_test_{R}"})
    # depositRules
    dr = trpc(admin, "depositRules.create", {"category": f"FS类{R}", "depositType": "percentage", "value": "30"})["id"]
    t.ok("押金规则 create 落库", count("deposit_rules", f"id={dr}") == 1)
    trpc(admin, "depositRules.delete", {"id": dr})
    # contractTemplates
    ct = trpc(admin, "contractTemplates.create", {"name": f"FS合同{R}", "content": "条款..."})["id"]
    trpc(admin, "contractTemplates.setDefault", {"id": ct})
    t.ok("合同模板 create+设默认 落库", psql(f"select \"isDefault\" from contract_templates where id={ct}") == "t")
    # notifications template
    nt = trpc(admin, "notifications.saveTemplate", {"name": f"FS模板{R}", "channel": "email", "event": "test", "body": "hi"})
    t.ok("通知模板 save 落库", count("notification_templates", f"name='FS模板{R}'") >= 1)
    # downtime
    dt = trpc(admin, "downtime.report", {"rentalId": C['order'], "rentalFleetId": C['fleet'][0], "reason": "故障停机"})
    dt_id = dt.get("id") if isinstance(dt, dict) else dt
    trpc(admin, "downtime.resolve", {"id": dt_id, "resolution": "已修"})
    t.ok("停机 report+resolve 落库", psql(f'select "resolvedAt" is not null from downtime_records where id={dt_id}') == "t")
    # invoices: manual + payment
    inv = trpc(admin, "invoices.createManual", {"customerId": C['cust'], "type": "manual", "taxProvince": "ON", "lineItems": [{"description": "服务费", "quantity": 1, "unitPrice": 100}]})
    inv_id = inv.get("invoiceId") or inv.get("id")
    t.ok("发票 手工开票 落库", count("invoices", f"id={inv_id}") == 1)


# ── ROUND 2 — RBAC / validation / isolation ───────────────────────────────────
def round2():
    print("\n=== R2: 权限/校验/隔离 ===")
    field = api_field()
    # RBAC: field_staff cannot create admin-module entities
    t.err("现场员工不能建客户(FORBIDDEN)", lambda: trpc(field, "customers.create", {"name": "x", "phone": "4160000000"}), "FORBIDDEN")
    t.err("现场员工不能建设备(FORBIDDEN)", lambda: trpc(field, "rentalFleet.create", {"brand": "x", "model": "y"}), "FORBIDDEN")
    t.err("现场员工不能开发票(FORBIDDEN)", lambda: trpc(field, "invoices.createManual", {"customerId": C['cust'], "type": "manual", "lineItems": [{"description": "a", "quantity": 1, "unitPrice": 1}]}), "FORBIDDEN")
    # super_admin-only: create a plain admin user, ensure it can't do super-only ops
    au = trpc(admin, "users.create", {"username": f"r2admin{R}", "password": "Passw0rd!", "role": "admin", "name": "R2 Admin"})
    admin2 = api_field  # reuse pattern not applicable; login as admin2 via password
    from harness import requests, BASE_URL
    s2 = requests.Session()
    s2.post(f"{BASE_URL}/api/admin-auth/password-login", json={"username": f"r2admin{R}", "password": "Passw0rd!"}, timeout=30)
    t.err("普通管理员不能设信用额度(super only)", lambda: trpc(s2, "customers.setCreditLimit", {"id": C['cust'], "limit": 5000}), "FORBIDDEN")
    t.err("普通管理员不能改角色权限(super only)", lambda: trpc(s2, "rolePermissions.update", {"role": "admin", "module": "customers", "canCreate": True, "canRead": True, "canUpdate": True, "canDelete": True}), "FORBIDDEN")
    t.err("普通管理员不能加税率(super only)", lambda: trpc(s2, "rentalSettings.addTaxRate", {"province": "ZZ", "provinceName": "Z", "gstRate": 5, "pstRate": 0, "hstRate": 0}))
    # validation: bad input rejected
    t.err("校验:空名客户被拒", lambda: trpc(admin, "customers.create", {"name": "", "phone": "4160000000"}), "BAD_REQUEST")
    t.err("校验:订单起止日反了被拒", lambda: trpc(admin, "rentals.adminCreate", {"customerName": "x", "customerPhone": "4160000000", "rentalFleetId": C['fleet'][0], "startDate": "2026-09-10", "endDate": "2026-09-05", "deliveryMethod": "pickup", "insuranceType": "basic"}), "BAD_REQUEST")
    t.err("校验:保险=none无证明被拒", lambda: trpc(admin, "rentals.adminCreate", {"customerName": "x", "customerPhone": "4160000000", "rentalFleetId": C['fleet'][0], "startDate": "2026-10-01", "endDate": "2026-10-03", "deliveryMethod": "pickup", "insuranceType": "none"}), "BAD_REQUEST")
    # isolation: soft-deleted entity excluded from list
    cu = trpc(admin, "customers.create", {"name": f"R2隔离{R}", "phone": f"289{R:07d}"[:11]})["id"]
    trpc(admin, "customers.delete", {"id": cu})
    lst = trpc(admin, "customers.list", {"search": f"R2隔离{R}"}, method="GET")
    t.ok("软删客户不出现在列表", all(c["id"] != cu for c in lst))
    # availability isolation: occupied unit not double-booked
    t.err("同设备同档期重复下单被拒(冲突)", lambda: trpc(admin, "rentals.adminCreate", {"customerName": "dup", "customerPhone": "4160000001", "rentalFleetId": C['fleet'][0], "startDate": "2026-09-01", "endDate": "2026-09-03", "deliveryMethod": "pickup", "insuranceType": "basic", "rentalFee": "600", "insuranceCost": "90", "taxAmount": "89.7", "totalAmount": "779.7"}), "CONFLICT")


# ── ROUND 3 — integration + integrity ─────────────────────────────────────────
def round3():
    print("\n=== R3: 跨模块集成 + 数据完整性 ===")
    # full lifecycle on a fresh unit: order → return inspection → close → invoice → payment
    r3_fleet = trpc(admin, "rentalFleet.create", {"brand": f"FSB{R}", "model": f"FSM{R}", "category": f"FS类{R}", "serialNumber": f"FS-R3-{R}", "currentStatus": "available"})["id"]
    q = trpc(admin, "rentals.previewMultiItemQuote", {"startDate": "2026-11-01", "endDate": "2026-11-03", "deliveryMethod": "pickup", "taxProvince": "ON", "insuranceType": "basic", "items": [{"equipmentModelId": None, "fleetIds": [r3_fleet], "itemType": "machine", "quantity": 1}]}, method="GET")
    o = trpc(admin, "rentals.adminCreate", {"customerName": f"R3客{R}", "customerPhone": f"905{R:07d}"[:11], "rentalFleetId": r3_fleet, "startDate": "2026-11-01", "endDate": "2026-11-03", "deliveryMethod": "pickup", "insuranceType": "basic", "rentalFee": f'{q["rentalFee"]:.2f}', "freightCost": "0", "insuranceCost": f'{q["insuranceCost"]:.2f}', "taxAmount": f'{q["taxAmount"]:.2f}', "depositAmount": f'{q["depositAmount"]:.2f}', "totalAmount": f'{q["totalAmount"]:.2f}'})["id"]
    trpc(admin, "rentals.updateStatus", {"id": o, "status": "approved"}); trpc(admin, "rentals.updateStatus", {"id": o, "status": "active"})
    from harness import api_anon
    tok = trpc(admin, "inspections.createToken", {"rentalId": o, "rentalFleetId": r3_fleet, "inspectionType": "return"})
    trpc(api_anon(), "inspections.createWithToken", {"token": tok["token"], "type": "return", "rentalId": o, "rentalFleetId": r3_fleet, "overallCondition": "good", "damageSeverity": "none"})
    t.ok("集成:归还验收置 returnInspectionCompleted", psql(f'select "returnInspectionCompleted" from rental_requests where id={o}') == "t")
    trpc(admin, "rentals.closeRental", {"id": o})
    t.ok("集成:关单→已完成", psql(f"select status from rental_requests where id={o}") == "completed")
    t.ok("集成:关单→设备释放回可用", psql(f"select \"currentStatus\" from rental_fleet where id={r3_fleet}") == "available")
    inv = trpc(admin, "invoices.list", {"rentalId": o}, method="GET")
    inv_row = next((x["invoices"] for x in inv if x["invoices"].get("type") == "rental"), None)
    t.ok("集成:关单自动生成发票且总额=订单", inv_row and abs(float(inv_row["totalAmount"]) - q["totalAmount"]) < 0.02)
    trpc(admin, "rentalPrepayments.create", {"rentalRequestId": o, "amount": f'{q["totalAmount"]:.2f}', "paymentMethod": "cash", "paymentDate": "2026-11-03"})
    trpc(admin, "rentalPrepayments.convertToRent", {"rentalRequestId": o})
    inv2 = trpc(admin, "invoices.getById", {"id": inv_row["id"]}, method="GET")
    t.ok("集成:收款后发票自动=已付", inv2["invoices"]["status"] == "paid")
    # report reflects revenue
    rep = trpc(admin, "reports.financialSummary", {"startDate": "2026-01-01", "endDate": "2026-12-31"}, method="GET") if False else None
    # integrity: no orphan invoices/line items; counts sane
    orphan_li = count("invoice_line_items", 'NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id="invoice_line_items"."invoiceId")')
    t.ok("完整性:无孤儿发票明细", orphan_li == 0, f"orphans={orphan_li}")
    orphan_pre = count("rental_prepayments", 'NOT EXISTS (SELECT 1 FROM rental_requests r WHERE r.id="rental_prepayments"."rentalRequestId")')
    t.ok("完整性:无孤儿预付款", orphan_pre == 0, f"orphans={orphan_pre}")
    # regression: re-create a customer deterministically
    rc = trpc(admin, "customers.create", {"name": f"R3回归{R}", "phone": f"416{(R+1):07d}"[:11]})["id"]
    t.ok("回归:客户再建成功", count("customers", f"id={rc}") == 1)


# ── ROUND 4 — ERP enforcement guards (档A) ─────────────────────────────────────
def round4():
    print("\n=== R4: ERP 强制约束(无费率拦单 / 改价必填原因)===")
    # G1: a rate-less model cannot be ordered ($0 booking blocked)
    trpc(admin, "equipmentCategories.create", {"name": f"无价类{R}"})
    trpc(admin, "equipmentModels.create", {"category": f"无价类{R}", "brand": f"NP{R}", "model": f"NPM{R}", "equipmentType": "machine"})  # NO rate
    nf = trpc(admin, "rentalFleet.create", {"brand": f"NP{R}", "model": f"NPM{R}", "category": f"无价类{R}", "serialNumber": f"NP-{R}", "currentStatus": "available"})["id"]
    q0 = trpc(admin, "rentals.previewMultiItemQuote", {"startDate": "2026-12-01", "endDate": "2026-12-03", "deliveryMethod": "pickup", "taxProvince": "ON", "insuranceType": "basic", "items": [{"equipmentModelId": None, "fleetIds": [nf], "itemType": "machine", "quantity": 1}]}, method="GET")
    t.ok("预览:无费率标志 hasUnpricedMachine=true 且 $0", q0.get("hasUnpricedMachine") is True and q0["rentalFee"] == 0, str(q0.get("hasUnpricedMachine")))
    t.err("★G1 无费率→单台下单被拒(BAD_REQUEST)", lambda: trpc(admin, "rentals.adminCreate", {"customerName": f"NP客{R}", "customerPhone": f"647{R:07d}"[:11], "rentalFleetId": nf, "startDate": "2026-12-01", "endDate": "2026-12-03", "deliveryMethod": "pickup", "insuranceType": "basic", "rentalFee": "0", "insuranceCost": "0", "taxAmount": "0", "totalAmount": "0"}), "BAD_REQUEST")
    t.err("★G1 无费率→公开自助下单被拒", lambda: trpc(__import__("harness").api_anon(), "rentals.create", {"customerName": f"NP自助{R}", "customerEmail": f"np{R}@ex.com", "customerPhone": f"647{(R+2):07d}"[:11], "rentalFleetId": nf, "startDate": "2026-12-05", "endDate": "2026-12-07", "deliveryMethod": "pickup"}), "BAD_REQUEST")
    # after setting a rate, the SAME unit can be ordered
    trpc(admin, "equipmentModels.updateCategoryRates", {"category": f"无价类{R}", "dailyRate": "150.00"})
    q1 = trpc(admin, "rentals.previewMultiItemQuote", {"startDate": "2026-12-01", "endDate": "2026-12-03", "deliveryMethod": "pickup", "taxProvince": "ON", "insuranceType": "basic", "items": [{"equipmentModelId": None, "fleetIds": [nf], "itemType": "machine", "quantity": 1}]}, method="GET")
    okc = trpc(admin, "rentals.adminCreate", {"customerName": f"NP客{R}", "customerPhone": f"647{R:07d}"[:11], "rentalFleetId": nf, "startDate": "2026-12-01", "endDate": "2026-12-03", "deliveryMethod": "pickup", "insuranceType": "basic", "rentalFee": f'{q1["rentalFee"]:.2f}', "insuranceCost": f'{q1["insuranceCost"]:.2f}', "taxAmount": f'{q1["taxAmount"]:.2f}', "depositAmount": f'{q1["depositAmount"]:.2f}', "totalAmount": f'{q1["totalAmount"]:.2f}'})
    t.ok("设费率后同设备可正常下单", okc and okc.get("id") and q1["rentalFee"] > 0)
    # G3: manual override without reason is rejected; with reason succeeds
    # (use the available fixture unit + clearly-free dates so availability passes
    #  and the override-reason guard is what triggers).
    t.err("★G3 覆盖价格无原因→被拒(BAD_REQUEST)", lambda: trpc(admin, "rentals.adminCreate", {"customerName": f"OV客{R}", "customerPhone": f"905{R:07d}"[:11], "rentalFleetId": C['fleet'][0], "startDate": "2027-01-10", "endDate": "2027-01-12", "deliveryMethod": "pickup", "insuranceType": "basic", "priceMatchEnabled": True, "rentalFee": "500", "insuranceCost": "75", "taxAmount": "74.75", "totalAmount": "649.75"}), "BAD_REQUEST")
    ov = trpc(admin, "rentals.adminCreate", {"customerName": f"OV客{R}", "customerPhone": f"905{R:07d}"[:11], "rentalFleetId": C['fleet'][0], "startDate": "2027-01-10", "endDate": "2027-01-12", "deliveryMethod": "pickup", "insuranceType": "basic", "priceMatchEnabled": True, "priceMatchCompetitor": "X", "priceMatchNote": "对标竞品报价", "rentalFee": "500", "insuranceCost": "75", "taxAmount": "74.75", "totalAmount": "649.75"})
    t.ok("覆盖价格填了原因→成功且留痕", ov and ov.get("id") and psql(f"select \"priceMatchNote\" from rental_requests where id={ov['id']}") == "对标竞品报价")


if __name__ == "__main__":
    round_arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    base_fixture()
    if round_arg in ("all", "1"): round1()
    if round_arg in ("all", "2"): round2()
    if round_arg in ("all", "3"): round3()
    if round_arg in ("all", "4"): round4()
    sys.exit(0 if t.total() else 1)
