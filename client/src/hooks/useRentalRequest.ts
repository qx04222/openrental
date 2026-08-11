import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { calculateRentalPrice, calculateDaysBetween } from "@/lib/pricing";
import type { DeliveryMethod, InsuranceType, CostEstimate } from "../../../shared/rentalTypes";
import { INSURANCE_OPTIONS } from "../../../shared/insurance";
import { calculateOrderDeposit } from "../../../shared/deposit";

interface UseRentalRequestProps {
  fleetId: number;
  /** Whole pool for the group — used for availability check. Defaults to [fleetId]. */
  fleetIdPool?: number[];
}

export function useRentalRequest({ fleetId, fleetIdPool }: UseRentalRequestProps) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod>("pickup");
  const [insuranceType, setInsuranceType] = useState<InsuranceType>("none");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryProvince, setDeliveryProvince] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerCompany, setCustomerCompany] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [scheduledDeliveryTime, setScheduledDeliveryTime] = useState("");
  const [pickupWarehouseId, setPickupWarehouseId] = useState<number | undefined>();

  const [costEstimate, setCostEstimate] = useState<CostEstimate | null>(null);
  const [freightLoading, setFreightLoading] = useState(false);
  const [currentFreightCost, setCurrentFreightCost] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Fetch fleet data
  const { data: equipment } = trpc.rentalFleet.getAvailable.useQuery();
  const equipmentItem = equipment?.find((e) => e.rental_fleet.id === fleetId);
  const fleet = equipmentItem?.rental_fleet;

  // Fetch warehouses for pickup (public endpoint — no auth required)
  const { data: warehouses } = trpc.warehouses.listPublic.useQuery(undefined, {
    enabled: deliveryMethod === "pickup",
  });

  // Availability check — group-aware: passes the whole pool so any free unit
  // marks the group as available
  const poolIds = fleetIdPool && fleetIdPool.length > 0 ? fleetIdPool : [fleetId];
  const { data: availability } = trpc.rentals.checkAvailability.useQuery(
    { rentalFleetIds: poolIds, startDate, endDate },
    { enabled: !!(startDate && endDate && poolIds.length > 0) }
  );

  // Insurance options from settings
  const { data: insuranceOptions } = trpc.rentalSettings.getInsuranceOptions.useQuery();

  // Deposit
  const { data: depositData } = trpc.rentalSettings.calculateDepositForFleet.useQuery(
    { rentalFleetId: fleetId },
    { enabled: !!fleetId }
  );

  // --- Fix Issue 2: Fetch all tax rates upfront instead of hardcoding ---
  const { data: taxRatesData } = trpc.rentalSettings.getTaxRates.useQuery();

  // Build a lookup map: province code -> combined tax rate + breakdown label
  const taxRateLookup = useMemo(() => {
    const map = new Map<string, { rate: number; breakdown: string }>();
    if (taxRatesData) {
      for (const tr of taxRatesData) {
        if (tr.hstRate > 0) {
          map.set(tr.province, {
            rate: tr.hstRate,
            breakdown: `HST ${(tr.hstRate * 100).toFixed(2)}%`,
          });
        } else {
          const combined = tr.gstRate + tr.pstRate;
          let breakdown = "";
          if (tr.gstRate > 0 && tr.pstRate > 0) {
            breakdown = `GST ${(tr.gstRate * 100).toFixed(2)}% + PST ${(tr.pstRate * 100).toFixed(2)}%`;
          } else if (tr.gstRate > 0) {
            breakdown = `GST ${(tr.gstRate * 100).toFixed(2)}%`;
          } else if (tr.pstRate > 0) {
            breakdown = `PST ${(tr.pstRate * 100).toFixed(2)}%`;
          } else {
            breakdown = "No tax";
          }
          map.set(tr.province, { rate: combined, breakdown });
        }
      }
    }
    return map;
  }, [taxRatesData]);

  // --- Fix Issue 1: tRPC client for shipping fallback ---
  const trpcUtils = trpc.useUtils();

  // Recalculate costs when inputs change
  const recalculate = useCallback(
    (freightCost: number) => {
      if (!fleet || !startDate || !endDate) {
        setCostEstimate(null);
        return;
      }

      const days = calculateDaysBetween(new Date(startDate), new Date(endDate));
      // Use resolved rates (fleet override → category → none)
      const resolvedDaily = equipmentItem?.resolvedDailyRate;
      const resolvedWeekly = equipmentItem?.resolvedWeeklyRate;
      const resolvedMonthly = equipmentItem?.resolvedMonthlyRate;
      const daily = parseFloat(resolvedDaily || fleet.dailyRate || "0");
      const weekly = parseFloat(resolvedWeekly || fleet.weeklyRate || "0");
      const monthly = parseFloat(resolvedMonthly || fleet.monthlyRate || "0");

      const rentalResult = calculateRentalPrice(days, daily, weekly || daily * 5, monthly || daily * 20);
      const rentalFee = rentalResult.total;

      // Insurance
      const insRate = insuranceOptions
        ? (insuranceOptions as Record<string, { costPercentage?: number }>)[insuranceType]?.costPercentage || 0
        : (INSURANCE_OPTIONS[insuranceType]?.costPercentage || 0);
      const insuranceCost = Math.round(rentalFee * insRate * 100) / 100;

      // Tax province: delivery -> use delivery province, pickup -> use ON (default)
      const taxProv = deliveryMethod !== "pickup" && deliveryProvince ? deliveryProvince : "ON";

      // Tax calculation using fetched rates (fallback: 13% Ontario HST)
      const taxInfo = taxRateLookup.get(taxProv);
      const taxRate = taxInfo ? taxInfo.rate : 0.13;
      const taxBreakdown = taxInfo ? taxInfo.breakdown : "HST 13.00%";

      const taxBase = rentalFee + freightCost + insuranceCost;
      const taxAmount = Math.round(taxBase * taxRate * 100) / 100;

      const subtotal = rentalFee + freightCost + insuranceCost;
      // Billed total excludes the refundable deposit (held liability, not revenue).
      const totalAmount = subtotal + taxAmount;

      // Deposit: 1.5× after-tax (rent+insurance+freight), rounded up to $50.
      // Public/self-serve customers have no credit limit on file → not waived.
      const depositAmount = calculateOrderDeposit(subtotal + taxAmount);

      setCostEstimate({
        rentalFee,
        rentalBreakdown: rentalResult.breakdown,
        freightCost,
        insuranceCost,
        taxAmount,
        taxBreakdown,
        depositAmount,
        subtotal,
        totalAmount,
      });
    },
    [fleet, startDate, endDate, insuranceType, deliveryMethod, deliveryProvince, insuranceOptions, taxRateLookup]
  );

  // Debounced freight calculation when delivery address/method changes
  useEffect(() => {
    if (deliveryMethod === "pickup") {
      setCurrentFreightCost(0);
      setFreightLoading(false);
      recalculate(0);
      return;
    }

    if (!deliveryAddress || !fleet) {
      setCurrentFreightCost(0);
      setFreightLoading(false);
      recalculate(0);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    setFreightLoading(true);

    debounceRef.current = setTimeout(async () => {
      try {
        // Call the real shipping fallback API
        const result = await trpcUtils.shipping.calculateCostFallback.fetch({
          rentalFleetId: fleetId,
          deliveryMethod,
        });
        const cost = result.totalCost;
        setCurrentFreightCost(cost);
        recalculate(cost);
      } catch {
        // If the API call fails, fall back to $150 per trip
        const fallback = deliveryMethod === "delivery_and_return" ? 300 : 150;
        setCurrentFreightCost(fallback);
        recalculate(fallback);
      } finally {
        setFreightLoading(false);
      }
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };

  }, [deliveryMethod, fleet, fleetId, recalculate, trpcUtils]);

  // Recalculate on other input changes (insurance, dates, tax rates)
  useEffect(() => {
    if (deliveryMethod === "pickup") {
      recalculate(0);
    } else {
      recalculate(currentFreightCost);
    }
  }, [startDate, endDate, insuranceType, taxRateLookup, recalculate, currentFreightCost, deliveryMethod]);

  const createRental = trpc.rentals.create.useMutation();

  const submit = async (overrideFleetId?: number, extras?: { customerEquipmentNote?: string; compatibilityAcknowledgedAt?: string }) => {
    return createRental.mutateAsync({
      rentalFleetId: overrideFleetId ?? fleetId,
      customerName,
      customerEmail: customerEmail || undefined,
      customerPhone: customerPhone || undefined,
      customerCompany: customerCompany || undefined,
      startDate,
      endDate,
      deliveryMethod: deliveryMethod,
      deliveryAddress: deliveryAddress || undefined,
      deliveryProvince: deliveryProvince || undefined,
      taxProvince: deliveryMethod !== "pickup" && deliveryProvince ? deliveryProvince : "ON",
      insuranceType: insuranceType,
      insuranceCost: costEstimate?.insuranceCost?.toString(),
      freightCost: costEstimate?.freightCost?.toString(),
      taxAmount: costEstimate?.taxAmount?.toString(),
      taxBreakdown: costEstimate?.taxBreakdown,
      rentalFee: costEstimate?.rentalFee?.toString(),
      depositAmount: costEstimate?.depositAmount?.toString(),
      totalAmount: costEstimate?.totalAmount?.toString(),
      projectDescription: projectDescription || undefined,
      customerNotes: customerNotes || undefined,
      referralCode: referralCode || undefined,
      scheduledDeliveryTime: scheduledDeliveryTime || undefined,
      customerEquipmentNote: extras?.customerEquipmentNote,
      compatibilityAcknowledgedAt: extras?.compatibilityAcknowledgedAt,
    });
  };

  // Resolved rates for display in sidebar
  const resolvedRates = {
    dailyRate: equipmentItem?.resolvedDailyRate || fleet?.dailyRate || null,
    weeklyRate: equipmentItem?.resolvedWeeklyRate || fleet?.weeklyRate || null,
    monthlyRate: equipmentItem?.resolvedMonthlyRate || fleet?.monthlyRate || null,
  };

  return {
    // State
    startDate, setStartDate,
    endDate, setEndDate,
    deliveryMethod, setDeliveryMethod,
    insuranceType, setInsuranceType,
    deliveryAddress, setDeliveryAddress,
    deliveryProvince, setDeliveryProvince,
    customerName, setCustomerName,
    customerEmail, setCustomerEmail,
    customerPhone, setCustomerPhone,
    customerCompany, setCustomerCompany,
    projectDescription, setProjectDescription,
    customerNotes, setCustomerNotes,
    referralCode, setReferralCode,
    scheduledDeliveryTime, setScheduledDeliveryTime,
    pickupWarehouseId, setPickupWarehouseId,
    // Data
    fleet,
    resolvedRates,
    warehouses,
    availability,
    costEstimate,
    freightLoading,
    depositData,
    // Actions
    submit,
    isSubmitting: createRental.isPending,
    submitError: createRental.error,
  };
}
