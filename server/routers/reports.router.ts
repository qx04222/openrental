import { z } from "zod";
import { router, protectedProcedure, moduleGuard } from "../_core/trpc";
import { getDb, sql } from "../db";
import { computeAssetEconomics } from "../services/assetEconomics";
import { buildFinancingScenarios, classifyIdleTier, type FinancingUnit } from "../services/financingPlan";
import { getRentalOperationPolicies } from "../services/rentalOperationPolicies";
import { getInternalWorkQueue } from "../services/internalWorkQueue";
import { CUSTOMER_INDUSTRIES, customerIndustrySchema } from "../../shared/customerClassification";
import { APP_TIMEZONE_SQL } from "../_core/dateUtils";

// Straight-line depreciation policy defaults; admin-tunable via rental_settings
// keys depreciation_useful_life_years / depreciation_salvage_pct.
const DEPRECIATION_USEFUL_LIFE_YEARS_DEFAULT = 7;
const DEPRECIATION_SALVAGE_PCT_DEFAULT = 0.1;

async function loadDepreciationPolicy(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
): Promise<{ usefulLifeYears: number; salvagePct: number }> {
  try {
    const rows: Record<string, unknown>[] = await db.execute(sql`
      SELECT key, value FROM rental_settings
      WHERE key IN ('depreciation_useful_life_years', 'depreciation_salvage_pct')
    `);
    const map = new Map(rows.map((r) => [String(r.key), String(r.value)]));
    const life = parseFloat(map.get("depreciation_useful_life_years") || "");
    // Stored as an integer percent (0–99), consistent with the other
    // rental_rules percent settings (e.g. overtime_rate_percent="150").
    const salvagePctInt = parseFloat(map.get("depreciation_salvage_pct") || "");
    return {
      usefulLifeYears: Number.isFinite(life) && life > 0 ? life : DEPRECIATION_USEFUL_LIFE_YEARS_DEFAULT,
      salvagePct:
        Number.isFinite(salvagePctInt) && salvagePctInt >= 0 && salvagePctInt < 100
          ? salvagePctInt / 100
          : DEPRECIATION_SALVAGE_PCT_DEFAULT,
    };
  } catch {
    return {
      usefulLifeYears: DEPRECIATION_USEFUL_LIFE_YEARS_DEFAULT,
      salvagePct: DEPRECIATION_SALVAGE_PCT_DEFAULT,
    };
  }
}

// Configurable 0%-interest financing terms (months), admin-tunable via
// rental_settings key financing_term_months (e.g. "36,48"). Seeded by sql/136.
const FINANCING_TERMS_DEFAULT = [36, 48];

async function loadFinancingPolicy(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
): Promise<{ termsMonths: number[] }> {
  try {
    const rows: Record<string, unknown>[] = await db.execute(sql`
      SELECT value FROM rental_settings WHERE key = 'financing_term_months' LIMIT 1
    `);
    const raw = rows[0]?.value ? String(rows[0].value) : "";
    const parsed = raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
    return { termsMonths: parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => a - b) : FINANCING_TERMS_DEFAULT };
  } catch {
    return { termsMonths: FINANCING_TERMS_DEFAULT };
  }
}

// A date string that must actually parse to a valid date — rejects garbage like
// "not-a-date" with a 400 BAD_REQUEST instead of letting an Invalid Date reach
// the SQL layer and blow up as a 500.
const validDateString = z
  .string()
  .max(30)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "Invalid date string" });

// Shared date range input
const dateRangeInput = z.object({
  startDate: z.string().max(30).optional(),
  endDate: z.string().max(30).optional(),
}).optional();

// Finance reports accept the date range plus a few slicing dimensions. Numeric
// ids are int-validated (safe to interpolate); category is restricted to a
// charset that still excludes the single quote, so it can never break out of
// the quoted SQL literal. Real category names include parentheses and commas
// (e.g. "SKID-STEER LOADER (0.59 QBY)", "Compact Track Loader, 1000 lbs") —
// these MUST be allowed or the whole finance request 400s on category filter.
const SAFE_CATEGORY = /^[A-Za-z0-9 _\-/&.,()]+$/;
const financeFilterInput = z.object({
  startDate: z.string().max(30).optional(),
  endDate: z.string().max(30).optional(),
  customerId: z.number().int().positive().optional(),
  locationId: z.number().int().positive().optional(),
  category: z.string().max(60).regex(SAFE_CATEGORY).optional(),
  equipmentModelId: z.number().int().positive().optional(),
  // Customer-industry slicer. The zod enum is the safety guarantee: only the
  // seven fixed vocabulary values can reach the interpolated SQL literal.
  industry: customerIndustrySchema.optional(),
}).optional();

type FinanceFilters = {
  startDate?: string;
  endDate?: string;
  customerId?: number;
  locationId?: number;
  category?: string;
  equipmentModelId?: number;
  industry?: string;
};

function buildDateFilter(input: { startDate?: string; endDate?: string } | undefined, dateColumn: string) {
  // Re-serialize each bound to a canonical ISO timestamp before interpolation.
  // Date.toISOString() can only ever emit [0-9T:.Z+-], so no user-supplied
  // string can break out of the quoted literal — this closes the SQL-injection
  // hole and drops unparseable dates instead of 500-ing on them. dateColumn is
  // always a hardcoded literal at the call sites, never user input.
  const parts: string[] = [];
  const start = input?.startDate ? new Date(input.startDate) : null;
  const end = input?.endDate ? new Date(input.endDate) : null;
  if (start && !Number.isNaN(start.getTime())) {
    parts.push(`"${dateColumn}" >= '${start.toISOString()}'::timestamp`);
  }
  if (end && !Number.isNaN(end.getTime())) {
    parts.push(`"${dateColumn}" <= '${end.toISOString()}'::timestamp`);
  }
  return parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "";
}

// Builds the full ` AND ...` clause for the finance endpoints: the same
// canonical-ISO date hardening as buildDateFilter, plus customer / warehouse /
// category slicers. `table` is the (hardcoded) FROM table the WHERE lives in.
// Warehouse + category are applied via an EXISTS against rental_fleet so we
// never have to touch the query's FROM/JOIN — only valid when the rows carry a
// "rentalFleetId" (i.e. table = 'rental_requests'). All interpolated values are
// either Date.toISOString() output, zod-validated integers, or a charset-
// restricted category, so none can break out of the SQL literal.
function buildFilters(input: FinanceFilters | undefined, dateColumn: string, table = "rental_requests", dateExpr?: string) {
  const parts: string[] = [];
  // dateExpr lets callers pass an already-qualified date column (e.g. `rr."createdAt"`)
  // for queries with JOINs where an unqualified column would be ambiguous.
  const dcol = dateExpr ?? `"${dateColumn}"`;
  const start = input?.startDate ? new Date(input.startDate) : null;
  const end = input?.endDate ? new Date(input.endDate) : null;
  if (start && !Number.isNaN(start.getTime())) {
    parts.push(`${dcol} >= '${start.toISOString()}'::timestamp`);
  }
  if (end && !Number.isNaN(end.getTime())) {
    parts.push(`${dcol} <= '${end.toISOString()}'::timestamp`);
  }
  if (typeof input?.customerId === "number" && Number.isInteger(input.customerId)) {
    parts.push(`${table}."customerId" = ${input.customerId}`);
  }
  if (input?.industry && (CUSTOMER_INDUSTRIES as readonly string[]).includes(input.industry)) {
    // Both anchor tables carry customerId, so one EXISTS covers rental_requests
    // and invoices alike. The includes() re-check keeps this safe even if a
    // future caller bypasses the zod input.
    // Primary OR secondary: "show me landscaping" means anyone in that trade,
    // not only those whose MAIN trade it is. The revenue-by-industry report is
    // different — it groups by primary only, so each dollar lands exactly once.
    parts.push(
      `EXISTS (SELECT 1 FROM customers ic WHERE ic.id = ${table}."customerId"`
      + ` AND (ic.industry = '${input.industry}' OR '${input.industry}' = ANY(ic."secondaryIndustries")))`,
    );
  }
  if (table !== "invoices") {
    if (typeof input?.locationId === "number" && Number.isInteger(input.locationId)) {
      parts.push(
        `EXISTS (SELECT 1 FROM rental_fleet f WHERE f.id = ${table}."rentalFleetId" AND f."locationId" = ${input.locationId})`,
      );
    }
    if (input?.category && SAFE_CATEGORY.test(input.category)) {
      // Category lives on the assigned fleet asset OR — for model-booked /
      // not-yet-assigned rentals (≈half of them) — on the equipment model.
      // Match either source so revenue isn't silently dropped.
      parts.push(
        `(EXISTS (SELECT 1 FROM rental_fleet f WHERE f.id = ${table}."rentalFleetId" AND f.category = '${input.category}')`
        + ` OR EXISTS (SELECT 1 FROM equipment_models em WHERE em.id = ${table}."equipmentModelId" AND em.category = '${input.category}'))`,
      );
    }
    if (typeof input?.equipmentModelId === "number" && Number.isInteger(input.equipmentModelId)) {
      // Match the order's own model OR the assigned fleet asset's model.
      parts.push(
        `(${table}."equipmentModelId" = ${input.equipmentModelId}`
        + ` OR EXISTS (SELECT 1 FROM rental_fleet f WHERE f.id = ${table}."rentalFleetId" AND f."equipmentModelId" = ${input.equipmentModelId}))`,
      );
    }
  }
  if (table === "invoices") {
    // Invoices carry no fleet/model link directly; reach category through the
    // originating rental (invoices.rentalId -> rental_requests -> fleet/model).
    if (input?.category && SAFE_CATEGORY.test(input.category)) {
      parts.push(
        `EXISTS (SELECT 1 FROM rental_requests r`
        + ` LEFT JOIN rental_fleet f ON f.id = r."rentalFleetId" AND f."deletedAt" IS NULL`
        + ` LEFT JOIN equipment_models em ON em.id = r."equipmentModelId" AND em."deletedAt" IS NULL`
        + ` WHERE r.id = invoices."rentalId" AND COALESCE(f.category, em.category) = '${input.category}')`,
      );
    }
    if (typeof input?.equipmentModelId === "number" && Number.isInteger(input.equipmentModelId)) {
      parts.push(
        `EXISTS (SELECT 1 FROM rental_requests r`
        + ` LEFT JOIN rental_fleet f ON f.id = r."rentalFleetId" AND f."deletedAt" IS NULL`
        + ` WHERE r.id = invoices."rentalId" AND (r."equipmentModelId" = ${input.equipmentModelId} OR f."equipmentModelId" = ${input.equipmentModelId}))`,
      );
    }
  }
  return parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "";
}

