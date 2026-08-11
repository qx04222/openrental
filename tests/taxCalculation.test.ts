/**
 * Tax Calculation Service — unit tests with DB mock
 *
 * Tests the Canada province-based tax calculation logic:
 * - HST provinces (ON, NB, NL, NS, PE)
 * - GST+PST provinces (BC, SK, MB, QC)
 * - GST-only territories (AB, NT, NU, YT)
 * - Tax base: rental + shipping + LDW (NOT deposit)
 * - Rounding to 2 decimal places
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecute, mockExecuteResult, mockGetDb } = vi.hoisted(() => {
  const mockExecuteResult: { data: unknown[] } = { data: [] };
  const mockExecute = vi.fn().mockImplementation(() => Promise.resolve(mockExecuteResult.data));
  const mockDb = { execute: mockExecute };
  const mockGetDb = vi.fn().mockResolvedValue(mockDb);
  return { mockExecute, mockExecuteResult, mockGetDb, mockDb };
});

vi.mock("../server/db", () => ({
  getDb: mockGetDb,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock("../server/_core/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { getTaxRateByProvince, calculateTax, getAllTaxRates } from "../server/services/taxCalculation";
import type { TaxCalculationInput } from "../server/services/taxCalculation";

describe("taxCalculation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteResult.data = [];
  });

  describe("getTaxRateByProvince", () => {
    it("should return tax rate for valid province", async () => {
      mockExecuteResult.data = [
        { province: "ON", provinceName: "Ontario", gstRate: "0", pstRate: "0", hstRate: "0.13", isActive: true },
      ];

      const result = await getTaxRateByProvince("ON");
      expect(result).not.toBeNull();
      expect(result!.province).toBe("ON");
      expect(result!.hstRate).toBe(0.13);
      expect(result!.isActive).toBe(true);
    });

    it("should sanitize province input (uppercase, letters only, max 2)", async () => {
      mockExecuteResult.data = [
        { province: "BC", provinceName: "British Columbia", gstRate: "0.05", pstRate: "0.07", hstRate: "0", isActive: true },
      ];

      // Lowercase should work
      await getTaxRateByProvince("bc");
      expect(mockExecute).toHaveBeenCalled();
    });

    it("should return null if province not found", async () => {
      mockExecuteResult.data = [];
      const result = await getTaxRateByProvince("XX");
      expect(result).toBeNull();
    });

    it("should return null on DB error (Error instance)", async () => {
      mockExecute.mockRejectedValueOnce(new Error("connection lost"));
      const result = await getTaxRateByProvince("ON");
      expect(result).toBeNull();
    });

    it("should return null on DB error (non-Error throw)", async () => {
      mockExecute.mockRejectedValueOnce("string error");
      const result = await getTaxRateByProvince("ON");
      expect(result).toBeNull();
    });

    it("should return null if DB is unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const result = await getTaxRateByProvince("ON");
      expect(result).toBeNull();
    });

    it("should parse string rates to numbers", async () => {
      mockExecuteResult.data = [
        { province: "BC", provinceName: "British Columbia", gstRate: "0.05", pstRate: "0.07", hstRate: "0", isActive: true },
      ];

      const result = await getTaxRateByProvince("BC");
      expect(typeof result!.gstRate).toBe("number");
      expect(typeof result!.pstRate).toBe("number");
      expect(result!.gstRate).toBe(0.05);
      expect(result!.pstRate).toBe(0.07);
    });

    it("should handle numeric rates (not just strings)", async () => {
      mockExecuteResult.data = [
        { province: "ON", provinceName: "Ontario", gstRate: 0, pstRate: 0, hstRate: 0.13, isActive: true },
      ];

      const result = await getTaxRateByProvince("ON");
      expect(result!.hstRate).toBe(0.13);
      expect(result!.gstRate).toBe(0);
    });

    it("should default empty/null rates to 0", async () => {
      mockExecuteResult.data = [
        { province: "XX", provinceName: "Test", gstRate: "", pstRate: null, hstRate: undefined, isActive: true },
      ];

      const result = await getTaxRateByProvince("XX");
      expect(result!.gstRate).toBe(0);
    });
  });

  describe("calculateTax", () => {
    const baseInput: TaxCalculationInput = {
      rentalAmount: 1000,
      shippingAmount: 100,
      ldwAmount: 50,
      depositAmount: 500,
      province: "ON",
    };

    it("should calculate HST correctly for Ontario", async () => {
      mockExecuteResult.data = [
        { province: "ON", provinceName: "Ontario", gstRate: "0", pstRate: "0", hstRate: "0.13", isActive: true },
      ];

      const result = await calculateTax(baseInput);
      expect(result.taxBase).toBe(1150);
      expect(result.hstAmount).toBe(149.5);
      expect(result.gstAmount).toBe(0);
      expect(result.pstAmount).toBe(0);
      expect(result.totalTax).toBe(149.5);
      expect(result.taxBreakdown).toContain("HST");
      expect(result.taxBreakdown).toContain("13.00%");
    });

    it("should calculate GST + PST correctly for BC", async () => {
      mockExecuteResult.data = [
        { province: "BC", provinceName: "British Columbia", gstRate: "0.05", pstRate: "0.07", hstRate: "0", isActive: true },
      ];

      const result = await calculateTax({ ...baseInput, province: "BC" });
      expect(result.taxBase).toBe(1150);
      expect(result.gstAmount).toBe(57.5);
      expect(result.pstAmount).toBe(80.5);
      expect(result.hstAmount).toBe(0);
      expect(result.totalTax).toBe(138);
      expect(result.taxBreakdown).toContain("GST");
      expect(result.taxBreakdown).toContain("PST");
    });

    it("should calculate GST-only correctly for Alberta", async () => {
      mockExecuteResult.data = [
        { province: "AB", provinceName: "Alberta", gstRate: "0.05", pstRate: "0", hstRate: "0", isActive: true },
      ];

      const result = await calculateTax({ ...baseInput, province: "AB" });
      expect(result.gstAmount).toBe(57.5);
      expect(result.pstAmount).toBe(0);
      expect(result.totalTax).toBe(57.5);
      expect(result.taxBreakdown).toBe("GST 5.00%");
    });

    it("should handle PST-only (hypothetical) correctly", async () => {
      mockExecuteResult.data = [
        { province: "XX", provinceName: "TestProv", gstRate: "0", pstRate: "0.08", hstRate: "0", isActive: true },
      ];

      const result = await calculateTax({ ...baseInput, province: "XX" });
      expect(result.gstAmount).toBe(0);
      expect(result.pstAmount).toBe(92);
      expect(result.taxBreakdown).toBe("PST 8.00%");
    });

    it("should handle zero-tax province (all rates = 0)", async () => {
      mockExecuteResult.data = [
        { province: "ZZ", provinceName: "ZeroTax", gstRate: "0", pstRate: "0", hstRate: "0", isActive: true },
      ];

      const result = await calculateTax({ ...baseInput, province: "ZZ" });
      expect(result.totalTax).toBe(0);
      expect(result.taxBreakdown).toBe("No tax");
    });

    it("should fallback to Ontario HST 13% for unknown province (not in DB)", async () => {
      mockExecuteResult.data = [];

      const result = await calculateTax({ ...baseInput, province: "UNKNOWN" });
      // baseInput: rental 1000 + shipping 100 + ldw 50 = 1150 taxBase
      expect(result.taxRate).toBe(0.13);
      expect(result.totalTax).toBe(Math.round(1150 * 0.13 * 100) / 100);
      expect(result.provinceName).toContain("Unknown");
      expect(result.taxBreakdown).toContain("HST 13.00%");
    });

    it("should round to 2 decimal places", async () => {
      mockExecuteResult.data = [
        { province: "ON", provinceName: "Ontario", gstRate: "0", pstRate: "0", hstRate: "0.13", isActive: true },
      ];

      const result = await calculateTax({
        rentalAmount: 33.33,
        shippingAmount: 11.11,
        ldwAmount: 5.55,
        depositAmount: 100,
        province: "ON",
      });

      expect(result.taxBase).toBe(49.99);
      expect(result.hstAmount).toBe(6.5);
    });

    it("should not include deposit in tax base", async () => {
      mockExecuteResult.data = [
        { province: "ON", provinceName: "Ontario", gstRate: "0", pstRate: "0", hstRate: "0.13", isActive: true },
      ];

      const result = await calculateTax({
        rentalAmount: 100,
        shippingAmount: 0,
        ldwAmount: 0,
        depositAmount: 9999,
        province: "ON",
      });

      expect(result.taxBase).toBe(100);
      expect(result.totalTax).toBe(13);
    });

    it("should return combined rate in taxRate field", async () => {
      mockExecuteResult.data = [
        { province: "BC", provinceName: "British Columbia", gstRate: "0.05", pstRate: "0.07", hstRate: "0", isActive: true },
      ];

      const result = await calculateTax({ ...baseInput, province: "BC" });
      expect(result.taxRate).toBeCloseTo(0.12);
    });
  });

  describe("getAllTaxRates", () => {
    it("should return array of parsed tax rates", async () => {
      mockExecuteResult.data = [
        { province: "ON", provinceName: "Ontario", gstRate: "0", pstRate: "0", hstRate: "0.13", isActive: true },
        { province: "BC", provinceName: "British Columbia", gstRate: "0.05", pstRate: "0.07", hstRate: "0", isActive: true },
      ];

      const rates = await getAllTaxRates();
      expect(rates).toHaveLength(2);
      expect(rates[0].province).toBe("ON");
      expect(typeof rates[0].hstRate).toBe("number");
    });

    it("should return empty array if DB unavailable", async () => {
      mockGetDb.mockResolvedValueOnce(null);
      const rates = await getAllTaxRates();
      expect(rates).toEqual([]);
    });

    it("should return empty array on DB error", async () => {
      mockExecute.mockRejectedValueOnce(new Error("query timeout"));
      const rates = await getAllTaxRates();
      expect(rates).toEqual([]);
    });

    it("should return empty array if result is null", async () => {
      mockExecute.mockResolvedValueOnce(null);
      const rates = await getAllTaxRates();
      expect(rates).toEqual([]);
    });

    it("should handle numeric rates in getAllTaxRates", async () => {
      mockExecuteResult.data = [
        { province: "AB", provinceName: "Alberta", gstRate: 0.05, pstRate: 0, hstRate: 0, isActive: true },
      ];

      const rates = await getAllTaxRates();
      expect(rates[0].gstRate).toBe(0.05);
      expect(rates[0].isActive).toBe(true);
    });

    it("should handle empty string rates in getAllTaxRates", async () => {
      mockExecuteResult.data = [
        { province: "XX", provinceName: "Test", gstRate: "", pstRate: "", hstRate: "", isActive: false },
      ];

      const rates = await getAllTaxRates();
      expect(rates[0].gstRate).toBe(0);
      expect(rates[0].isActive).toBe(false);
    });
  });
});
