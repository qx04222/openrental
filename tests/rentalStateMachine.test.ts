import { describe, it, expect } from "vitest";
import {
  RENTAL_VALID_TRANSITIONS,
  canTransition,
  isTerminalState,
  getAllowedTransitions,
  TERMINAL_STATES,
} from "../shared/rentalStateMachine";

describe("Rental State Machine (shared module)", () => {
  describe("RENTAL_VALID_TRANSITIONS structure", () => {
    it("has entries for pending, approved, active, overdue", () => {
      expect(Object.keys(RENTAL_VALID_TRANSITIONS)).toEqual(
        expect.arrayContaining(["pending", "approved", "active", "overdue"])
      );
    });

    it("does not have entries for terminal states", () => {
      expect(RENTAL_VALID_TRANSITIONS["completed"]).toBeUndefined();
      expect(RENTAL_VALID_TRANSITIONS["rejected"]).toBeUndefined();
      expect(RENTAL_VALID_TRANSITIONS["cancelled"]).toBeUndefined();
    });
  });

  describe("canTransition()", () => {
    it("pending → approved", () => expect(canTransition("pending", "approved")).toBe(true));
    it("pending → rejected", () => expect(canTransition("pending", "rejected")).toBe(true));
    it("pending → cancelled", () => expect(canTransition("pending", "cancelled")).toBe(true));
    it("approved → active", () => expect(canTransition("approved", "active")).toBe(true));
    it("approved → completed", () => expect(canTransition("approved", "completed")).toBe(true));
    it("approved → cancelled", () => expect(canTransition("approved", "cancelled")).toBe(true));
    it("active → completed", () => expect(canTransition("active", "completed")).toBe(true));
    it("active → overdue", () => expect(canTransition("active", "overdue")).toBe(true));
    it("overdue → completed", () => expect(canTransition("overdue", "completed")).toBe(true));
    it("overdue → cancelled", () => expect(canTransition("overdue", "cancelled")).toBe(true));
    it("overdue → active", () => expect(canTransition("overdue", "active")).toBe(true));
  });

  describe("invalid transitions", () => {
    it("completed is terminal", () => {
      expect(canTransition("completed", "active")).toBe(false);
      expect(canTransition("completed", "pending")).toBe(false);
    });

    it("rejected is terminal", () => {
      expect(canTransition("rejected", "pending")).toBe(false);
      expect(canTransition("rejected", "approved")).toBe(false);
    });

    it("cancelled is terminal", () => {
      expect(canTransition("cancelled", "pending")).toBe(false);
      expect(canTransition("cancelled", "active")).toBe(false);
    });

    it("cannot skip approval", () => {
      expect(canTransition("pending", "active")).toBe(false);
      expect(canTransition("pending", "completed")).toBe(false);
    });

    it("cannot go backwards", () => {
      expect(canTransition("active", "approved")).toBe(false);
      expect(canTransition("active", "pending")).toBe(false);
    });

    it("unknown status returns false", () => {
      expect(canTransition("nonexistent", "approved")).toBe(false);
    });
  });

  describe("isTerminalState()", () => {
    it("completed is terminal", () => expect(isTerminalState("completed")).toBe(true));
    it("cancelled is terminal", () => expect(isTerminalState("cancelled")).toBe(true));
    it("rejected is terminal", () => expect(isTerminalState("rejected")).toBe(true));
    it("pending is not terminal", () => expect(isTerminalState("pending")).toBe(false));
    it("active is not terminal", () => expect(isTerminalState("active")).toBe(false));
    it("approved is not terminal", () => expect(isTerminalState("approved")).toBe(false));
  });

  describe("getAllowedTransitions()", () => {
    it("returns correct transitions for pending", () => {
      expect(getAllowedTransitions("pending")).toEqual(["approved", "rejected", "cancelled"]);
    });

    it("returns correct transitions for active", () => {
      expect(getAllowedTransitions("active")).toEqual(["completed", "cancelled", "overdue"]);
    });

    it("returns empty array for terminal states", () => {
      expect(getAllowedTransitions("completed")).toEqual([]);
      expect(getAllowedTransitions("rejected")).toEqual([]);
    });

    it("returns empty array for unknown status", () => {
      expect(getAllowedTransitions("nonexistent")).toEqual([]);
    });
  });

  describe("TERMINAL_STATES", () => {
    it("contains exactly completed, cancelled, rejected", () => {
      expect([...TERMINAL_STATES]).toEqual(["completed", "cancelled", "rejected"]);
    });
  });
});
