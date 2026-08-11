import { describe, it, expect } from "vitest";
import {
  COOKIE_NAME,
  ADMIN_COOKIE_NAME,
  FIELD_COOKIE_NAME,
  ONE_YEAR_MS,
  BRAND_CONTACT,
  AXIOS_TIMEOUT_MS,
  UNAUTHED_ERR_MSG,
  NOT_ADMIN_ERR_MSG,
} from "../shared/const";
import { CANADA_PROVINCES } from "../shared/rentalTypes";
import type { DeliveryMethod, InsuranceType, CostEstimate, ShippingDetails } from "../shared/rentalTypes";

describe("shared/const", () => {
  describe("cookie names", () => {
    it("COOKIE_NAME is a non-empty string", () => {
      expect(COOKIE_NAME).toBeTruthy();
      expect(typeof COOKIE_NAME).toBe("string");
    });

    it("ADMIN_COOKIE_NAME is a non-empty string", () => {
      expect(ADMIN_COOKIE_NAME).toBeTruthy();
    });

    it("FIELD_COOKIE_NAME is a non-empty string", () => {
      expect(FIELD_COOKIE_NAME).toBeTruthy();
    });

    it("all cookie names are distinct", () => {
      const names = new Set([COOKIE_NAME, ADMIN_COOKIE_NAME, FIELD_COOKIE_NAME]);
      expect(names.size).toBe(3);
    });
  });

  describe("time constants", () => {
    it("ONE_YEAR_MS is approximately 365 days in ms", () => {
      const expected = 1000 * 60 * 60 * 24 * 365;
      expect(ONE_YEAR_MS).toBe(expected);
    });

    it("AXIOS_TIMEOUT_MS is 30 seconds", () => {
      expect(AXIOS_TIMEOUT_MS).toBe(30_000);
    });
  });

  describe("BRAND_CONTACT", () => {
    it("has all required fields", () => {
      expect(BRAND_CONTACT).toHaveProperty("companyName");
      expect(BRAND_CONTACT).toHaveProperty("rentalEmail");
      expect(BRAND_CONTACT).toHaveProperty("rentalPhone");
      expect(BRAND_CONTACT).toHaveProperty("salesEmail");
      expect(BRAND_CONTACT).toHaveProperty("salesPhone");
      expect(BRAND_CONTACT).toHaveProperty("address");
      expect(BRAND_CONTACT).toHaveProperty("domain");
    });

    it("email addresses contain @", () => {
      expect(BRAND_CONTACT.rentalEmail).toContain("@");
      expect(BRAND_CONTACT.salesEmail).toContain("@");
    });

    it("phone numbers start with +1", () => {
      expect(BRAND_CONTACT.rentalPhone).toMatch(/^\+1/);
      expect(BRAND_CONTACT.salesPhone).toMatch(/^\+1/);
    });
  });

  describe("error messages", () => {
    it("UNAUTHED_ERR_MSG contains error code", () => {
      expect(UNAUTHED_ERR_MSG).toContain("10001");
    });

    it("NOT_ADMIN_ERR_MSG contains error code", () => {
      expect(NOT_ADMIN_ERR_MSG).toContain("10002");
    });
  });
});

describe("shared/rentalTypes — CANADA_PROVINCES", () => {
  it("has 13 provinces/territories", () => {
    expect(CANADA_PROVINCES).toHaveLength(13);
  });

  it("each entry has code (2-letter) and name", () => {
    for (const prov of CANADA_PROVINCES) {
      expect(prov.code).toMatch(/^[A-Z]{2}$/);
      expect(prov.name).toBeTruthy();
      expect(typeof prov.name).toBe("string");
    }
  });

  it("includes Ontario (ON)", () => {
    const on = CANADA_PROVINCES.find((p) => p.code === "ON");
    expect(on).toBeDefined();
    expect(on?.name).toBe("Ontario");
  });

  it("includes Quebec (QC)", () => {
    const qc = CANADA_PROVINCES.find((p) => p.code === "QC");
    expect(qc).toBeDefined();
    expect(qc?.name).toBe("Quebec");
  });

  it("includes British Columbia (BC)", () => {
    const bc = CANADA_PROVINCES.find((p) => p.code === "BC");
    expect(bc).toBeDefined();
  });

  it("includes all territories", () => {
    const territories = ["NT", "NU", "YT"];
    for (const code of territories) {
      expect(CANADA_PROVINCES.find((p) => p.code === code)).toBeDefined();
    }
  });

  it("codes are unique", () => {
    const codes = CANADA_PROVINCES.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("shared/rentalTypes — type structures", () => {
  it("DeliveryMethod accepts valid values", () => {
    const methods: DeliveryMethod[] = ["pickup", "delivery", "delivery_and_return"];
    expect(methods).toHaveLength(3);
  });

  it("InsuranceType accepts valid values", () => {
    const types: InsuranceType[] = ["none", "basic", "full"];
    expect(types).toHaveLength(3);
  });

  it("CostEstimate has all required fields", () => {
    const estimate: CostEstimate = {
      rentalFee: 1000,
      rentalBreakdown: "1 month × $1,000",
      freightCost: 150,
      insuranceCost: 100,
      taxAmount: 162.5,
      taxBreakdown: "HST 13.00%",
      depositAmount: 500,
      subtotal: 1250,
      totalAmount: 1912.5,
    };
    expect(estimate.totalAmount).toBeGreaterThan(estimate.subtotal);
  });

  it("ShippingDetails has all required fields", () => {
    const details: ShippingDetails = {
      distance: 50,
      duration: 3600,
      baseFee: 100,
      includedKm: 25,
      excessKm: 25,
      excessCost: 50,
      totalCost: 150,
      tierName: "Standard",
    };
    expect(details.totalCost).toBe(details.baseFee + details.excessCost);
  });
});
