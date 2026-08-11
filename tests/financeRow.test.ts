/**
 * Transportation-row export — pure-function unit tests (no mocks).
 *
 * Locked to the simplified transportation log layout (7 columns) plus the
 * WeChat dispatch block.
 */
import { describe, it, expect } from "vitest";
import {
  buildFinanceRow,
  financeRowTSV,
  financeRowsTSV,
  buildWeChatDispatch,
} from "../client/src/lib/financeRow";
import {
  FINANCE_ROW_COLUMNS,
  formatFinanceMoney,
  type FinanceColumn,
} from "../client/src/lib/financeRowColumns";

// Shape mirrors rentals.getById: { rental_requests, rental_fleet, customers, _export }.
function makeOrder(
  overrides: Record<string, unknown> = {},
  exportOverrides: Record<string, unknown> = {},
) {
  return {
    rental_requests: {
      rentalNumber: "R-1001",
      financialOrderNumber: "SOT12269",
      customerName: "Acme Co",
      customerCompany: "Acme Holdings",
      customerPhone: "416-555-1212",
      deliveryAddress: "1 King St, Toronto",
      deliveryMethod: "delivery",
      equipmentDescription: "20yd Bin",
      startDate: "2026-07-01T12:00:00Z",
      endDate: "2026-07-10T12:00:00Z",
      status: "active",
      adminNotes: "Pallet fork",
      ...overrides,
    },
    rental_fleet: { brand: "Generic", model: "NX-27", assetNumber: "#10", serialNumber: "SN-9988" },
    customers: { name: "Acme Co" },
    _export: {
      orderNumber: "SOT12269", // financialOrderNumber || rentalNumber
      days: 9,
      machineModel: "NX-27", // model only, no brand
      deliveryMethodLabel: "Delivery",
      ...exportOverrides,
    },
  };
}

const labelIndex = (label: string) =>
  FINANCE_ROW_COLUMNS.findIndex((c: FinanceColumn) => c.label === label);
const cell = (order: unknown, label: string) =>
  buildFinanceRow(order)[labelIndex(label)];

describe("formatFinanceMoney", () => {
  it("renders 2 decimals and strips $ / commas", () => {
    expect(formatFinanceMoney("1200.5")).toBe("1200.50");
    expect(formatFinanceMoney("$1,200.50")).toBe("1200.50");
    expect(formatFinanceMoney(60)).toBe("60.00");
  });
  it("maps empty / null / invalid to empty string", () => {
    expect(formatFinanceMoney(null)).toBe("");
    expect(formatFinanceMoney(undefined)).toBe("");
    expect(formatFinanceMoney("")).toBe("");
    expect(formatFinanceMoney("abc")).toBe("");
  });
});

describe("Transportation row column lock", () => {
  it("has exactly 7 columns in the header order", () => {
    expect(FINANCE_ROW_COLUMNS).toHaveLength(7);
    expect(FINANCE_ROW_COLUMNS.map((c) => c.label)).toEqual([
      "日期", "单号", "公司", "电话", "地址", "NOTE", "NOTE 2",
    ]);
  });
});

describe("buildFinanceRow", () => {
  it("produces one value per column, in order", () => {
    const row = buildFinanceRow(makeOrder());
    expect(row).toHaveLength(FINANCE_ROW_COLUMNS.length);
    expect(cell(makeOrder(), "日期")).toBe("2026-07-01"); // Toronto-anchored
    expect(cell(makeOrder(), "单号")).toBe("SOT12269");
    expect(cell(makeOrder(), "电话")).toBe("416-555-1212");
    expect(cell(makeOrder(), "地址")).toBe("1 King St, Toronto");
    expect(cell(makeOrder(), "NOTE")).toBe("Delivery");
    expect(cell(makeOrder(), "NOTE 2")).toBe("Pallet fork");
  });

  it("单号 prefers the financial order # and falls back to our rentalNumber", () => {
    expect(cell(makeOrder(), "单号")).toBe("SOT12269");
    expect(cell(makeOrder({}, { orderNumber: "R-1001" }), "单号")).toBe("R-1001");
  });

  it("公司 falls back to the customer name when company is null", () => {
    expect(cell(makeOrder({ customerCompany: null }), "公司")).toBe("Acme Co");
    expect(cell(makeOrder(), "公司")).toBe("Acme Holdings");
  });

  it("sanitizes embedded tabs/newlines so cells don't split", () => {
    const c = cell(makeOrder({ adminNotes: "line1\tx\nline2" }), "NOTE 2");
    expect(c).not.toMatch(/[\t\n\r]/);
    expect(c).toBe("line1 x line2");
  });
});

describe("financeRowTSV", () => {
  it("is a single tab-separated line by default (no header)", () => {
    const tsv = financeRowTSV(makeOrder());
    expect(tsv.split("\n")).toHaveLength(1);
    expect(tsv.split("\t")).toHaveLength(FINANCE_ROW_COLUMNS.length);
  });

  it("prepends a header line when withHeader is true", () => {
    const tsv = financeRowTSV(makeOrder(), { withHeader: true });
    const [header, row] = tsv.split("\n");
    expect(header.split("\t")[0]).toBe("日期");
    expect(row.split("\t")[1]).toBe("SOT12269");
  });

  it("respects a custom column subset", () => {
    const cols: FinanceColumn[] = [
      { key: "rental_requests.rentalNumber", label: "单号" },
      { key: "rental_requests.freightCost", label: "运费", format: formatFinanceMoney },
    ];
    const tsv = financeRowTSV(makeOrder({ freightCost: "150.00" }), { columns: cols });
    expect(tsv).toBe("R-1001\t150.00");
  });
});

describe("financeRowsTSV", () => {
  it("emits a header plus one row per order", () => {
    const tsv = financeRowsTSV([makeOrder(), makeOrder({}, { orderNumber: "SOT99999" })]);
    const lines = tsv.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1].split("\t")[1]).toBe("SOT12269");
    expect(lines[2].split("\t")[1]).toBe("SOT99999");
  });
});

describe("buildWeChatDispatch", () => {
  it("renders one field per line in the dispatch order", () => {
    expect(buildWeChatDispatch(makeOrder())).toBe(
      [
        "Add: 1 King St, Toronto",
        "Tel: 416-555-1212",
        "Del Time: 7/1/2026", // Toronto-anchored M/D/YYYY, no leading zeros
        "Machine: NX-27 (9days)",
        "SN: SN-9988",
        "Note: Delivery",
      ].join("\n"),
    );
  });

  it("uses the singular '1day' and includes the equipment serial number", () => {
    const out = buildWeChatDispatch(makeOrder({}, { days: 1, machineModel: "NX-25" }));
    expect(out).toContain("Machine: NX-25 (1day)");
    expect(out).toContain("SN: SN-9988");
  });

  it("omits empty lines (e.g. pickup with no address / no serial)", () => {
    const out = buildWeChatDispatch(
      makeOrder(
        { deliveryAddress: "", deliveryMethod: "pickup" },
        { deliveryMethodLabel: "Self pickup" },
      ) as Record<string, unknown> & { rental_fleet: { serialNumber?: string } },
    );
    expect(out).not.toMatch(/^Add:/m);
    expect(out).toContain("Note: Self pickup");
  });

  it("drops the SN line when the unit has no serial number", () => {
    const order = makeOrder();
    (order.rental_fleet as Record<string, unknown>).serialNumber = null;
    const out = buildWeChatDispatch(order);
    expect(out).not.toMatch(/^SN:/m);
    expect(out).toContain("Machine: NX-27 (9days)");
  });
});
