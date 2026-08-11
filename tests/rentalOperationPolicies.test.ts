import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAllEnabledMock } = vi.hoisted(() => ({
  listAllEnabledMock: vi.fn(),
}));

vi.mock("../server/services/featureFlags", () => ({
  listAllEnabled: listAllEnabledMock,
}));

import {
  getRentalOperationPolicies,
  isSafetyFlagKey,
  shouldAutoCreateDispatch,
} from "../server/services/rentalOperationPolicies";

describe("rental operation policies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listAllEnabledMock.mockResolvedValue({});
  });

  it("uses safe defaults when rows are missing", async () => {
    await expect(getRentalOperationPolicies()).resolves.toEqual({
      dispatchWorkflow: false,
      dispatchInspectionRequired: false,
      returnInspectionRequired: true,
    });
  });

  it("uses safe defaults when the flag snapshot fails", async () => {
    listAllEnabledMock.mockRejectedValue(new Error("database unavailable"));

    await expect(getRentalOperationPolicies()).resolves.toEqual({
      dispatchWorkflow: false,
      dispatchInspectionRequired: false,
      returnInspectionRequired: true,
    });
  });

  it("maps explicit flag values without truthiness drift", async () => {
    listAllEnabledMock.mockResolvedValue({
      dispatch_workflow: true,
      dispatch_inspection_required: true,
      return_inspection_required: false,
    });

    await expect(getRentalOperationPolicies()).resolves.toEqual({
      dispatchWorkflow: true,
      dispatchInspectionRequired: true,
      returnInspectionRequired: false,
    });
    expect(listAllEnabledMock).toHaveBeenCalledTimes(1);
  });

  it("identifies the rental and billing safety flags", () => {
    expect(isSafetyFlagKey("dispatch_workflow")).toBe(true);
    expect(isSafetyFlagKey("dispatch_inspection_required")).toBe(true);
    expect(isSafetyFlagKey("return_inspection_required")).toBe(true);
    expect(isSafetyFlagKey("rolling_renewal_operations")).toBe(true);
    expect(isSafetyFlagKey("confirm_dialog")).toBe(false);
  });

  it("auto-creates dispatch only for enabled transported rentals", () => {
    expect(shouldAutoCreateDispatch(false, "delivery")).toBe(false);
    expect(shouldAutoCreateDispatch(true, "pickup")).toBe(false);
    expect(shouldAutoCreateDispatch(true, "delivery")).toBe(true);
    expect(shouldAutoCreateDispatch(true, "delivery_and_return")).toBe(true);
  });
});
