-- Migration: Feature updates 2026-03-20
-- Adds: insurance doc tracking, refund, scheduled times, fuel inspection, dispatch confirmation, card last4
-- Safe: all new columns are nullable or have defaults — no existing data affected

-- ─── rental_requests: insurance docs, refund, scheduled times ────────────
ALTER TABLE rental_requests ADD COLUMN IF NOT EXISTS "insuranceDocsReceived" boolean DEFAULT false NOT NULL;
ALTER TABLE rental_requests ADD COLUMN IF NOT EXISTS "refundAmount" numeric(12,2);
ALTER TABLE rental_requests ADD COLUMN IF NOT EXISTS "scheduledDeliveryTime" varchar(5);
ALTER TABLE rental_requests ADD COLUMN IF NOT EXISTS "scheduledPickupTime" varchar(5);

-- ─── inspections: fuel percentage + fuel charge ──────────────────────────
-- fuelLevel already exists as integer, we repurpose it as percentage (0-100)
-- Add explicit percentage field for clarity (new inspections use this)
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS "fuelLevelPercent" integer;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS "fuelChargeAmount" numeric(12,2);

-- Add check constraint for fuel percentage range
DO $$ BEGIN
  ALTER TABLE inspections ADD CONSTRAINT "fuel_level_percent_range"
    CHECK ("fuelLevelPercent" IS NULL OR ("fuelLevelPercent" >= 0 AND "fuelLevelPercent" <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── dispatch_orders: driver/customer confirmation ───────────────────────
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS "customerConfirmedAt" timestamp;
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS "customerConfirmationSignature" text;
ALTER TABLE dispatch_orders ADD COLUMN IF NOT EXISTS "driverConfirmedAt" timestamp;

-- ─── payments: card last 4 digits ────────────────────────────────────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS "cardLast4" varchar(4);
