-- Migration: Add CRM fields to customers + customer_interactions table
-- Safe: all new columns have defaults or are nullable, no existing data affected

-- Enums
DO $$ BEGIN
  CREATE TYPE "customerSource" AS ENUM ('website', 'phone', 'referral', 'walk_in', 'admin', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "interactionType" AS ENUM ('call', 'email', 'note', 'visit', 'complaint', 'follow_up');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- New columns on customers (all nullable or with defaults — zero risk)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "tags" json DEFAULT '[]';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "source" "customerSource" DEFAULT 'website';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "preferredDeliveryMethod" "deliveryMethod";
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "preferredEquipmentTypes" json DEFAULT '[]';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "totalRentals" integer NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "totalRevenue" numeric(12,2) NOT NULL DEFAULT '0';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "lastRentalDate" timestamp;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "nextFollowUp" timestamp;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "followUpNotes" text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "lastContactedAt" timestamp;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS "riskScore" integer DEFAULT 50;

-- Index for follow-up queries
CREATE INDEX IF NOT EXISTS "customers_follow_up_idx" ON customers ("nextFollowUp");

-- Customer Interactions table
CREATE TABLE IF NOT EXISTS "customer_interactions" (
  "id" serial PRIMARY KEY,
  "customerId" integer NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  "type" "interactionType" NOT NULL,
  "summary" text NOT NULL,
  "createdBy" integer REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "interactions_customer_idx" ON customer_interactions ("customerId");
CREATE INDEX IF NOT EXISTS "interactions_created_at_idx" ON customer_interactions ("createdAt");
