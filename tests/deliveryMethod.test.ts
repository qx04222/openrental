import { describe, it, expect } from "vitest";
import { DELIVERY_METHODS } from "../shared/deliveryMethod";
import type { DeliveryMethod } from "../shared/deliveryMethod";

describe("DELIVERY_METHODS (shared module)", () => {
  it("has exactly three methods", () => {
    expect(Object.keys(DELIVERY_METHODS)).toHaveLength(3);
  });

  it("has pickup, delivery, delivery_and_return", () => {
    expect(Object.keys(DELIVERY_METHODS)).toEqual(["pickup", "delivery", "delivery_and_return"]);
  });

  describe("pickup", () => {
    it("has no delivery address requirement", () => {
      expect(DELIVERY_METHODS.pickup.hasDeliveryAddress).toBe(false);
    });

    it("has no freight cost", () => {
      expect(DELIVERY_METHODS.pickup.hasFreight).toBe(false);
    });

    it("has 0 trips", () => {
      expect(DELIVERY_METHODS.pickup.trips).toBe(0);
    });

    it("has label and description", () => {
      expect(DELIVERY_METHODS.pickup.label).toBeTruthy();
      expect(DELIVERY_METHODS.pickup.description).toBeTruthy();
    });
  });

  describe("delivery (one-way)", () => {
    it("requires delivery address", () => {
      expect(DELIVERY_METHODS.delivery.hasDeliveryAddress).toBe(true);
    });

    it("has freight cost", () => {
      expect(DELIVERY_METHODS.delivery.hasFreight).toBe(true);
    });

    it("has 1 trip", () => {
      expect(DELIVERY_METHODS.delivery.trips).toBe(1);
    });
  });

  describe("delivery_and_return (round trip)", () => {
    it("requires delivery address", () => {
      expect(DELIVERY_METHODS.delivery_and_return.hasDeliveryAddress).toBe(true);
    });

    it("has freight cost", () => {
      expect(DELIVERY_METHODS.delivery_and_return.hasFreight).toBe(true);
    });

    it("has 2 trips", () => {
      expect(DELIVERY_METHODS.delivery_and_return.trips).toBe(2);
    });
  });

  describe("type safety", () => {
    it("DeliveryMethod type matches keys", () => {
      const keys = Object.keys(DELIVERY_METHODS) as DeliveryMethod[];
      expect(keys).toEqual(["pickup", "delivery", "delivery_and_return"]);
    });
  });
});