// Per-order extra charges (fuel / damage / cleaning / …) with tax — the revenue
// that `rental_requests.totalAmount` silently drops because extras live in
// `damage_claims` and only get folded into the customer's bill at invoice time.
// Finance reports historically summed totalAmount alone and so understated
// revenue / AR. This CTE recomputes the extras the SAME way as orderCharges.ts
// and invoiceGenerator: only `accepted` (billed-pending) or `invoiced` charges
// count; the tax replicates calculateTax's combined province rate (HST, else
// GST+PST) with the Ontario-13% fallback for an unknown/missing active rate. The
// province resolves to taxProvince, else deliveryProvince, else ON — extras are
// never silently untaxed for a missing taxProvince. Exposed as `order_extras(rid,
// extra_subtotal, extra_tax)`; LEFT JOIN as `oe` and add EXTRA_TOTAL_EXPR.
const ORDER_EXTRAS_CTE = `order_extras AS (
  SELECT
    dc."rentalId" AS rid,
    ROUND(SUM(GREATEST(COALESCE(dc."approvedAmount", dc.amount, dc."repairEstimate", 0)::numeric, 0)), 2) AS extra_subtotal,
    ROUND(
      ROUND(SUM(GREATEST(COALESCE(dc."approvedAmount", dc.amount, dc."repairEstimate", 0)::numeric, 0)), 2)
      * CASE
          WHEN tr.province IS NULL THEN 0.13
          WHEN tr."hstRate"::numeric > 0 THEN tr."hstRate"::numeric
          ELSE COALESCE(tr."gstRate"::numeric, 0) + COALESCE(tr."pstRate"::numeric, 0)
        END,
      2
    ) AS extra_tax
  FROM damage_claims dc
  JOIN rental_requests rr ON rr.id = dc."rentalId"
  -- Fall back to delivery province / ON when taxProvince is missing, so extras are
  -- never silently untaxed (matches orderCharges + invoiceGenerator).
  LEFT JOIN tax_rates tr ON tr.province = UPPER(COALESCE(rr."taxProvince", rr."deliveryProvince", 'ON')) AND tr."isActive" = true
  -- Soft-deleted charges must drop out of revenue/AR the moment they are removed,
  -- otherwise a charge the operator deleted keeps being reported as income
  -- forever (matches the isNull filter in orderCharges + invoiceGenerator).
  WHERE dc.status IN ('accepted', 'invoiced') AND dc."rentalId" IS NOT NULL
    AND dc."deletedAt" IS NULL
  GROUP BY dc."rentalId", tr.province, tr."hstRate", tr."gstRate", tr."pstRate"
)`;
// Pre-tax extras + their tax, NULL-safe (no extras → 0). Requires `order_extras`
// LEFT JOINed as `oe`.
const EXTRA_TOTAL_EXPR = `(COALESCE(oe.extra_subtotal, 0) + COALESCE(oe.extra_tax, 0))`;

export const reportsRouter = router({
  /**
   * Revenue grouped by month for the last 12 months.
   * Returns { month: string, revenue: number }[]
   */
  revenueByMonth: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];

    const df = buildFilters(input, "createdAt");
    // Default to the trailing 12 months only when no explicit date range is set.
    const window = input?.startDate
      ? ""
      : ` AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}) >= date_trunc('month', now() AT TIME ZONE ${APP_TIMEZONE_SQL}) - INTERVAL '11 months'`;
    const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
      WITH ${ORDER_EXTRAS_CTE}
      SELECT
        to_char(date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})), 'YYYY-MM') AS month,
        COALESCE(SUM("totalAmount"::numeric + ${EXTRA_TOTAL_EXPR}), 0) AS revenue
      FROM rental_requests
      LEFT JOIN order_extras oe ON oe.rid = rental_requests.id
      WHERE status IN ('active', 'completed')
        AND "deletedAt" IS NULL${df}${window}
      GROUP BY date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))
      ORDER BY date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})) ASC
    `));

    return rows.map((r) => ({
      month: String(r.month),
      revenue: Number(r.revenue),
    }));
  }),

  /**
   * Per-asset utilization dashboard with selectable date range and warehouse filter.
   * Returns per-asset rented/idle/maintenance days plus aggregate summaries.
   */
  utilizationByFleet: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(z.object({
      startDate: validDateString.optional(),
      endDate: validDateString.optional(),
      warehouseId: z.number().int().optional(),
      includeExcluded: z.boolean().optional(),
    }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { assets: [], averageUtilizationPct: 0, byCategory: [], topIdle: [], topMaintenance: [], excludedFleetIds: [] };

      // Resolve window boundaries (default: last 30 days → today)
      const windowEnd = input?.endDate ? new Date(input.endDate) : new Date();
      const windowStart = input?.startDate
        ? new Date(input.startDate)
        : new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

      const totalDays = Math.max(
        1,
        Math.round((windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24)),
      );

      // Interpolate ISO strings, not raw Date objects: under postgres-js
      // prepare:false a Date param throws ERR_INVALID_ARG_TYPE before the
      // ::timestamptz cast ever runs. ISO strings cast cleanly.
      const windowStartIso = windowStart.toISOString();
      const windowEndIso = windowEnd.toISOString();

      // Build parameterized queries using gte/lte helpers and sql tagged template
      const warehouseFilter = input?.warehouseId != null
        ? sql` AND rf."locationId" = ${input.warehouseId}`
        : sql``;

      // Rented days: sum overlap between each rental and the window
      const rentedRows: Record<string, unknown>[] = await db.execute(sql`
        SELECT
          rf.id                                             AS "fleetId",
          rf."assetNumber",
          rf.brand,
          rf.model,
          rf."currentStatus"                                AS "currentStatus",
          COALESCE(rf.category, em.category)                AS "category",
          w.name                                            AS "warehouseName",
          COALESCE(
            SUM(
              -- Guard the LEFT JOIN's non-matching rows: with no rental, rr dates
              -- are NULL and LEAST/GREATEST silently ignore NULLs, so the overlap
              -- collapses to (windowEnd - windowStart) = the whole window → a
              -- bogus 100%. Force such rows to contribute 0.
              CASE WHEN rr."startDate" IS NULL THEN 0 ELSE GREATEST(
                0,
                EXTRACT(EPOCH FROM (
                  LEAST(rr."endDate"::timestamptz, ${windowEndIso}::timestamptz)
                  - GREATEST(rr."startDate"::timestamptz, ${windowStartIso}::timestamptz)
                )) / 86400
              ) END
            ),
            0
          )::numeric(10,2)                                  AS "rentedDays"
        FROM rental_fleet rf
        LEFT JOIN warehouses w
          ON w.id = rf."locationId" AND w."deletedAt" IS NULL
        LEFT JOIN equipment_models em
          ON em.id = rf."equipmentModelId" AND em."deletedAt" IS NULL
        LEFT JOIN rental_requests rr
          ON rr."rentalFleetId" = rf.id
          AND rr.status IN ('active', 'completed', 'approved')
          AND rr."deletedAt" IS NULL
          AND rr."endDate"   >= ${windowStartIso}::timestamptz
          AND rr."startDate" <= ${windowEndIso}::timestamptz
        WHERE rf."deletedAt" IS NULL${warehouseFilter}
        GROUP BY rf.id, rf."assetNumber", rf.brand, rf.model, rf."currentStatus", rf.category, em.category, w.name
        ORDER BY rf.id
      `);

      // Multi-item occupancy: orders whose equipment lives in rental_line_items
      // carry rr."rentalFleetId" = NULL, so the rented-days query above misses
      // them entirely. Sum each line item's window overlap separately, keyed by
      // li."rentalFleetId", and merge into rentedDays below. Restricting to
      // rr."rentalFleetId" IS NULL guarantees single-asset orders (counted above)
      // aren't double-counted here. Line-item dates fall back to the order's.
      const lineItemRentedRows: Record<string, unknown>[] = await db.execute(sql`
        SELECT
          li."rentalFleetId"                                AS "fleetId",
          COALESCE(
            SUM(
              GREATEST(0, EXTRACT(EPOCH FROM (
                LEAST(COALESCE(li."endDate", rr."endDate")::timestamptz, ${windowEndIso}::timestamptz)
                - GREATEST(COALESCE(li."startDate", rr."startDate")::timestamptz, ${windowStartIso}::timestamptz)
              )) / 86400)
            ),
            0
          )::numeric(10,2)                                  AS "rentedDays"
        FROM rental_line_items li
        JOIN rental_requests rr
          ON rr.id = li."rentalRequestId"
          AND rr.status IN ('active', 'completed', 'approved')
          AND rr."deletedAt" IS NULL
          AND rr."rentalFleetId" IS NULL
        JOIN rental_fleet rf
          ON rf.id = li."rentalFleetId" AND rf."deletedAt" IS NULL
        WHERE li."deletedAt" IS NULL
          AND li."rentalFleetId" IS NOT NULL
          AND COALESCE(li."endDate", rr."endDate")   >= ${windowStartIso}::timestamptz
          AND COALESCE(li."startDate", rr."startDate") <= ${windowEndIso}::timestamptz${warehouseFilter}
        GROUP BY li."rentalFleetId"
      `);

      const lineItemRentedMap = new Map<number, number>();
      for (const row of lineItemRentedRows) {
        lineItemRentedMap.set(Number(row.fleetId), Number(row.rentedDays));
      }

      // Maintenance days: sum overlap from downtime_records
      const maintenanceRows: Record<string, unknown>[] = await db.execute(sql`
        SELECT
          rf.id                                             AS "fleetId",
          COALESCE(
            SUM(
              -- Same NULL-join guard as the rented-days query: a fleet asset with
              -- no downtime record must contribute 0, not the whole window.
              CASE WHEN dr."reportedAt" IS NULL THEN 0 ELSE GREATEST(
                0,
                EXTRACT(EPOCH FROM (
                  LEAST(
                    COALESCE(dr."resolvedAt"::timestamptz, ${windowEndIso}::timestamptz),
                    ${windowEndIso}::timestamptz
                  )
                  - GREATEST(dr."reportedAt"::timestamptz, ${windowStartIso}::timestamptz)
                )) / 86400
              ) END
            ),
            0
          )::numeric(10,2)                                  AS "maintenanceDays"
        FROM rental_fleet rf
        LEFT JOIN downtime_records dr
          ON dr."rentalFleetId" = rf.id
          AND dr."resolvedAt"   IS NOT NULL
          AND dr."resolvedAt"   >= ${windowStartIso}::timestamptz
          AND dr."reportedAt"   <= ${windowEndIso}::timestamptz
        WHERE rf."deletedAt" IS NULL${warehouseFilter}
        GROUP BY rf.id
        ORDER BY rf.id
      `);

      // Merge results
      const maintenanceMap = new Map<number, number>();
      for (const row of maintenanceRows) {
        maintenanceMap.set(Number(row.fleetId), Math.min(Number(row.maintenanceDays), totalDays));
      }

      const assets = rentedRows.map((row) => {
        const fleetId = Number(row.fleetId);
        const rentedDays = Math.min(
          Number(row.rentedDays) + (lineItemRentedMap.get(fleetId) ?? 0),
          totalDays,
        );
        const maintenanceDays = Math.min(maintenanceMap.get(fleetId) ?? 0, totalDays - rentedDays);
        const idleDays = Math.max(0, totalDays - rentedDays - maintenanceDays);
        const utilizationPct = totalDays > 0
          ? Math.round((rentedDays / totalDays) * 100 * 10) / 10
          : 0;
        return {
          fleetId,
          assetNumber: row.assetNumber ? String(row.assetNumber) : null,
          brand: String(row.brand),
          model: String(row.model),
          category: row.category ? String(row.category) : null,
          currentStatus: row.currentStatus ? String(row.currentStatus) : null,
          warehouseName: row.warehouseName ? String(row.warehouseName) : null,
          rentedDays: Math.round(rentedDays * 10) / 10,
          maintenanceDays: Math.round(maintenanceDays * 10) / 10,
          idleDays: Math.round(idleDays * 10) / 10,
          totalDays,
          utilizationPct,
        };
      });

      // Excluded assets: units that exist in the fleet list but aren't actually
      // rentable. Saved as a JSON array of fleet ids in rental_settings; they're
      // dropped from the utilization stats (so they don't drag the average down).
      let excludedFleetIds: number[] = [];
      try {
        const [ex]: Record<string, unknown>[] = await db.execute(
          sql`SELECT value FROM rental_settings WHERE key = 'utilization_excluded_fleet_ids' LIMIT 1`,
        );
        if (ex?.value) {
          const parsed = JSON.parse(String(ex.value));
          if (Array.isArray(parsed)) excludedFleetIds = parsed.map(Number).filter(Number.isFinite);
        }
      } catch { /* malformed setting → treat as none excluded */ }
      const excludedSet = new Set(excludedFleetIds);

      // A unit currently in maintenance isn't available to rent, so it's excluded
      // from the utilization average (same treatment as a manual exclusion) and
      // flagged for the UI, rather than counting as "idle, underutilized".
      const assetsAll = assets.map((a) => ({
        ...a,
        excluded: excludedSet.has(a.fleetId),
        inMaintenance: a.currentStatus === "maintenance",
      }));
      const effective = assetsAll.filter((a) => !a.excluded && !a.inMaintenance);

      const averageUtilizationPct = effective.length > 0
        ? Math.round(
            (effective.reduce((sum, a) => sum + a.utilizationPct, 0) / effective.length) * 10,
          ) / 10
        : 0;

      const sorted = [...effective].sort((a, b) => a.utilizationPct - b.utilizationPct);
      const topIdle = sorted
        .filter((a) => a.idleDays > 0)
        .slice(0, 10)
        .map(({ fleetId, assetNumber, brand, model, idleDays }) => ({ fleetId, assetNumber, brand, model, idleDays }));

      const topMaintenance = [...effective]
        .filter((a) => a.maintenanceDays > 0)
        .sort((a, b) => b.maintenanceDays - a.maintenanceDays)
        .slice(0, 10)
        .map(({ fleetId, assetNumber, brand, model, maintenanceDays }) => ({ fleetId, assetNumber, brand, model, maintenanceDays }));

      // Utilization grouped by pricing category — a highly-utilized category is a
      // signal to add more units of that type. Weighted (sum rented / sum
      // available days) over the counted assets only; maintenance/excluded units
      // are already dropped from `effective`.
      const catMap = new Map<string, { rentedDays: number; assetCount: number }>();
      for (const a of effective) {
        const key = a.category ?? "Uncategorized";
        const c = catMap.get(key) ?? { rentedDays: 0, assetCount: 0 };
        c.rentedDays += a.rentedDays;
        c.assetCount += 1;
        catMap.set(key, c);
      }
      const byCategory = [...catMap.entries()]
        .map(([category, c]) => ({
          category,
          assetCount: c.assetCount,
          rentedDays: Math.round(c.rentedDays * 10) / 10,
          utilizationPct: c.assetCount > 0
            ? Math.round((c.rentedDays / (c.assetCount * totalDays)) * 100 * 10) / 10
            : 0,
        }))
        .sort((a, b) => b.utilizationPct - a.utilizationPct);

      // includeExcluded → return every asset (with an `excluded` flag) for the
      // management UI; otherwise return only the counted (non-excluded) assets.
      return {
        assets: input?.includeExcluded ? assetsAll : effective,
        averageUtilizationPct,
        byCategory,
        topIdle,
        topMaintenance,
        excludedFleetIds,
      };
    }),

  /**
   * Season opening = the first rental order of the current year. Used as the
   * default start of the utilization window ("开季 → 今天"). Falls back to
   * Jan 1 of the current year when there are no orders yet this year.
   */
  seasonStart: protectedProcedure.use(moduleGuard('reports', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return { date: null as string | null };
    const [row]: Record<string, unknown>[] = await db.execute(sql`
      SELECT MIN("startDate") AS first
      FROM rental_requests
      WHERE "deletedAt" IS NULL
        AND date_part('year', "startDate") = date_part('year', now() AT TIME ZONE ${APP_TIMEZONE_SQL})
    `);
    const first = row?.first ? new Date(String(row.first)) : null;
    return { date: first && !Number.isNaN(first.getTime()) ? first.toISOString() : null };
  }),

  /**
   * Financing plan — fleet valuation + 0%-interest monthly-payment scenarios,
   * with per-unit idle-tier classification over a selectable window (the office
   * "设备总价与月供" + "月供方案对比" spreadsheets, made live).
   *
   * purchaseCost is the financed basis (Rental Company Financing, sql/135), so
   * monthly = total ÷ term, no interest. Window defaults to season-open (first
   * rental of the year) → today, matching the utilization report.
   */
  financingPlan: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(z.object({ startDate: validDateString.optional(), endDate: validDateString.optional() }).optional())
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        return { window: { start: null, end: null }, termsMonths: FINANCING_TERMS_DEFAULT,
          valuation: [], grandTotal: 0, units: [], tierTotals: { tier1: 0, tier2: 0 }, scenarios: [] };
      }

      const windowEnd = input?.endDate ? new Date(input.endDate) : new Date();
      let windowStart: Date;
      if (input?.startDate) {
        windowStart = new Date(input.startDate);
      } else {
        // Default window start = season open (first rental of the current year);
        // fall back to Jan 1 when there are no rentals yet this year.
        const [row]: Record<string, unknown>[] = await db.execute(sql`
          SELECT MIN("startDate") AS first FROM rental_requests
          WHERE "deletedAt" IS NULL
            AND date_part('year', "startDate") = date_part('year', now() AT TIME ZONE ${APP_TIMEZONE_SQL})`);
        const first = row?.first ? new Date(String(row.first)) : null;
        windowStart = first && !Number.isNaN(first.getTime())
          ? first
          : new Date(`${new Date().getFullYear()}-01-01T00:00:00.000Z`);
      }
      const windowStartIso = windowStart.toISOString();
      const windowEndIso = windowEnd.toISOString();

      // Per live unit: acquisition value + rented days & order count in the
      // window, merged across single-asset orders and multi-item line items
      // (the "双路径合并"). Same overlap math as utilizationByFleet.
      const rows: Record<string, unknown>[] = await db.execute(sql`
        WITH single AS (
          SELECT rr."rentalFleetId" AS fleet_id,
            COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
              LEAST(rr."endDate"::timestamptz, ${windowEndIso}::timestamptz)
              - GREATEST(rr."startDate"::timestamptz, ${windowStartIso}::timestamptz)
            )) / 86400)), 0) AS rented_days,
            COUNT(*) AS rental_count
          FROM rental_requests rr
          WHERE rr."rentalFleetId" IS NOT NULL
            AND rr.status IN ('active', 'completed', 'approved')
            AND rr."deletedAt" IS NULL
            AND rr."endDate"   >= ${windowStartIso}::timestamptz
            AND rr."startDate" <= ${windowEndIso}::timestamptz
          GROUP BY rr."rentalFleetId"
        ),
        multi AS (
          SELECT li."rentalFleetId" AS fleet_id,
            COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (
              LEAST(COALESCE(li."endDate", rr."endDate")::timestamptz, ${windowEndIso}::timestamptz)
              - GREATEST(COALESCE(li."startDate", rr."startDate")::timestamptz, ${windowStartIso}::timestamptz)
            )) / 86400)), 0) AS rented_days,
            COUNT(DISTINCT li."rentalRequestId") AS rental_count
          FROM rental_line_items li
          JOIN rental_requests rr ON rr.id = li."rentalRequestId"
            AND rr.status IN ('active', 'completed', 'approved')
            AND rr."deletedAt" IS NULL
            AND rr."rentalFleetId" IS NULL
          WHERE li."rentalFleetId" IS NOT NULL
            AND li."deletedAt" IS NULL
            AND COALESCE(li."endDate", rr."endDate")   >= ${windowStartIso}::timestamptz
            AND COALESCE(li."startDate", rr."startDate") <= ${windowEndIso}::timestamptz
          GROUP BY li."rentalFleetId"
        )
        SELECT
          rf.id                                AS "fleetId",
          rf."assetNumber",
          rf.model,
          COALESCE(rf.category, em.category)   AS category,
          rf."currentStatus"                   AS "currentStatus",
          rf."purchaseCost"::numeric           AS "purchaseCost",
          (COALESCE(s.rented_days, 0) + COALESCE(m.rented_days, 0))::numeric(10,2) AS "rentedDays",
          (COALESCE(s.rental_count, 0) + COALESCE(m.rental_count, 0))::int          AS "rentalCount"
        FROM rental_fleet rf
        LEFT JOIN equipment_models em ON em.id = rf."equipmentModelId" AND em."deletedAt" IS NULL
        LEFT JOIN single s ON s.fleet_id = rf.id
        LEFT JOIN multi  m ON m.fleet_id = rf.id
        WHERE rf."deletedAt" IS NULL
        ORDER BY rf.model, rf."assetNumber"
      `);

      const units = rows.map((r) => {
        const purchaseCost = r.purchaseCost != null ? Number(r.purchaseCost) : null;
        const rentedDays = Math.round(Number(r.rentedDays) * 10) / 10;
        const rentalCount = Number(r.rentalCount);
        const tier = classifyIdleTier({ rentedDays, rentalCount });
        return {
          fleetId: Number(r.fleetId),
          assetNumber: r.assetNumber ? String(r.assetNumber) : null,
          model: String(r.model),
          category: r.category ? String(r.category) : null,
          currentStatus: r.currentStatus ? String(r.currentStatus) : null,
          purchaseCost,
          rentedDays,
          rentalCount,
          tier,
        };
      });

      // Valuation grouped by model (qty × unit price = subtotal).
      const valMap = new Map<string, { category: string | null; qty: number; subtotal: number }>();
      for (const u of units) {
        const v = valMap.get(u.model) ?? { category: u.category, qty: 0, subtotal: 0 };
        v.qty += 1;
        v.subtotal += u.purchaseCost ?? 0;
        valMap.set(u.model, v);
      }
      const valuation = [...valMap.entries()]
        .map(([model, v]) => ({
          model,
          category: v.category,
          qty: v.qty,
          unitPrice: v.qty > 0 ? Math.round((v.subtotal / v.qty) * 100) / 100 : 0,
          subtotal: Math.round(v.subtotal * 100) / 100,
        }))
        .sort((a, b) => b.subtotal - a.subtotal);
      const grandTotal = Math.round(valuation.reduce((s, v) => s + v.subtotal, 0) * 100) / 100;

      const tierTotals = {
        tier1: Math.round(units.filter((u) => u.tier === "tier1").reduce((s, u) => s + (u.purchaseCost ?? 0), 0) * 100) / 100,
        tier2: Math.round(units.filter((u) => u.tier === "tier2").reduce((s, u) => s + (u.purchaseCost ?? 0), 0) * 100) / 100,
      };

      const policy = await loadFinancingPolicy(db);
      const scenarios = buildFinancingScenarios({
        units: units.map((u) => ({ purchaseCost: u.purchaseCost, tier: u.tier }) as FinancingUnit),
        termsMonths: policy.termsMonths,
      });

      return {
        window: { start: windowStartIso, end: windowEndIso },
        termsMonths: policy.termsMonths,
        valuation,
        grandTotal,
        units,
        tierTotals,
        scenarios,
      };
    }),

  /**
   * Net rental + insurance revenue grouped by rental START month (operating
   * basis — the office "月度收入" sheet). Differs from revenueByMonth (createdAt)
   * and revenueByMonthDetailed (invoice issue date): here a rental's revenue
   * lands in the month its rental period starts.
   */
  revenueByStartMonth: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const df = buildFilters(input, "startDate");
      const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
        SELECT
          to_char(date_trunc('month', (("startDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})), 'YYYY-MM') AS month,
          COALESCE(SUM("rentalFee"::numeric), 0) AS "rentalFee",
          COALESCE(SUM("insuranceCost"::numeric), 0) AS "insuranceCost",
          COALESCE(SUM("rentalFee"::numeric) + SUM("insuranceCost"::numeric), 0) AS total,
          COUNT(*)::int AS "orderCount"
        FROM rental_requests
        WHERE status IN ('active', 'completed', 'approved', 'overdue')
          AND "deletedAt" IS NULL${df}
        GROUP BY date_trunc('month', (("startDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))
        ORDER BY date_trunc('month', (("startDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})) ASC
      `));
      return rows.map((r) => ({
        month: String(r.month),
        rentalFee: Number(r.rentalFee),
        insuranceCost: Number(r.insuranceCost),
        total: Number(r.total),
        orderCount: Number(r.orderCount),
      }));
    }),

  /**
   * Revenue grouped by fleet category.
   */
  revenueByCategory: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];

    // Category resolves from the assigned fleet asset, falling back to the
    // equipment model for model-booked / unassigned rentals (otherwise ~half
    // of revenue lands in "Uncategorized").
    const df = buildFilters(input, "createdAt", "rr", `rr."createdAt"`);
    const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
      SELECT
        COALESCE(rf.category, em.category, 'Uncategorized') AS category,
        COALESCE(SUM(rr."totalAmount"::numeric), 0) AS revenue
      FROM rental_requests rr
      LEFT JOIN rental_fleet rf ON rf.id = rr."rentalFleetId" AND rf."deletedAt" IS NULL
      LEFT JOIN equipment_models em ON em.id = rr."equipmentModelId" AND em."deletedAt" IS NULL
      WHERE rr.status IN ('active', 'completed')
        AND rr."deletedAt" IS NULL${df}
      GROUP BY COALESCE(rf.category, em.category, 'Uncategorized')
      ORDER BY revenue DESC
    `));

    return rows.map((r) => ({
      category: String(r.category),
      revenue: Number(r.revenue),
    }));
  }),

  /**
   * Rental request counts grouped by status (funnel view).
   */
  orderStatusFunnel: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
    const db = await getDb();
    if (!db) return [];

    const df = buildFilters(input, "createdAt");
    const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
      SELECT
        status,
        COUNT(*)::int AS count
      FROM rental_requests
      WHERE "deletedAt" IS NULL${df}
      GROUP BY status
      ORDER BY
        CASE status
          WHEN 'pending' THEN 1
          WHEN 'approved' THEN 2
          WHEN 'active' THEN 3
          WHEN 'completed' THEN 4
          WHEN 'rejected' THEN 5
          WHEN 'cancelled' THEN 6
        END
    `));

    return rows.map((r) => ({
      status: String(r.status),
      count: Number(r.count),
    }));
  }),

  /**
   * High-level summary statistics for the dashboard header.
   */
  summaryStats: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
    const db = await getDb();
    if (!db) {
      return {
        totalRevenue: 0,
        totalRentals: 0,
        avgOrderValue: 0,
        activeRentals: 0,
        utilizationRate: 0,
      };
    }

    // `totalRevenue` is net rental income (rentalFee only), matching the
    // dashboard's hero figure — insurance/freight/tax/deposit are excluded.
    // `avgOrderValue` stays on billed totalAmount (average ticket size).
    const df = buildFilters(input, "createdAt");
    const [stats]: Record<string, unknown>[] = await db.execute(sql.raw(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('active', 'completed') THEN "rentalFee"::numeric ELSE 0 END), 0) AS "totalRevenue",
        COUNT(*)::int AS "totalRentals",
        COALESCE(
          AVG(CASE WHEN status IN ('active', 'completed') AND "totalAmount" IS NOT NULL THEN "totalAmount"::numeric END),
          0
        ) AS "avgOrderValue",
        COUNT(CASE WHEN status = 'active' THEN 1 END)::int AS "activeRentals"
      FROM rental_requests
      WHERE "deletedAt" IS NULL${df}
    `));

    // Denominator excludes maintenance/retired units — they aren't rentable, so
    // they shouldn't drag the utilization rate down (consistent with the
    // utilization report, which drops maintenance assets from its average).
    const [fleet]: Record<string, unknown>[] = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE "currentStatus" NOT IN ('retired', 'maintenance'))::int AS total,
        COUNT(*) FILTER (WHERE "currentStatus" = 'rented')::int AS rented
      FROM rental_fleet
      WHERE "deletedAt" IS NULL
    `);

    const totalFleet = Number(fleet?.total) || 0;
    const rentedFleet = Number(fleet?.rented) || 0;
    const utilizationRate = totalFleet > 0 ? Math.round((rentedFleet / totalFleet) * 100) : 0;

    return {
      totalRevenue: Number(stats?.totalRevenue) || 0,
      totalRentals: Number(stats?.totalRentals) || 0,
      avgOrderValue: Math.round((Number(stats?.avgOrderValue) || 0) * 100) / 100,
      activeRentals: Number(stats?.activeRentals) || 0,
      utilizationRate,
    };
  }),

  // ── Financial Reports ──────────────────────────────────────────

  /** Revenue breakdown by component (rental fee, freight, insurance, tax) */
  financialOverview: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const df = buildFilters(input, "createdAt");
      const [row]: Record<string, unknown>[] = await db.execute(sql.raw(`
        SELECT
          COALESCE(SUM("rentalFee"::numeric), 0) AS "rentalFee",
          COALESCE(SUM("freightCost"::numeric), 0) AS "freightCost",
          COALESCE(SUM("insuranceCost"::numeric), 0) AS "insuranceCost",
          COALESCE(SUM("taxAmount"::numeric), 0) AS "taxAmount",
          COALESCE(SUM("depositAmount"::numeric), 0) AS "depositAmount",
          COALESCE(SUM("totalAmount"::numeric), 0) AS "totalAmount"
        FROM rental_requests
        WHERE status IN ('active', 'completed') AND "deletedAt" IS NULL${df}
      `));
      return {
        rentalFee: Number(row?.rentalFee) || 0,
        freightCost: Number(row?.freightCost) || 0,
        insuranceCost: Number(row?.insuranceCost) || 0,
        taxAmount: Number(row?.taxAmount) || 0,
        depositAmount: Number(row?.depositAmount) || 0,
        totalAmount: Number(row?.totalAmount) || 0,
      };
    }),

  /**
   * Payment status distribution — derived from the prepayment ledger
   * (paid / partial / unpaid), NOT the stale paymentStatus column, so it agrees
   * with the AR / cash reports and reflects recorded collections.
   */
  paymentStatus: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const df = buildFilters(input, "createdAt");
      const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
        WITH pp AS (
          -- Only prepayments applied to rent count as paid — matches the invoice
          -- balance rule (invoiceGenerator uses appliedAt IS NOT NULL). Held /
          -- unapplied prepayments are a liability, not a collection.
          SELECT "rentalRequestId" AS rid, SUM(amount::numeric) AS paid
          FROM rental_prepayments WHERE "deletedAt" IS NULL AND "appliedAt" IS NOT NULL
          GROUP BY "rentalRequestId"
        ),
        ${ORDER_EXTRAS_CTE},
        derived AS (
          SELECT
            -- Owed = base total + extra charges (fuel/damage) with tax.
            CASE
              WHEN (COALESCE(r."totalAmount"::numeric,0) + ${EXTRA_TOTAL_EXPR}) > 0 AND COALESCE(pp.paid,0) >= (COALESCE(r."totalAmount"::numeric,0) + ${EXTRA_TOTAL_EXPR}) - 0.005 THEN 'paid'
              WHEN COALESCE(pp.paid,0) > 0 THEN 'partial'
              ELSE 'unpaid'
            END AS status,
            COALESCE(r."totalAmount"::numeric,0) + ${EXTRA_TOTAL_EXPR} AS total
          FROM rental_requests r
          LEFT JOIN pp ON pp.rid = r.id
          LEFT JOIN order_extras oe ON oe.rid = r.id
          WHERE r."deletedAt" IS NULL AND r.status IN ('active','completed')${df}
        )
        SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total),0) AS amount
        FROM derived
        GROUP BY status
        ORDER BY count DESC
      `));
      return rows.map((r) => ({
        status: String(r.status),
        count: Number(r.count),
        amount: Number(r.amount),
      }));
    }),

  /** Accounts receivable — unpaid/partial active orders */
  accountsReceivable: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { total: 0, orders: [] };
      const df = buildFilters(input, "createdAt");
      // Owing = billed total minus any recorded prepayments (the only on-system
      // collection signal until per-order payments land in Phase 4).
      const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
        WITH pp AS (
          -- Only applied (appliedAt IS NOT NULL) prepayments reduce the balance,
          -- matching the invoice balance rule. Held prepayments stay outstanding.
          SELECT "rentalRequestId" AS rid, SUM(amount::numeric) AS paid
          FROM rental_prepayments WHERE "deletedAt" IS NULL AND "appliedAt" IS NOT NULL
          GROUP BY "rentalRequestId"
        ),
        ${ORDER_EXTRAS_CTE}
        SELECT
          r.id, r."customerName", r."customerEmail", r.status,
          CASE WHEN COALESCE(pp.paid,0) > 0 THEN 'partial' ELSE 'pending' END AS "paymentStatus",
          -- Billed = base total + extra charges (fuel/damage) with tax.
          (COALESCE(r."totalAmount"::numeric,0) + ${EXTRA_TOTAL_EXPR}) AS "totalAmount",
          GREATEST(COALESCE(r."totalAmount"::numeric,0) + ${EXTRA_TOTAL_EXPR} - COALESCE(pp.paid,0), 0) AS owing,
          r."createdAt"
        FROM rental_requests r
        LEFT JOIN pp ON pp.rid = r.id
        LEFT JOIN order_extras oe ON oe.rid = r.id
        WHERE r."deletedAt" IS NULL
          AND r.status IN ('active', 'completed')
          AND GREATEST(COALESCE(r."totalAmount"::numeric,0) + ${EXTRA_TOTAL_EXPR} - COALESCE(pp.paid,0), 0) > 0${df}
        ORDER BY owing DESC NULLS LAST
        LIMIT 50
      `));
      const orders = rows.map((r) => ({
        id: Number(r.id),
        customerName: String(r.customerName),
        customerEmail: String(r.customerEmail || ""),
        status: String(r.status),
        paymentStatus: String(r.paymentStatus || "pending"),
        totalAmount: Number(r.totalAmount) || 0,
        owing: Number(r.owing) || 0,
        createdAt: String(r.createdAt),
      }));
      const total = orders.reduce((sum, o) => sum + o.owing, 0);
      return { total, orders };
    }),

  /**
   * A/R aging — outstanding receivables bucketed by age.
   *
   * Built on rental_requests (the real billed data), NOT the invoices table:
   * invoices carry no recorded payments (amountPaid is 0 across the board) and
   * their totals are inflated/duplicated, so an invoice-based aging is
   * misleading. Owing per delivered-but-unpaid order = totalAmount minus any
   * recorded prepayments. Aged from the order date. Until per-order payments are
   * captured (Phase 4), most orders read as 'pending' even though cash was
   * collected off-system, so this is an accrual-basis upper bound.
   */
  arAging: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { buckets: [], totalOutstanding: 0 };
      const df = buildFilters(input, "createdAt");
      const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
        WITH pp AS (
          -- Applied prepayments only, matching the invoice balance rule; held
          -- prepayments remain outstanding receivables.
          SELECT "rentalRequestId" AS rid, SUM(amount::numeric) AS paid
          FROM rental_prepayments WHERE "deletedAt" IS NULL AND "appliedAt" IS NOT NULL
          GROUP BY "rentalRequestId"
        ),
        ${ORDER_EXTRAS_CTE},
        bucketed AS (
          SELECT
            r.id,
            -- Owing = base total + extra charges (fuel/damage) with tax, less paid.
            GREATEST(COALESCE(r."totalAmount"::numeric,0) + ${EXTRA_TOTAL_EXPR} - COALESCE(pp.paid,0), 0) AS owing,
            CASE
              WHEN NOW() - (r."createdAt" AT TIME ZONE 'UTC') <= INTERVAL '30 days' THEN '0-30'
              WHEN NOW() - (r."createdAt" AT TIME ZONE 'UTC') <= INTERVAL '60 days' THEN '31-60'
              WHEN NOW() - (r."createdAt" AT TIME ZONE 'UTC') <= INTERVAL '90 days' THEN '61-90'
              ELSE '90+'
            END AS bucket
          FROM rental_requests r
          LEFT JOIN pp ON pp.rid = r.id
          LEFT JOIN order_extras oe ON oe.rid = r.id
          WHERE r."deletedAt" IS NULL
            AND r.status IN ('active', 'completed')${df}
        )
        SELECT
          bucket,
          COUNT(*)::int AS order_count,
          COALESCE(SUM(owing), 0)::numeric AS total_owing
        FROM bucketed
        WHERE owing > 0
        GROUP BY bucket
        ORDER BY
          CASE bucket
            WHEN '0-30' THEN 1
            WHEN '31-60' THEN 2
            WHEN '61-90' THEN 3
            WHEN '90+' THEN 4
          END
      `));
      const buckets = rows.map((r) => ({
        bucket: String(r.bucket),
        invoiceCount: Number(r.order_count),
        totalOwing: Number(r.total_owing),
      }));
      const totalOutstanding = buckets.reduce((s, b) => s + b.totalOwing, 0);
      return { buckets, totalOutstanding };
    }),

  /**
   * Held prepayments — money received but NOT yet applied to rent
   * (appliedAt IS NULL). This is a liability, deliberately kept out of the
   * paid/AR/aging reports (which only count applied prepayments). Surfaced
   * separately so ops can see "cash collected, not settled against an order"
   * and act on it (convert to rent), rather than mistaking it for paid.
   */
  heldPrepayments: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { total: 0, count: 0, orders: [] };
      const df = buildFilters(input, "createdAt");
      const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
        WITH held AS (
          SELECT "rentalRequestId" AS rid, SUM(amount::numeric) AS held
          FROM rental_prepayments
          WHERE "deletedAt" IS NULL AND "appliedAt" IS NULL
          GROUP BY "rentalRequestId"
        )
        SELECT
          r.id, r."customerName", r."customerEmail", r.status,
          h.held::numeric AS held,
          r."createdAt"
        FROM held h
        JOIN rental_requests r ON r.id = h.rid AND r."deletedAt" IS NULL
        WHERE h.held > 0${df}
        ORDER BY h.held DESC
        LIMIT 100
      `));
      const orders = rows.map((r) => ({
        id: Number(r.id),
        customerName: String(r.customerName),
        customerEmail: String(r.customerEmail || ""),
        status: String(r.status),
        held: Number(r.held) || 0,
        createdAt: String(r.createdAt),
      }));
      const total = orders.reduce((s, o) => s + o.held, 0);
      return { total, count: orders.length, orders };
    }),

  /**
   * Operational health — orders whose status implies a business object that
   * wasn't generated (a side effect failed silently, or a batch op bypassed
   * it). Surfaces the "status changed but nothing produced" gaps so ops can
   * fix-forward. Multi-item aware: dispatch/fleet checks cover line items.
   */
  operationalHealth: protectedProcedure.use(moduleGuard('reports', 'read'))
    .query(async () => {
      const db = await getDb();
      if (!db) return { items: [], count: 0 };
      const policies = await getRentalOperationPolicies();
      const rows: Record<string, unknown>[] = await db.execute(sql`
        -- approved non-credit orders with no contract generated
        SELECT r.id, COALESCE(r."rentalNumber", '#' || r.id) AS order_no, r.status, 'no_contract' AS issue
        FROM rental_requests r
        WHERE r."deletedAt" IS NULL AND r.status = 'approved'
          AND COALESCE(r."isCreditOrder", false) = false
          AND COALESCE(r."contractGenerated", false) = false
        UNION ALL
        -- approved/active delivery orders (single or multi) with no dispatch order
        SELECT r.id, COALESCE(r."rentalNumber", '#' || r.id) AS order_no, r.status, 'no_dispatch' AS issue
        FROM rental_requests r
        WHERE r."deletedAt" IS NULL AND r.status IN ('approved', 'active')
          AND COALESCE(r."isCreditOrder", false) = false
          AND r."deliveryMethod" IS NOT NULL AND r."deliveryMethod" <> 'pickup'
          AND NOT EXISTS (SELECT 1 FROM dispatch_orders d WHERE d."rentalRequestId" = r.id AND d."deletedAt" IS NULL)
        UNION ALL
        -- completed non-credit orders with no invoice
        SELECT r.id, COALESCE(r."rentalNumber", '#' || r.id) AS order_no, r.status, 'no_invoice' AS issue
        FROM rental_requests r
        WHERE r."deletedAt" IS NULL AND r.status = 'completed'
          AND COALESCE(r."isCreditOrder", false) = false
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i."rentalId" = r.id AND i."deletedAt" IS NULL)
        UNION
        -- active orders whose line-item fleet is not marked rented
        SELECT r.id, COALESCE(r."rentalNumber", '#' || r.id) AS order_no, r.status, 'fleet_not_rented' AS issue
        FROM rental_requests r
        JOIN rental_line_items li ON li."rentalRequestId" = r.id AND li."deletedAt" IS NULL
        JOIN rental_fleet rf ON rf.id = li."rentalFleetId" AND rf."deletedAt" IS NULL
        WHERE r."deletedAt" IS NULL AND r.status = 'active' AND rf."currentStatus" <> 'rented'
        UNION
        -- active single-asset orders whose fleet is not marked rented
        SELECT r.id, COALESCE(r."rentalNumber", '#' || r.id) AS order_no, r.status, 'fleet_not_rented' AS issue
        FROM rental_requests r
        JOIN rental_fleet rf ON rf.id = r."rentalFleetId" AND rf."deletedAt" IS NULL
        WHERE r."deletedAt" IS NULL AND r.status = 'active' AND rf."currentStatus" <> 'rented'
        LIMIT 200
      `);
      const visibleRows = policies.dispatchWorkflow
        ? rows
        : rows.filter((row) => row.issue !== "no_dispatch");
      const items = visibleRows.map((r) => ({
        id: Number(r.id),
        orderNo: String(r.order_no),
        status: String(r.status),
        issue: String(r.issue),
      }));
      return { items, count: items.length };
    }),

  /**
   * Internal work queue — the inverse of operationalHealth.
   *
   * operationalHealth is anchored on the order and cannot see a work item that
   * was created and then stalled. This one is anchored on the work item and
   * asks how long it has been waiting. See services/internalWorkQueue.ts.
   *
   * Guarded on 'reports' read like its sibling; the sidebar badge degrades to
   * nothing for users without it rather than leaking counts.
   */
  internalWorkQueue: protectedProcedure.use(moduleGuard('reports', 'read'))
    .query(async () => {
      const db = await getDb();
      if (!db) return { buckets: [], total: 0, overdueTotal: 0 };
      return getInternalWorkQueue(db);
    }),

  /**
   * Revenue by month with component breakdown — invoices basis.
   *
   * Revenue is recognized only for orders that have an issued (non-draft,
   * non-cancelled) invoice, in the month of that order's FIRST invoice
   * (DISTINCT ON dedups multi-invoice / monthly-credit orders so the order's
   * rental components aren't counted once per invoice). The rent/freight/
   * insurance split is taken from the originating order; slicers
   * (customer/warehouse/category/model) apply to that order via buildFilters.
   * The date window filters on the recognition date (invoice issueDate).
   */
  revenueByMonthDetailed: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const df = buildFilters(input, "issued", "rental_requests", "fi.issued");
      const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
        WITH first_inv AS (
          SELECT DISTINCT ON (i."rentalId") i."rentalId" AS rid, i."issueDate" AS issued
          FROM invoices i
          WHERE i."deletedAt" IS NULL AND i.status NOT IN ('draft', 'cancelled') AND i."rentalId" IS NOT NULL
          ORDER BY i."rentalId", i."issueDate" ASC
        )
        SELECT
          to_char(date_trunc('month', ((fi.issued AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})), 'YYYY-MM') AS month,
          COALESCE(SUM(rental_requests."rentalFee"::numeric), 0) AS "rentalFee",
          COALESCE(SUM(rental_requests."freightCost"::numeric), 0) AS "freightCost",
          COALESCE(SUM(rental_requests."insuranceCost"::numeric), 0) AS "insuranceCost",
          COALESCE(SUM(rental_requests."totalAmount"::numeric), 0) AS total
        FROM first_inv fi
        JOIN rental_requests ON rental_requests.id = fi.rid AND rental_requests."deletedAt" IS NULL${df}
        GROUP BY date_trunc('month', ((fi.issued AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))
        ORDER BY date_trunc('month', ((fi.issued AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})) ASC
      `));
      return rows.map((r) => ({
        month: String(r.month),
        rentalFee: Number(r.rentalFee),
        freightCost: Number(r.freightCost),
        insuranceCost: Number(r.insuranceCost),
        total: Number(r.total),
      }));
    }),

  /**
   * Income Statement (P&L) — invoices basis.
   *
   * Revenue is recognized only for orders that have an issued invoice, counted
   * once at the order's first-invoice date (DISTINCT ON dedups multi-invoice /
   * monthly-credit orders). Operating revenue is broken into its real streams
   * (rental, insurance, freight, overtime, late fees) from the originating
   * order; tax and deposits are liabilities (memo lines). `billedTotal` ties to
   * the order total. Slicers (customer/warehouse/category/model) apply to the
   * originating order; the date window filters on the recognition (invoice
   * issue) date. The prior-period column uses an equal-length preceding window.
   */
  incomeStatement: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const REVENUE_SELECT = `
        COALESCE(SUM(rental_requests."rentalFee"::numeric), 0) AS "rentalFee",
        COALESCE(SUM(rental_requests."insuranceCost"::numeric), 0) AS "insuranceCost",
        COALESCE(SUM(rental_requests."freightCost"::numeric), 0) AS "freightCost",
        COALESCE(SUM(rental_requests."overtimeCost"::numeric), 0) AS "overtimeCost",
        COALESCE(SUM(rental_requests."estimatedLateFee"::numeric), 0) AS "lateFee",
        -- Extra charges (fuel/damage/…) are revenue too; pre-tax here, their tax
        -- folded into taxAmount/billedTotal so Revenue + tax still ties to billed.
        COALESCE(SUM(oe.extra_subtotal), 0) AS "extraCharges",
        (COALESCE(SUM(rental_requests."taxAmount"::numeric), 0) + COALESCE(SUM(oe.extra_tax), 0)) AS "taxAmount",
        COALESCE(SUM(rental_requests."depositAmount"::numeric), 0) AS "depositAmount",
        (COALESCE(SUM(rental_requests."totalAmount"::numeric), 0) + COALESCE(SUM(oe.extra_subtotal), 0) + COALESCE(SUM(oe.extra_tax), 0)) AS "billedTotal",
        COUNT(*)::int AS "orderCount"`;

      // Orders recognized on an invoices basis: one row per order, at its first
      // issued invoice's date (so monthly-credit orders aren't multi-counted).
      const FIRST_INV_CTE = `
        WITH first_inv AS (
          SELECT DISTINCT ON (i."rentalId") i."rentalId" AS rid, i."issueDate" AS issued
          FROM invoices i
          WHERE i."deletedAt" IS NULL AND i.status NOT IN ('draft', 'cancelled') AND i."rentalId" IS NOT NULL
          ORDER BY i."rentalId", i."issueDate" ASC
        )`;

      const periodTotals = async (filters: FinanceFilters | undefined) => {
        const df = buildFilters(filters, "issued", "rental_requests", "fi.issued");
        const [row]: Record<string, unknown>[] = await db.execute(sql.raw(`
          ${FIRST_INV_CTE}, ${ORDER_EXTRAS_CTE}
          SELECT ${REVENUE_SELECT}
          FROM first_inv fi
          JOIN rental_requests ON rental_requests.id = fi.rid AND rental_requests."deletedAt" IS NULL${df}
          LEFT JOIN order_extras oe ON oe.rid = rental_requests.id
        `));
        const rentalFee = Number(row?.rentalFee) || 0;
        const insuranceCost = Number(row?.insuranceCost) || 0;
        const freightCost = Number(row?.freightCost) || 0;
        const overtimeCost = Number(row?.overtimeCost) || 0;
        const lateFee = Number(row?.lateFee) || 0;
        const extraCharges = Number(row?.extraCharges) || 0;
        return {
          rentalFee,
          insuranceCost,
          freightCost,
          overtimeCost,
          // Fuel / damage / cleaning etc. billed on top of rent — real earned
          // revenue that totalAmount alone dropped. Pre-tax; its tax is in taxAmount.
          extraCharges,
          // estimatedLateFee is an accrual estimate on overdue/open orders, NOT
          // billed/earned income — kept as a memo line, deliberately excluded
          // from Total Revenue so that Total Revenue + tax ties to billedTotal.
          lateFee,
          totalRevenue: rentalFee + insuranceCost + freightCost + overtimeCost + extraCharges,
          taxAmount: Number(row?.taxAmount) || 0,
          depositAmount: Number(row?.depositAmount) || 0,
          billedTotal: Number(row?.billedTotal) || 0,
          orderCount: Number(row?.orderCount) || 0,
        };
      };

      const current = await periodTotals(input);

      // Prior period = equal-length window ending 1ms before the current start.
      let prior: Awaited<ReturnType<typeof periodTotals>> | null = null;
      const start = input?.startDate ? new Date(input.startDate) : null;
      const end = input?.endDate ? new Date(input.endDate) : null;
      if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end >= start) {
        const len = end.getTime() - start.getTime();
        const priorEnd = new Date(start.getTime() - 1);
        const priorStart = new Date(start.getTime() - 1 - len);
        prior = await periodTotals({
          ...input,
          startDate: priorStart.toISOString(),
          endDate: priorEnd.toISOString(),
        });
      }

      return { current, prior };
    }),

  /**
   * Tax / HST-GST remittance report — filing-ready.
   *
   * Per province (place of supply = taxProvince, falling back to delivery
   * province then ON): taxable sales (rental + freight + insurance, the same
   * base the tax engine uses — deposits are never taxed) and tax collected.
   * The HST/GST/PST split is driven by each province's statutory rate structure
   * in tax_rates (HST provinces → 100% HST; GST+PST provinces → split the
   * collected tax in the gst:pst rate ratio), NOT the per-order taxBreakdown
   * JSON — that JSON is null on most legacy/imported rows, so a rate-based
   * allocation is the only way the split ties exactly to taxAmount. A province
   * absent from tax_rates leaves its tax `unallocated`. Also returns a per-month
   * series for picking a filing period.
   */
  taxRemittance: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { byProvince: [], byMonth: [], totals: null };
      const df = buildFilters(input, "createdAt");

      // Shared base CTE: taxable amount (deposits excluded), recorded tax.
      const baseCte = `
        WITH base AS (
          SELECT
            COALESCE(NULLIF("taxProvince", ''), NULLIF("deliveryProvince", ''), 'ON') AS province,
            (COALESCE("rentalFee"::numeric,0) + COALESCE("freightCost"::numeric,0) + COALESCE("insuranceCost"::numeric,0)) AS taxable,
            COALESCE("taxAmount"::numeric,0) AS tax,
            (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}) AS local_ts
          FROM rental_requests
          WHERE status IN ('active','completed') AND "deletedAt" IS NULL${df}
        )`;

      const provinceRows: Record<string, unknown>[] = await db.execute(sql.raw(`
        ${baseCte}
        SELECT
          b.province,
          tr."provinceName" AS province_name,
          COALESCE(tr."gstRate"::numeric,0) AS gst_rate,
          COALESCE(tr."pstRate"::numeric,0) AS pst_rate,
          COALESCE(tr."hstRate"::numeric,0) AS hst_rate,
          COUNT(*)::int AS order_count,
          COALESCE(SUM(b.taxable),0) AS taxable_sales,
          COALESCE(SUM(b.tax),0) AS tax_collected
        FROM base b
        LEFT JOIN tax_rates tr ON tr.province = b.province
        GROUP BY b.province, tr."provinceName", tr."gstRate", tr."pstRate", tr."hstRate"
        ORDER BY tax_collected DESC
      `));

      const monthRows: Record<string, unknown>[] = await db.execute(sql.raw(`
        ${baseCte}
        SELECT
          to_char(date_trunc('month', b.local_ts), 'YYYY-MM') AS month,
          COALESCE(SUM(b.taxable),0) AS taxable_sales,
          COALESCE(SUM(b.tax),0) AS tax_collected
        FROM base b
        GROUP BY date_trunc('month', b.local_ts)
        ORDER BY date_trunc('month', b.local_ts) ASC
      `));

      const round2 = (n: number) => Math.round(n * 100) / 100;
      const byProvince = provinceRows.map((r) => {
        const taxCollected = Number(r.tax_collected) || 0;
        const gstRate = Number(r.gst_rate) || 0;
        const pstRate = Number(r.pst_rate) || 0;
        const hstRate = Number(r.hst_rate) || 0;
        // Allocate collected tax to the components that province actually levies.
        let hst = 0, gst = 0, pst = 0, unallocated = 0;
        if (hstRate > 0) {
          hst = round2(taxCollected);
        } else if (gstRate + pstRate > 0) {
          gst = round2(taxCollected * (gstRate / (gstRate + pstRate)));
          pst = round2(taxCollected - gst); // remainder, so gst+pst === collected
        } else {
          unallocated = round2(taxCollected); // province missing from tax_rates
        }
        return {
          province: String(r.province),
          provinceName: r.province_name ? String(r.province_name) : String(r.province),
          orderCount: Number(r.order_count) || 0,
          taxableSales: Number(r.taxable_sales) || 0,
          taxCollected: round2(taxCollected),
          hst,
          gst,
          pst,
          unallocated,
        };
      });
      const byMonth = monthRows.map((r) => ({
        month: String(r.month),
        taxableSales: Number(r.taxable_sales) || 0,
        taxCollected: Number(r.tax_collected) || 0,
      }));
      const totals = byProvince.reduce(
        (acc, p) => ({
          taxableSales: acc.taxableSales + p.taxableSales,
          taxCollected: acc.taxCollected + p.taxCollected,
          hst: acc.hst + p.hst,
          gst: acc.gst + p.gst,
          pst: acc.pst + p.pst,
          unallocated: acc.unallocated + p.unallocated,
          orderCount: acc.orderCount + p.orderCount,
        }),
        { taxableSales: 0, taxCollected: 0, hst: 0, gst: 0, pst: 0, unallocated: 0, orderCount: 0 },
      );

      return { byProvince, byMonth, totals };
    }),

  /**
   * Deposit liability — a point-in-time balance, NOT a period flow.
   *
   * Security deposits are a liability only while we are still holding the
   * customer's money, i.e. while the rental is open (status = 'active'). Once a
   * rental completes the deposit is settled/returned at close-out.
   *
   * `depositPaid` is the "deposit actually collected" flag (toggled from the
   * order detail and audited as deposit_collected / deposit_uncollected), so a
   * deposit only counts as held once it is both collected AND on an active
   * rental. There is still no per-order deposit-*return* field, so settlement at
   * close-out is conventional rather than tracked row-by-row. Deliberately
   * ignores the finance date filter — a liability balance is as-of-now.
   */
  depositLiability: protectedProcedure.use(moduleGuard('reports', 'read'))
    .query(async () => {
      const db = await getDb();
      if (!db) return { totalHeld: 0, orderCount: 0, orders: [] };
      const rows: Record<string, unknown>[] = await db.execute(sql`
        SELECT
          id,
          COALESCE("financialOrderNumber", "rentalNumber") AS order_no,
          "customerName",
          "depositAmount"::numeric AS deposit,
          ("startDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL} AS start_local
        FROM rental_requests
        WHERE "deletedAt" IS NULL
          AND status = 'active'
          AND "depositPaid" = true
          AND "depositAmount"::numeric > 0
        ORDER BY "depositAmount"::numeric DESC
      `);
      const orders = rows.map((r) => ({
        id: Number(r.id),
        orderNo: r.order_no ? String(r.order_no) : `#${Number(r.id)}`,
        customerName: String(r.customerName || ""),
        depositAmount: Number(r.deposit) || 0,
        startDate: r.start_local ? String(r.start_local) : null,
      }));
      const totalHeld = orders.reduce((s, o) => s + o.depositAmount, 0);
      return { totalHeld, orderCount: orders.length, orders };
    }),

  /**
   * Cash / collections report — the cash-basis complement to the (accrual)
   * income statement. Built on rental_prepayments, the real on-system payment
   * ledger (captured per order from the rental detail dialog).
   *
   * Billed is the accrual total for orders created in the window; collected is
   * the cash actually received in the window (by payment date). Date-range only:
   * a payment isn't tied to a warehouse/category the way an order is, so those
   * slicers are intentionally not applied to the collected side.
   */
  cashCollections: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(financeFilterInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const billedDf = buildDateFilter(input, "createdAt");
      const [b]: Record<string, unknown>[] = await db.execute(sql.raw(`
        WITH ${ORDER_EXTRAS_CTE}
        SELECT COALESCE(SUM("totalAmount"::numeric + ${EXTRA_TOTAL_EXPR}),0) AS billed
        FROM rental_requests
        LEFT JOIN order_extras oe ON oe.rid = rental_requests.id
        WHERE status IN ('active','completed') AND "deletedAt" IS NULL${billedDf}
      `));
      const billed = Number(b?.billed) || 0;

      const payDf = buildDateFilter(input, "paymentDate");
      // Credit applied to an invoice is money we already collected once, when it
      // came in as an overpayment or a deposit. Counting the application as a
      // second collection would inflate every number on this report.
      const cashOnly = ` AND COALESCE("paymentMethod",'') <> 'account_credit'`;
      const [c]: Record<string, unknown>[] = await db.execute(sql.raw(`
        SELECT COALESCE(SUM(amount::numeric),0) AS collected, COUNT(*)::int AS n
        FROM rental_prepayments WHERE "deletedAt" IS NULL${payDf}${cashOnly}
      `));
      const collected = Number(c?.collected) || 0;

      const methodRows: Record<string, unknown>[] = await db.execute(sql.raw(`
        -- Group on the canonical spelling, not the stored one. sql/148 collapsed
        -- the legacy "card"/"etransfer" values that had been splitting each real
        -- method across two report rows; this keeps the report correct even if a
        -- write path reintroduces one, since the column is an unconstrained
        -- varchar rather than the hard enum the invoice payments table uses.
        SELECT CASE COALESCE(NULLIF("paymentMethod",''),'other')
                 WHEN 'card' THEN 'credit_card'
                 WHEN 'etransfer' THEN 'e_transfer'
                 ELSE COALESCE(NULLIF("paymentMethod",''),'other')
               END AS method,
               COALESCE(SUM(amount::numeric),0) AS amount, COUNT(*)::int AS count
        FROM rental_prepayments WHERE "deletedAt" IS NULL${payDf}${cashOnly}
        GROUP BY 1 ORDER BY amount DESC
      `));

      const monthRows: Record<string, unknown>[] = await db.execute(sql.raw(`
        SELECT to_char(date_trunc('month', (("paymentDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})), 'YYYY-MM') AS month,
               COALESCE(SUM(amount::numeric),0) AS collected
        FROM rental_prepayments WHERE "deletedAt" IS NULL${payDf}${cashOnly}
        GROUP BY date_trunc('month', (("paymentDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))
        ORDER BY date_trunc('month', (("paymentDate" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})) ASC
      `));

      return {
        billed,
        collected,
        outstanding: Math.max(Math.round((billed - collected) * 100) / 100, 0),
        collectionRate: billed > 0 ? Math.round((collected / billed) * 1000) / 10 : 0,
        paymentCount: Number(c?.n) || 0,
        byMethod: methodRows.map((r) => ({
          method: String(r.method),
          amount: Number(r.amount) || 0,
          count: Number(r.count) || 0,
        })),
        byMonth: monthRows.map((r) => ({ month: String(r.month), collected: Number(r.collected) || 0 })),
      };
    }),

  // ── Dispatch Reports ──────────────────────────────────────────

  /** Dispatch analytics: status distribution, monthly volume, avg distance/cost */
  dispatchAnalytics: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(dateRangeInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;
      const df = buildDateFilter(input, "createdAt");

      const [statusRows, monthlyRows, statsRow, deliveryDistRow] = await Promise.all([
        db.execute(sql.raw(`
          SELECT status, COUNT(*)::int AS count
          FROM dispatch_orders WHERE "deletedAt" IS NULL${df}
          GROUP BY status ORDER BY count DESC
        `)) as unknown as Record<string, unknown>[],

        db.execute(sql.raw(`
          SELECT to_char(date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})), 'YYYY-MM') AS month,
            COUNT(*)::int AS count,
            COUNT(CASE WHEN "orderType" = 'delivery' THEN 1 END)::int AS deliveries,
            COUNT(CASE WHEN "orderType" = 'pickup' THEN 1 END)::int AS pickups
          FROM dispatch_orders WHERE "deletedAt" IS NULL${df}
          GROUP BY date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))
          ORDER BY date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})) ASC
        `)) as unknown as Record<string, unknown>[],

        db.execute(sql.raw(`
          SELECT
            COUNT(*)::int AS total,
            COALESCE(AVG(distance::numeric), 0) AS "avgDistance",
            COALESCE(SUM("shippingCost"::numeric), 0) AS "totalCost",
            COALESCE(AVG("shippingCost"::numeric), 0) AS "avgCost"
          FROM dispatch_orders WHERE "deletedAt" IS NULL${df}
        `)) as unknown as Record<string, unknown>[],

        // Average delivery distance straight from the orders (warehouse → customer),
        // independent of the dispatch feature. dispatch_orders.distance is unused
        // (always 0), so this is the meaningful delivery-distance figure.
        db.execute(sql.raw(`
          SELECT
            COALESCE(AVG("deliveryDistanceKm"::numeric), 0) AS "avgDeliveryDistance",
            COUNT("deliveryDistanceKm")::int AS "withDistance"
          FROM rental_requests
          WHERE "deletedAt" IS NULL AND "deliveryDistanceKm" IS NOT NULL${df}
        `)) as unknown as Record<string, unknown>[],
      ]);

      return {
        byStatus: (statusRows as Record<string, unknown>[]).map((r) => ({
          status: String(r.status), count: Number(r.count),
        })),
        byMonth: (monthlyRows as Record<string, unknown>[]).map((r) => ({
          month: String(r.month), count: Number(r.count),
          deliveries: Number(r.deliveries), pickups: Number(r.pickups),
        })),
        summary: {
          total: Number((statsRow as Record<string, unknown>[])[0]?.total) || 0,
          avgDistance: Math.round((Number((statsRow as Record<string, unknown>[])[0]?.avgDistance) || 0) * 10) / 10,
          totalCost: Number((statsRow as Record<string, unknown>[])[0]?.totalCost) || 0,
          avgCost: Math.round((Number((statsRow as Record<string, unknown>[])[0]?.avgCost) || 0) * 100) / 100,
          avgDeliveryDistanceKm: Math.round((Number((deliveryDistRow as Record<string, unknown>[])[0]?.avgDeliveryDistance) || 0) * 10) / 10,
          deliveryOrdersWithDistance: Number((deliveryDistRow as Record<string, unknown>[])[0]?.withDistance) || 0,
        },
      };
    }),

  /** Driver performance */
  driverPerformance: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(dateRangeInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const df = buildDateFilter(input, "d.\"createdAt\"");
      const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
        SELECT
          dr.id, dr.name,
          COUNT(*)::int AS total,
          COUNT(CASE WHEN d.status = 'completed' THEN 1 END)::int AS completed,
          COUNT(CASE WHEN d.status = 'cancelled' THEN 1 END)::int AS cancelled,
          COALESCE(AVG(EXTRACT(EPOCH FROM (d."completedDate" - d."scheduledDate")) / 3600), 0) AS "avgHoursToComplete"
        FROM dispatch_orders d
        LEFT JOIN drivers dr ON dr.id = d."assignedDriverId" AND dr."deletedAt" IS NULL
        WHERE d."deletedAt" IS NULL AND d."assignedDriverId" IS NOT NULL${df}
        GROUP BY dr.id, dr.name
        ORDER BY completed DESC
        LIMIT 20
      `));
      return rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        total: Number(r.total),
        completed: Number(r.completed),
        cancelled: Number(r.cancelled),
        avgHoursToComplete: Math.round(Number(r.avgHoursToComplete) * 10) / 10,
      }));
    }),

  // ── Equipment Reports ──────────────────────────────────────────

  /** Fleet ROI: revenue vs purchase cost */
  // Per-asset operating analytics. Revenue is NET RENTAL revenue (rentalFee for
  // single-asset orders + lineSubtotal for multi-item orders) — NOT totalAmount,
  // which would double-count collected tax and pass-through freight/insurance.
  // Multi-item occupancy lives in rental_line_items (parent.rentalFleetId is
  // null), so it must be unioned in or its revenue is silently dropped.
  // Straight-line depreciation drives book value + annualized ROI; maintenance
  // cost has no structured source yet (later phase) and is returned as null.
  fleetROI: protectedProcedure.use(moduleGuard('reports', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];

    const policy = await loadDepreciationPolicy(db);

    const rows: Record<string, unknown>[] = await db.execute(sql`
      WITH single AS (
        -- Single-asset orders: rental fee booked on the order itself.
        SELECT rr."rentalFleetId" AS fleet_id,
               COALESCE(SUM(rr."rentalFee"::numeric), 0) AS revenue,
               COUNT(rr.id)::int AS rental_count
        FROM rental_requests rr
        WHERE rr."rentalFleetId" IS NOT NULL
          AND rr.status IN ('active', 'completed')
          AND rr."deletedAt" IS NULL
        GROUP BY rr."rentalFleetId"
      ),
      line_totals AS (
        -- Per-order line sum, used to apportion the order's actual fee below.
        SELECT li."rentalRequestId" AS rental_id,
               SUM(li."lineSubtotal"::numeric) AS line_total
        FROM rental_line_items li
        WHERE li."lineSubtotal" IS NOT NULL
          AND li."deletedAt" IS NULL
        GROUP BY li."rentalRequestId"
      ),
      multi AS (
        -- Multi-item orders: the fee is booked per line, but the ORDER's
        -- rentalFee is what was actually charged, and the two drift — a price
        -- match or a later edit rewrites the order without touching the lines
        -- (20260626XN: order $1870 vs lines $1000). Summing the lines silently
        -- drops that $870 from per-asset revenue, so apportion the order's real
        -- fee across its lines instead. Revenue is then conserved: the parts
        -- always add back up to the whole.
        SELECT li."rentalFleetId" AS fleet_id,
               COALESCE(SUM(
                 rr."rentalFee"::numeric
                 * li."lineSubtotal"::numeric
                 / NULLIF(lt.line_total, 0)
               ), 0) AS revenue,
               COUNT(DISTINCT li."rentalRequestId")::int AS rental_count
        FROM rental_line_items li
        JOIN rental_requests rr ON rr.id = li."rentalRequestId"
          AND rr.status IN ('active', 'completed')
          AND rr."deletedAt" IS NULL
          AND rr."rentalFleetId" IS NULL
        JOIN line_totals lt ON lt.rental_id = li."rentalRequestId"
        WHERE li."rentalFleetId" IS NOT NULL
          AND li."lineSubtotal" IS NOT NULL
          AND li."deletedAt" IS NULL
        GROUP BY li."rentalFleetId"
      )
      SELECT
        rf.id, rf.brand || ' ' || rf.model AS name,
        rf."assetNumber", rf.category,
        rf."purchaseCost"::numeric AS "purchaseCost",
        rf."purchaseDate" AS "purchaseDate",
        (COALESCE(s.revenue, 0) + COALESCE(m.revenue, 0)) AS revenue,
        (COALESCE(s.rental_count, 0) + COALESCE(m.rental_count, 0)) AS "rentalCount"
      FROM rental_fleet rf
      LEFT JOIN single s ON s.fleet_id = rf.id
      LEFT JOIN multi  m ON m.fleet_id = rf.id
      WHERE rf."deletedAt" IS NULL
      ORDER BY revenue DESC
      LIMIT 100
    `);

    const now = new Date();
    return rows.map((r) => {
      const purchaseCost = r.purchaseCost != null ? Number(r.purchaseCost) : null;
      const purchaseDate = r.purchaseDate ? new Date(r.purchaseDate as string) : null;
      const revenue = Number(r.revenue);
      const econ = computeAssetEconomics({
        purchaseCost,
        purchaseDate,
        netRentalRevenue: revenue,
        usefulLifeYears: policy.usefulLifeYears,
        salvagePct: policy.salvagePct,
        now,
      });
      return {
        id: Number(r.id),
        name: String(r.name),
        assetNumber: r.assetNumber ? String(r.assetNumber) : null,
        category: r.category ? String(r.category) : null,
        purchaseCost: purchaseCost ?? 0,
        revenue,
        rentalCount: Number(r.rentalCount),
        ageYears: econ.ageYears,
        bookValue: econ.bookValue,
        accumulatedDepreciation: econ.accumulatedDepreciation,
        annualDepreciation: econ.annualDepreciation,
        paybackPct: econ.paybackPct,
        annualRoiPct: econ.annualRoiPct,
        isPaidBack: econ.isPaidBack,
        maintenanceCost: null as number | null, // no structured source yet
        // Back-compat: existing UI read `roi` as cumulative recovery %.
        roi: econ.paybackPct != null ? Math.round(econ.paybackPct) : null,
      };
    });
  }),

  /** Equipment condition trends from inspections */
  fleetConditionTrend: protectedProcedure.use(moduleGuard('reports', 'read')).query(async () => {
    const db = await getDb();
    if (!db) return [];
    const rows: Record<string, unknown>[] = await db.execute(sql`
      SELECT
        to_char(date_trunc('month', ((i."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})), 'YYYY-MM') AS month,
        COUNT(*)::int AS inspections,
        COUNT(CASE WHEN i."overallCondition" = 'excellent' THEN 1 END)::int AS excellent,
        COUNT(CASE WHEN i."overallCondition" = 'good' THEN 1 END)::int AS good,
        COUNT(CASE WHEN i."overallCondition" = 'fair' THEN 1 END)::int AS fair,
        COUNT(CASE WHEN i."overallCondition" = 'poor' THEN 1 END)::int AS poor,
        COUNT(CASE WHEN i."damageSeverity" IN ('minor', 'moderate', 'severe') THEN 1 END)::int AS "withDamage"
      FROM inspections i
      WHERE i."deletedAt" IS NULL
        AND ((i."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}) >= date_trunc('month', now() AT TIME ZONE ${APP_TIMEZONE_SQL}) - INTERVAL '11 months'
      GROUP BY date_trunc('month', ((i."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))
      ORDER BY date_trunc('month', ((i."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})) ASC
    `);
    return rows.map((r) => ({
      month: String(r.month),
      inspections: Number(r.inspections),
      excellent: Number(r.excellent),
      good: Number(r.good),
      fair: Number(r.fair),
      poor: Number(r.poor),
      withDamage: Number(r.withDamage),
    }));
  }),

  // ── Customer Reports ──────────────────────────────────────────

  /** Top customers by revenue */
  customerAnalytics: protectedProcedure.use(moduleGuard('reports', 'read'))
    .input(dateRangeInput)
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { topCustomers: [], growth: [] };
      const df = buildDateFilter(input, "rr.\"createdAt\"");

      const [topRows, growthRows] = await Promise.all([
        db.execute(sql.raw(`
          SELECT
            c.id, c.name, c.email, c.company,
            COUNT(rr.id)::int AS "rentalCount",
            COALESCE(SUM(rr."totalAmount"::numeric), 0) AS revenue
          FROM customers c
          LEFT JOIN rental_requests rr
            ON rr."customerId" = c.id
            AND rr.status IN ('active', 'completed')
            AND rr."deletedAt" IS NULL${df}
          WHERE c."deletedAt" IS NULL
          GROUP BY c.id, c.name, c.email, c.company
          HAVING COUNT(rr.id) > 0
          ORDER BY revenue DESC
          LIMIT 10
        `)) as unknown as Record<string, unknown>[],

        db.execute(sql.raw(`
          SELECT
            to_char(date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})), 'YYYY-MM') AS month,
            COUNT(*)::int AS "newCustomers"
          FROM customers
          WHERE "deletedAt" IS NULL
            AND (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}) >= date_trunc('month', now() AT TIME ZONE ${APP_TIMEZONE_SQL}) - INTERVAL '11 months'
          GROUP BY date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL}))
          ORDER BY date_trunc('month', (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TIMEZONE_SQL})) ASC
        `)) as unknown as Record<string, unknown>[],
      ]);

      return {
        topCustomers: (topRows as Record<string, unknown>[]).map((r) => ({
          id: Number(r.id),
          name: String(r.name),
          email: r.email ? String(r.email) : null,
          company: r.company ? String(r.company) : null,
          rentalCount: Number(r.rentalCount),
          revenue: Number(r.revenue),
        })),
        growth: (growthRows as Record<string, unknown>[]).map((r) => ({
          month: String(r.month),
          newCustomers: Number(r.newCustomers),
        })),
      };
    }),

  /**
   * Customer count + cumulative net rental revenue grouped by industry.
   * Revenue = SUM(rental_requests.rentalFee) for active/completed, non-deleted
   * rentals, joined by customerId. Customers with no qualifying rentals still
   * count toward customerCount with revenue 0. Unclassified customers
   * (industry IS NULL) roll up into 'unclassified'.
   */
  industryRevenue: protectedProcedure.use(moduleGuard('reports', 'read'))
    .query(async () => {
      const db = await getDb();
      if (!db) return [];

      const rows: Record<string, unknown>[] = await db.execute(sql.raw(`
        SELECT
          COALESCE(c.industry, 'unclassified') AS industry,
          COUNT(DISTINCT c.id)::int AS "customerCount",
          COALESCE(SUM(rr."rentalFee"::numeric), 0) AS revenue
        FROM customers c
        LEFT JOIN rental_requests rr
          ON rr."customerId" = c.id
          AND rr.status IN ('active', 'completed')
          AND rr."deletedAt" IS NULL
        WHERE c."deletedAt" IS NULL
        GROUP BY COALESCE(c.industry, 'unclassified')
        ORDER BY revenue DESC
      `));

      return rows.map((r) => ({
        industry: String(r.industry),
        customerCount: Number(r.customerCount),
        revenue: Number(r.revenue),
      }));
    }),
});
