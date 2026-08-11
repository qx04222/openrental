-- OpenRental — database baseline schema
--
-- One file, one command. This replaces the incremental migration history of
-- the system OpenRental was extracted from: those migrations carried one-off
-- production data fixes that are meaningless outside that deployment.
--
--   createdb openrental
--   psql "$DATABASE_URL" -f sql/000_baseline.sql
--   npm run seed          # admin user, a warehouse, site settings
--   npm run seed:demo     # optional: a fictional fleet, customers and orders
--
-- Migrations added after this baseline live in sql/NNN_*.sql and must be
-- idempotent (value guards / ON CONFLICT), so re-running the folder is safe.

--
-- PostgreSQL database dump
--

\restrict 4StPz1PVEf9mNAkps12OJVyPcIToUW11OoWeQg54xbn0p7jUvkRVVOfybo8cGw9

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

CREATE TYPE public."catalogSource" AS ENUM (
    'industrial',
    'powersports',
    'manual'
);

CREATE TYPE public.condition AS ENUM (
    'excellent',
    'good',
    'fair',
    'poor'
);

CREATE TYPE public."customerSource" AS ENUM (
    'website',
    'phone',
    'referral',
    'walk_in',
    'admin',
    'other'
);

CREATE TYPE public."deliveryMethod" AS ENUM (
    'pickup',
    'delivery',
    'delivery_and_return'
);

CREATE TYPE public."dispatchOrderType" AS ENUM (
    'delivery',
    'pickup'
);

CREATE TYPE public."dispatchStatus" AS ENUM (
    'pending',
    'assigned',
    'in_transit',
    'delivered',
    'completed',
    'cancelled'
);

CREATE TYPE public.equipment_type AS ENUM (
    'machine',
    'attachment'
);

CREATE TYPE public."fleetStatus" AS ENUM (
    'available',
    'rented',
    'maintenance',
    'retired'
);

CREATE TYPE public."inspectionType" AS ENUM (
    'dispatch',
    'return',
    'general'
);

CREATE TYPE public."insuranceType" AS ENUM (
    'none',
    'basic',
    'full'
);

CREATE TYPE public."interactionType" AS ENUM (
    'call',
    'email',
    'note',
    'visit',
    'complaint',
    'follow_up'
);

CREATE TYPE public."invoiceStatus" AS ENUM (
    'draft',
    'sent',
    'paid',
    'partial',
    'overdue',
    'cancelled',
    'credited'
);

CREATE TYPE public."invoiceType" AS ENUM (
    'rental',
    'fuel_surcharge',
    'damage',
    'delivery',
    'credit_note',
    'manual'
);

CREATE TYPE public."paymentMethod" AS ENUM (
    'cash',
    'cheque',
    'e_transfer',
    'credit_card',
    'bank_transfer',
    'other'
);

CREATE TYPE public."paymentStatus" AS ENUM (
    'pending',
    'paid',
    'partial',
    'refunded',
    'failed'
);

CREATE TYPE public."quotationStatus" AS ENUM (
    'draft',
    'sent',
    'accepted',
    'rejected',
    'expired',
    'cancelled'
);

CREATE TYPE public."rentalStatus" AS ENUM (
    'pending',
    'approved',
    'rejected',
    'active',
    'completed',
    'cancelled',
    'overdue'
);

CREATE TYPE public."settingCategory" AS ENUM (
    'insurance',
    'deposits',
    'pricing',
    'rental_rules'
);

CREATE TYPE public.unified_role AS ENUM (
    'super_admin',
    'admin',
    'user',
    'field_staff',
    'accountant'
);

CREATE TYPE public."workOrderPriority" AS ENUM (
    'low',
    'normal',
    'high',
    'urgent'
);

CREATE TYPE public."workOrderStatus" AS ENUM (
    'open',
    'assigned',
    'in_progress',
    'on_hold',
    'completed',
    'cancelled'
);

CREATE TYPE public."workOrderType" AS ENUM (
    'pm1_250h',
    'pm2_500h',
    'pm3_1000h',
    'pm4_2000h',
    'repair',
    'inspection',
    'other'
);

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;

CREATE TABLE public.attachment_compatibility (
    id integer NOT NULL,
    "attachmentCatalogId" integer NOT NULL,
    "machineCatalogId" integer NOT NULL,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.attachment_compatibility_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.attachment_compatibility_id_seq OWNED BY public.attachment_compatibility.id;

CREATE TABLE public.audit_logs (
    id integer NOT NULL,
    "userId" integer,
    action character varying(50) NOT NULL,
    "entityType" character varying(50) NOT NULL,
    "entityId" integer,
    changes text,
    metadata text,
    "ipAddress" character varying(45),
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;

CREATE TABLE public.catalog_cache (
    id integer NOT NULL,
    "sourceType" public."catalogSource" NOT NULL,
    "sourceId" integer,
    brand character varying(100) NOT NULL,
    model character varying(200) NOT NULL,
    category character varying(100) NOT NULL,
    "modelYear" integer,
    description text,
    specifications text,
    msrp numeric(10,2),
    "imageUrl" text,
    "galleryImages" text,
    "enginePower" character varying(50),
    "operatingWeight" character varying(50),
    "bucketCapacity" character varying(50),
    "ratedLoad" character varying(50),
    checksum character varying(64),
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "availabilityStatus" character varying(50) DEFAULT 'available'::character varying,
    "leadTimeDays" integer,
    "displayOrder" integer DEFAULT 0,
    "brochureUrl" text,
    "videoUrl" text,
    equipment_type public.equipment_type DEFAULT 'machine'::public.equipment_type NOT NULL
);

CREATE SEQUENCE public.catalog_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.catalog_cache_id_seq OWNED BY public.catalog_cache.id;

CREATE TABLE public.catalog_sync_log (
    id integer NOT NULL,
    "syncType" character varying(50) NOT NULL,
    status character varying(50) NOT NULL,
    "industrialCount" integer DEFAULT 0,
    "powersportsCount" integer DEFAULT 0,
    "insertedCount" integer DEFAULT 0,
    "updatedCount" integer DEFAULT 0,
    "skippedCount" integer DEFAULT 0,
    "errorMessage" text,
    "durationMs" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.catalog_sync_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.catalog_sync_log_id_seq OWNED BY public.catalog_sync_log.id;

CREATE TABLE public.contract_templates (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    content text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.contract_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.contract_templates_id_seq OWNED BY public.contract_templates.id;

CREATE TABLE public.customer_credit_entries (
    id integer NOT NULL,
    "customerId" integer NOT NULL,
    "rentalRequestId" integer,
    "invoiceId" integer,
    amount numeric(12,2) NOT NULL,
    "entryType" character varying(40) NOT NULL,
    "sourceKey" character varying(120),
    notes text,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE SEQUENCE public.customer_credit_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.customer_credit_entries_id_seq OWNED BY public.customer_credit_entries.id;

CREATE TABLE public.customer_interactions (
    id integer NOT NULL,
    "customerId" integer NOT NULL,
    type public."interactionType" NOT NULL,
    summary text NOT NULL,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.customer_interactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.customer_interactions_id_seq OWNED BY public.customer_interactions.id;

CREATE TABLE public.customer_merge_log (
    id integer NOT NULL,
    loser_id integer NOT NULL,
    survivor_id integer NOT NULL,
    phone_norm text NOT NULL,
    merged_at timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.customer_merge_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.customer_merge_log_id_seq OWNED BY public.customer_merge_log.id;

CREATE TABLE public.customer_pricing (
    id integer NOT NULL,
    "customerId" integer NOT NULL,
    "rentalFleetId" integer,
    category character varying(100),
    "dailyRate" numeric(10,2),
    "weeklyRate" numeric(10,2),
    "monthlyRate" numeric(10,2),
    "twentyEightDayRate" numeric(10,2),
    "discountPercent" numeric(5,2),
    "validFrom" timestamp without time zone NOT NULL,
    "validTo" timestamp without time zone,
    "isActive" boolean DEFAULT true NOT NULL,
    notes text,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.customer_pricing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.customer_pricing_id_seq OWNED BY public.customer_pricing.id;

CREATE TABLE public.customer_sessions (
    id integer NOT NULL,
    "customerId" integer NOT NULL,
    token character varying(64) NOT NULL,
    "expiresAt" timestamp without time zone NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.customer_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.customer_sessions_id_seq OWNED BY public.customer_sessions.id;

CREATE TABLE public.customers (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    email character varying(255),
    phone character varying(50),
    company character varying(255),
    address text,
    city character varying(100),
    province character varying(100),
    "postalCode" character varying(20),
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    tags json DEFAULT '[]'::json,
    source public."customerSource" DEFAULT 'website'::public."customerSource",
    "totalRentals" integer DEFAULT 0 NOT NULL,
    "totalRevenue" numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    "lastRentalDate" timestamp without time zone,
    "nextFollowUp" timestamp without time zone,
    "followUpNotes" text,
    "lastContactedAt" timestamp without time zone,
    "riskScore" integer DEFAULT 50,
    "referralCodeId" integer,
    "referralBoundAt" timestamp without time zone,
    "creditLimit" numeric(12,2),
    "isBlacklisted" boolean DEFAULT false NOT NULL,
    "blacklistReason" text,
    "blacklistedAt" timestamp without time zone,
    birthday date,
    "greetingOptIn" boolean DEFAULT true NOT NULL,
    "discountPercent" numeric(5,2) DEFAULT 0 NOT NULL,
    industry character varying(40),
    "preferredLanguage" character varying(20),
    "classificationConfirmedAt" timestamp without time zone,
    "classificationConfirmedBy" integer,
    "secondaryIndustries" text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE SEQUENCE public.customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;

CREATE TABLE public.damage_claims (
    id integer NOT NULL,
    "inspectionId" integer,
    "rentalId" integer,
    "customerId" integer,
    description text NOT NULL,
    "repairEstimate" numeric(10,2),
    "approvedAmount" numeric(10,2),
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "invoiceId" integer,
    "customerResponse" text,
    "resolvedAt" timestamp without time zone,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "chargeType" character varying(20) DEFAULT 'damage'::character varying NOT NULL,
    amount numeric(12,2),
    "deletedAt" timestamp without time zone
);

CREATE SEQUENCE public.damage_claims_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.damage_claims_id_seq OWNED BY public.damage_claims.id;

CREATE TABLE public.deposit_rules (
    id integer NOT NULL,
    category character varying(255) NOT NULL,
    "depositType" character varying(20) DEFAULT 'percentage'::character varying NOT NULL,
    value numeric(10,4) NOT NULL,
    "minDeposit" numeric(12,2) DEFAULT 500 NOT NULL,
    "maxDeposit" numeric(12,2),
    priority integer DEFAULT 100 NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE SEQUENCE public.deposit_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deposit_rules_id_seq OWNED BY public.deposit_rules.id;

CREATE TABLE public.dispatch_orders (
    id integer NOT NULL,
    "orderType" public."dispatchOrderType" NOT NULL,
    "rentalRequestId" integer,
    "rentalFleetId" integer,
    "customerId" integer,
    "assignedDriverId" integer,
    status public."dispatchStatus" DEFAULT 'pending'::public."dispatchStatus" NOT NULL,
    "scheduledDate" timestamp without time zone,
    "completedDate" timestamp without time zone,
    "pickupAddress" text,
    "deliveryAddress" text,
    "pickupWarehouseId" integer,
    "deliveryWarehouseId" integer,
    "shippingCost" numeric(10,2),
    notes text,
    "driverNotes" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "pickupProvince" character varying(100),
    "deliveryProvince" character varying(100),
    distance numeric(10,2),
    "scheduledTimeSlot" character varying(50),
    priority character varying(20) DEFAULT 'normal'::character varying,
    "deletedAt" timestamp without time zone,
    "pdfUrl" text,
    "customerConfirmedAt" timestamp without time zone,
    "customerConfirmationSignature" text,
    "driverConfirmedAt" timestamp without time zone,
    "confirmationToken" text NOT NULL
);

CREATE SEQUENCE public.dispatch_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.dispatch_orders_id_seq OWNED BY public.dispatch_orders.id;

CREATE TABLE public.downtime_records (
    id integer NOT NULL,
    "rentalId" integer,
    "rentalFleetId" integer,
    "reportedAt" timestamp without time zone NOT NULL,
    "resolvedAt" timestamp without time zone,
    "totalCalendarDays" integer DEFAULT 0,
    "excludedDays" integer DEFAULT 0,
    "workingDaysLost" integer DEFAULT 0,
    "dailyRateAtTime" numeric(10,2),
    "creditAmount" numeric(10,2) DEFAULT 0,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    reason text,
    resolution text,
    "creditInvoiceId" integer,
    "reportedBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.downtime_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.downtime_records_id_seq OWNED BY public.downtime_records.id;

CREATE TABLE public.drivers (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    phone character varying(50),
    email character varying(255),
    "userId" integer,
    "licenseNumber" character varying(100),
    "licenseExpiry" timestamp without time zone,
    "vehicleInfo" text,
    "isActive" boolean DEFAULT true NOT NULL,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE SEQUENCE public.drivers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.drivers_id_seq OWNED BY public.drivers.id;

CREATE TABLE public.equipment_categories (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    "displayOrder" integer DEFAULT 0,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    equipment_type public.equipment_type DEFAULT 'machine'::public.equipment_type NOT NULL
);

CREATE SEQUENCE public.equipment_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.equipment_categories_id_seq OWNED BY public.equipment_categories.id;

CREATE TABLE public.equipment_model_price_versions (
    id integer NOT NULL,
    equipment_model_id integer NOT NULL,
    "dailyRate" numeric(12,2),
    "weeklyRate" numeric(12,2),
    "monthlyRate" numeric(12,2),
    "twentyEightDayRate" numeric(12,2),
    effective_from timestamp without time zone NOT NULL,
    effective_to timestamp without time zone,
    source character varying(50) DEFAULT 'manual'::character varying NOT NULL,
    note text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    superseded_at timestamp without time zone
);

CREATE SEQUENCE public.equipment_model_price_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.equipment_model_price_versions_id_seq OWNED BY public.equipment_model_price_versions.id;

CREATE TABLE public.equipment_models (
    id integer NOT NULL,
    category character varying(255) NOT NULL,
    brand character varying(255) NOT NULL,
    model character varying(255) NOT NULL,
    "displayName" character varying(500),
    "imageUrl" text,
    "dailyRate" numeric(12,2),
    "weeklyRate" numeric(12,2),
    "monthlyRate" numeric(12,2),
    "twentyEightDayRate" numeric(12,2),
    description text,
    specs jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    equipment_type public.equipment_type DEFAULT 'machine'::public.equipment_type NOT NULL
);

CREATE SEQUENCE public.equipment_models_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.equipment_models_id_seq OWNED BY public.equipment_models.id;

CREATE TABLE public.extension_requests (
    id integer NOT NULL,
    "rentalRequestId" integer,
    "customerId" integer,
    "requestedEndDate" timestamp without time zone NOT NULL,
    reason text,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "adminNotes" text,
    "reviewedBy" integer,
    "reviewedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.extension_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.extension_requests_id_seq OWNED BY public.extension_requests.id;

CREATE TABLE public.feature_flags (
    id integer NOT NULL,
    key character varying(100) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.feature_flags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.feature_flags_id_seq OWNED BY public.feature_flags.id;

CREATE TABLE public.inspection_tokens (
    id integer NOT NULL,
    "tokenHash" character varying(64) NOT NULL,
    "rentalId" integer,
    "rentalFleetId" integer,
    "inspectionType" public."inspectionType" NOT NULL,
    "createdBy" integer,
    "isUsed" boolean DEFAULT false NOT NULL,
    "expiresAt" timestamp without time zone NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.inspection_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.inspection_tokens_id_seq OWNED BY public.inspection_tokens.id;

CREATE TABLE public.inspections (
    id integer NOT NULL,
    type public."inspectionType" NOT NULL,
    "rentalId" integer,
    "rentalFleetId" integer,
    "equipmentSelected" text,
    "inspectorName" character varying(255),
    "inspectorId" integer,
    "engineHours" numeric(10,1),
    "hourMeter" numeric(10,1),
    "fuelLevel" integer,
    "odometerReading" integer,
    "overallCondition" public.condition,
    "damageNotes" text,
    "locationAddress" text,
    latitude numeric(10,7),
    longitude numeric(10,7),
    "photoFront" text,
    "photoBack" text,
    "photoLeft" text,
    "photoRight" text,
    "photoAdditional" text,
    "customerSignature" text,
    "customerSignedAt" timestamp without time zone,
    notes text,
    "offlineId" text,
    "syncedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "damageSeverity" character varying(20),
    "deletedAt" timestamp without time zone,
    "pdfUrl" text,
    "fuelLevelPercent" integer,
    "fuelChargeAmount" numeric(12,2),
    "signatureIp" character varying(45),
    "signatureUserAgent" text,
    "signatureDocumentHash" character varying(64),
    CONSTRAINT fuel_level_percent_range CHECK ((("fuelLevelPercent" IS NULL) OR (("fuelLevelPercent" >= 0) AND ("fuelLevelPercent" <= 100))))
);

CREATE SEQUENCE public.inspections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.inspections_id_seq OWNED BY public.inspections.id;

CREATE TABLE public.invoice_line_items (
    id integer NOT NULL,
    "invoiceId" integer,
    description text NOT NULL,
    quantity numeric(10,2) DEFAULT 1 NOT NULL,
    "unitPrice" numeric(12,2) NOT NULL,
    amount numeric(12,2) NOT NULL,
    "lineType" character varying(50),
    "sortOrder" integer DEFAULT 0,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.invoice_line_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.invoice_line_items_id_seq OWNED BY public.invoice_line_items.id;

CREATE TABLE public.invoices (
    id integer NOT NULL,
    "invoiceNumber" character varying(50) NOT NULL,
    "rentalId" integer,
    "customerId" integer,
    "projectId" integer,
    type public."invoiceType" DEFAULT 'rental'::public."invoiceType" NOT NULL,
    status public."invoiceStatus" DEFAULT 'draft'::public."invoiceStatus" NOT NULL,
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    "taxAmount" numeric(12,2) DEFAULT 0 NOT NULL,
    "taxBreakdown" text,
    "totalAmount" numeric(12,2) DEFAULT 0 NOT NULL,
    "amountPaid" numeric(12,2) DEFAULT 0 NOT NULL,
    "balanceDue" numeric(12,2) DEFAULT 0 NOT NULL,
    "gstHstNumber" character varying(20),
    "taxProvince" character varying(2),
    "issueDate" timestamp without time zone DEFAULT now(),
    "dueDate" timestamp without time zone,
    "paidDate" timestamp without time zone,
    "pdfUrl" text,
    notes text,
    "internalNotes" text,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "sourceKey" character varying(160),
    "emailSentAt" timestamp without time zone
);

COMMENT ON COLUMN public.invoices."emailSentAt" IS 'Set only when the invoice PDF was actually accepted by the email provider. NULL means never emailed, regardless of status.';

CREATE SEQUENCE public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;

CREATE TABLE public.login_sessions (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "sessionToken" character varying(64),
    "loginAt" timestamp without time zone DEFAULT now() NOT NULL,
    "logoutAt" timestamp without time zone,
    "lastActiveAt" timestamp without time zone DEFAULT now() NOT NULL,
    "durationSeconds" integer,
    "ipAddress" character varying(45),
    "userAgent" text,
    browser character varying(100),
    os character varying(100),
    "deviceType" character varying(20)
);

CREATE SEQUENCE public.login_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.login_sessions_id_seq OWNED BY public.login_sessions.id;

CREATE TABLE public.notification_log (
    id integer NOT NULL,
    channel character varying(20) NOT NULL,
    recipient character varying(255) NOT NULL,
    subject text,
    event character varying(100),
    status character varying(20) NOT NULL,
    "errorMessage" text,
    "relatedEntityType" character varying(50),
    "relatedEntityId" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.notification_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_log_id_seq OWNED BY public.notification_log.id;

CREATE TABLE public.notification_settings (
    id integer NOT NULL,
    provider character varying(50) NOT NULL,
    "configKey" character varying(100) NOT NULL,
    "configValue" text NOT NULL,
    "isActive" boolean DEFAULT true,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.notification_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_settings_id_seq OWNED BY public.notification_settings.id;

CREATE TABLE public.notification_templates (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    channel character varying(20) NOT NULL,
    event character varying(100) NOT NULL,
    subject text,
    body text NOT NULL,
    "isActive" boolean DEFAULT true,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.notification_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_templates_id_seq OWNED BY public.notification_templates.id;

CREATE TABLE public.otp_codes (
    id integer NOT NULL,
    phone character varying(20) NOT NULL,
    "codeHash" character varying(64) NOT NULL,
    "expiresAt" timestamp without time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    used boolean DEFAULT false NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.otp_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.otp_codes_id_seq OWNED BY public.otp_codes.id;

CREATE TABLE public.payments (
    id integer NOT NULL,
    "invoiceId" integer,
    amount numeric(12,2) NOT NULL,
    "paymentMethod" public."paymentMethod" NOT NULL,
    "paymentDate" timestamp without time zone NOT NULL,
    reference character varying(255),
    "stripePaymentIntentId" character varying(255),
    notes text,
    "recordedBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.payments_id_seq OWNED BY public.payments.id;

CREATE TABLE public.projects (
    id integer NOT NULL,
    "customerId" integer,
    name character varying(255) NOT NULL,
    "poNumber" character varying(100),
    "siteAddress" text,
    city character varying(100),
    province character varying(2),
    "postalCode" character varying(10),
    "contactName" character varying(255),
    "contactPhone" character varying(50),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    "startDate" timestamp without time zone,
    "endDate" timestamp without time zone,
    notes text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE SEQUENCE public.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;

CREATE TABLE public.promotions (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(50) DEFAULT 'driver_referral'::character varying NOT NULL,
    "discountPercent" numeric(5,2) DEFAULT 5.00 NOT NULL,
    "commissionPercent" numeric(5,2) DEFAULT 5.00 NOT NULL,
    "commissionBase" character varying(50) DEFAULT 'rental_fee'::character varying NOT NULL,
    "startDate" timestamp without time zone NOT NULL,
    "endDate" timestamp without time zone NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "maxUsesPerCode" integer,
    description text,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE SEQUENCE public.promotions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.promotions_id_seq OWNED BY public.promotions.id;

CREATE TABLE public.quotation_line_items (
    id integer NOT NULL,
    "quotationId" integer,
    description text NOT NULL,
    quantity numeric(10,2) DEFAULT '1'::numeric NOT NULL,
    "unitPrice" numeric(12,2) NOT NULL,
    amount numeric(12,2) NOT NULL,
    "lineType" character varying(50),
    "sortOrder" integer DEFAULT 0,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.quotation_line_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.quotation_line_items_id_seq OWNED BY public.quotation_line_items.id;

CREATE TABLE public.quotations (
    id integer NOT NULL,
    "quotationNumber" character varying(50) NOT NULL,
    "rentalId" integer,
    "customerId" integer,
    "projectId" integer,
    status public."quotationStatus" DEFAULT 'draft'::public."quotationStatus" NOT NULL,
    subtotal numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    "taxAmount" numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    "taxBreakdown" text,
    "totalAmount" numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    "gstHstNumber" character varying(20),
    "taxProvince" character varying(2),
    "issueDate" timestamp without time zone DEFAULT now(),
    "validUntil" timestamp without time zone,
    "pdfUrl" text,
    notes text,
    "internalNotes" text,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE SEQUENCE public.quotations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.quotations_id_seq OWNED BY public.quotations.id;

CREATE TABLE public.referral_codes (
    id integer NOT NULL,
    "promotionId" integer NOT NULL,
    "driverId" integer NOT NULL,
    code character varying(50) NOT NULL,
    "totalUses" integer DEFAULT 0 NOT NULL,
    "totalCommission" numeric(12,2) DEFAULT 0 NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.referral_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.referral_codes_id_seq OWNED BY public.referral_codes.id;

CREATE TABLE public.referral_ledger (
    id integer NOT NULL,
    "referralCodeId" integer NOT NULL,
    "rentalRequestId" integer,
    "customerId" integer,
    "driverId" integer,
    "rentalFee" numeric(12,2) DEFAULT 0 NOT NULL,
    "discountAmount" numeric(12,2) DEFAULT 0 NOT NULL,
    "commissionAmount" numeric(12,2) DEFAULT 0 NOT NULL,
    "commissionStatus" character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    "paidAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.referral_ledger_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.referral_ledger_id_seq OWNED BY public.referral_ledger.id;

CREATE TABLE public.refresh_tokens (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "tokenHash" text NOT NULL,
    "authType" character varying(50) NOT NULL,
    "deviceName" character varying(255),
    "expiresAt" timestamp without time zone NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.refresh_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.refresh_tokens_id_seq OWNED BY public.refresh_tokens.id;

CREATE TABLE public.reminder_deliveries (
    id integer NOT NULL,
    "entityType" character varying(30) NOT NULL,
    "entityId" integer NOT NULL,
    kind character varying(60) NOT NULL,
    channel character varying(20) NOT NULL,
    recipient character varying(255),
    "deliveredAt" timestamp without time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.reminder_deliveries IS 'Reminders confirmed delivered. Absence of a row means "not yet reminded" — never write here on a skipped or failed send.';

CREATE SEQUENCE public.reminder_deliveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.reminder_deliveries_id_seq OWNED BY public.reminder_deliveries.id;

CREATE TABLE public.rental_asset_progress_events (
    id integer NOT NULL,
    "eventKey" character varying(255) NOT NULL,
    "rentalRequestId" integer,
    "rentalFleetId" integer,
    "eventType" character varying(80) NOT NULL,
    "fromStage" character varying(40),
    "toStage" character varying(40),
    source character varying(30) NOT NULL,
    "sourceEntityType" character varying(50),
    "sourceEntityId" integer,
    reason text,
    "actorUserId" integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.rental_asset_progress_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_asset_progress_events_id_seq OWNED BY public.rental_asset_progress_events.id;

CREATE TABLE public.rental_asset_return_operations (
    id integer NOT NULL,
    "rentalRequestId" integer NOT NULL,
    "rentalFleetId" integer NOT NULL,
    "returnRequestedAt" timestamp without time zone NOT NULL,
    "customerReadyAt" timestamp without time zone NOT NULL,
    "scheduledPickupAt" timestamp without time zone,
    "delayResponsibility" character varying(20) DEFAULT 'none'::character varying NOT NULL,
    "billingStopAt" timestamp without time zone,
    "pickedUpAt" timestamp without time zone,
    "readyRecordedBy" integer,
    "responsibilitySetBy" integer,
    "pickedUpBy" integer,
    "responsibilityReason" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "rental_asset_return_operations_delayResponsibility_check" CHECK ((("delayResponsibility")::text = ANY ((ARRAY['company'::character varying, 'customer'::character varying, 'none'::character varying])::text[])))
);

CREATE SEQUENCE public.rental_asset_return_operations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_asset_return_operations_id_seq OWNED BY public.rental_asset_return_operations.id;

CREATE TABLE public.rental_charges (
    id integer NOT NULL,
    "rentalRequestId" integer NOT NULL,
    "chargeType" character varying(20) NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    description text,
    "chargeDate" timestamp without time zone DEFAULT now() NOT NULL,
    "oldRentalFleetId" integer,
    "newRentalFleetId" integer,
    "invoiceId" integer,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone
);

CREATE SEQUENCE public.rental_charges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_charges_id_seq OWNED BY public.rental_charges.id;

CREATE TABLE public.rental_fleet (
    id integer NOT NULL,
    "catalogCacheId" integer,
    brand character varying(100) NOT NULL,
    model character varying(200) NOT NULL,
    category character varying(100),
    year integer,
    "serialNumber" character varying(100),
    "internalId" character varying(100),
    "currentStatus" public."fleetStatus" DEFAULT 'available'::public."fleetStatus" NOT NULL,
    "locationId" integer,
    division character varying(50),
    "dailyRate" numeric(10,2),
    "weeklyRate" numeric(10,2),
    "monthlyRate" numeric(10,2),
    "engineHours" integer,
    "odometerReading" integer,
    condition public.condition DEFAULT 'good'::public.condition,
    notes text,
    "imageUrl" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "assetNumber" character varying(50),
    vin character varying(17),
    "purchaseDate" timestamp without time zone,
    "purchaseCost" numeric(10,2),
    "lastMaintenanceDate" timestamp without time zone,
    "nextMaintenanceDate" timestamp without time zone,
    "lastServiceHours" integer,
    "serviceInterval" integer DEFAULT 250,
    "maintenanceStatus" character varying(20) DEFAULT 'ok'::character varying,
    "deletedAt" timestamp without time zone,
    "twentyEightDayRate" numeric(10,2),
    "fuelTankCapacityLitres" integer,
    "equipmentModelId" integer
);

CREATE SEQUENCE public.rental_fleet_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_fleet_id_seq OWNED BY public.rental_fleet.id;

CREATE TABLE public.rental_lifecycle_effects (
    id integer NOT NULL,
    "commandKey" character varying(220) NOT NULL,
    "rentalRequestId" integer NOT NULL,
    "effectType" character varying(50) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    "nextAttemptAt" timestamp with time zone DEFAULT now() NOT NULL,
    "completedAt" timestamp with time zone,
    "lastError" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT rental_lifecycle_effects_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'completed'::character varying, 'failed'::character varying, 'manual_review'::character varying, 'skipped'::character varying])::text[])))
);

CREATE SEQUENCE public.rental_lifecycle_effects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_lifecycle_effects_id_seq OWNED BY public.rental_lifecycle_effects.id;

CREATE TABLE public.rental_line_items (
    id integer NOT NULL,
    "rentalRequestId" integer NOT NULL,
    "rentalFleetId" integer,
    "equipmentModelId" integer,
    "itemType" public.equipment_type DEFAULT 'machine'::public.equipment_type NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    "dailyRate" numeric(12,2),
    "weeklyRate" numeric(12,2),
    "monthlyRate" numeric(12,2),
    "customerEquipmentNote" text,
    "compatibilityAcknowledgedAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "startDate" timestamp without time zone,
    "endDate" timestamp without time zone,
    "lineDeposit" numeric(12,2),
    "lineSubtotal" numeric(12,2),
    CONSTRAINT rental_line_items_quantity_check CHECK ((quantity > 0))
);

CREATE SEQUENCE public.rental_line_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_line_items_id_seq OWNED BY public.rental_line_items.id;

CREATE TABLE public.rental_prepayments (
    id integer NOT NULL,
    "rentalRequestId" integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    "paymentMethod" character varying(40),
    "paymentDate" timestamp without time zone DEFAULT now() NOT NULL,
    notes text,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "invoiceId" integer,
    "appliedAt" timestamp without time zone,
    "appliedBy" integer,
    "transferredToCreditAt" timestamp without time zone,
    "transferredToCreditBy" integer
);

CREATE SEQUENCE public.rental_prepayments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_prepayments_id_seq OWNED BY public.rental_prepayments.id;

CREATE TABLE public.rental_requests (
    id integer NOT NULL,
    "rentalFleetId" integer,
    "customerId" integer,
    "customerName" character varying(255) NOT NULL,
    "customerEmail" character varying(255),
    "customerPhone" character varying(50),
    "customerCompany" character varying(255),
    "equipmentDescription" text,
    "startDate" timestamp without time zone NOT NULL,
    "endDate" timestamp without time zone NOT NULL,
    status public."rentalStatus" DEFAULT 'pending'::public."rentalStatus" NOT NULL,
    "paymentStatus" public."paymentStatus" DEFAULT 'pending'::public."paymentStatus" NOT NULL,
    "totalAmount" numeric(12,2),
    "depositAmount" numeric(12,2),
    "stripePaymentIntentId" character varying(255),
    "stripeCheckoutSessionId" character varying(255),
    "deliveryAddress" text,
    "deliveryNotes" text,
    "contractUrl" text,
    "contractVersion" integer DEFAULT 1,
    "contractSignedAt" timestamp without time zone,
    "deliveryInspectionCompleted" boolean DEFAULT false NOT NULL,
    "returnInspectionCompleted" boolean DEFAULT false NOT NULL,
    "deliveryInspectionId" integer,
    "returnInspectionId" integer,
    "adminNotes" text,
    "customerNotes" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deliveryMethod" public."deliveryMethod" DEFAULT 'pickup'::public."deliveryMethod",
    "deliveryProvince" character varying(2),
    "pickupProvince" character varying(2),
    "taxProvince" character varying(2),
    "rentalFee" numeric(12,2),
    "freightCost" numeric(12,2),
    "taxAmount" numeric(12,2),
    "taxBreakdown" text,
    "insuranceType" public."insuranceType" DEFAULT 'none'::public."insuranceType",
    "insuranceCost" numeric(12,2),
    "depositPaid" boolean DEFAULT false,
    "contractGenerated" boolean DEFAULT false,
    "contractGeneratedAt" timestamp without time zone,
    "projectDescription" text,
    "deletedAt" timestamp without time zone,
    "billingCycleType" character varying(10) DEFAULT 'calendar'::character varying,
    "shiftType" character varying(10) DEFAULT 'single'::character varying,
    "standardHoursPerDay" integer DEFAULT 8,
    "overtimeHours" numeric(10,2) DEFAULT 0,
    "overtimeCost" numeric(12,2) DEFAULT 0,
    "shiftMultiplier" numeric(3,2) DEFAULT 1.00,
    "fuelPolicy" character varying(20) DEFAULT 'full_to_full'::character varying,
    "fuelPricePerLitre" numeric(6,2),
    "projectId" integer,
    "hireType" character varying(10) DEFAULT 'dry'::character varying,
    "equipmentModelId" integer,
    "orderConfirmationPdfUrl" text,
    "contractTemplateId" integer,
    "rentalNumber" character varying(20),
    "referralCodeId" integer,
    "referralDiscount" numeric(12,2),
    "insuranceDocsReceived" boolean DEFAULT false NOT NULL,
    "scheduledDeliveryTime" character varying(5),
    "scheduledPickupTime" character varying(5),
    "parentRentalId" integer,
    "estimatedLateFee" numeric(12,2),
    "lateFeeLastComputedAt" timestamp without time zone,
    "signatureIp" character varying(45),
    "signatureUserAgent" text,
    "signatureContractHash" character varying(64),
    "customerSignature" text,
    "repSignature" text,
    "repSignedAt" timestamp without time zone,
    "repSignedBy" integer,
    "customerEquipmentNote" text,
    "compatibilityAcknowledgedAt" timestamp without time zone,
    "isCreditOrder" boolean DEFAULT false NOT NULL,
    "creditFinalizedAt" timestamp without time zone,
    "creditFinalizedBy" integer,
    "financialOrderNumber" character varying(40),
    "cardLast4" character varying(4),
    "priceMatchEnabled" boolean DEFAULT false NOT NULL,
    "priceMatchCompetitor" character varying(255),
    "priceMatchAmount" numeric(12,2),
    "priceMatchNote" text,
    "customerDiscountPercent" numeric(5,2),
    "deliveryDistanceKm" numeric(10,2),
    "freightEstimated" boolean DEFAULT false NOT NULL,
    "priceMatchFields" jsonb,
    "lifecycleVersion" integer
);

CREATE SEQUENCE public.rental_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_requests_id_seq OWNED BY public.rental_requests.id;

CREATE TABLE public.rental_rolling_terms (
    id integer NOT NULL,
    "rentalRequestId" integer NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    "cycleDays" integer DEFAULT 28 NOT NULL,
    "confirmedAt" timestamp without time zone NOT NULL,
    "confirmedBy" integer,
    "billingStartedAt" timestamp without time zone NOT NULL,
    "billedThroughDate" timestamp without time zone NOT NULL,
    "nextSettlementDate" timestamp without time zone NOT NULL,
    "billingStopAt" timestamp without time zone,
    "endedAt" timestamp without time zone,
    "endedBy" integer,
    "endReason" text,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT "rental_rolling_terms_cycleDays_check" CHECK (("cycleDays" = 28)),
    CONSTRAINT rental_rolling_terms_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'ending'::character varying, 'ended'::character varying])::text[])))
);

CREATE SEQUENCE public.rental_rolling_terms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_rolling_terms_id_seq OWNED BY public.rental_rolling_terms.id;

CREATE TABLE public.rental_settings (
    id integer NOT NULL,
    key character varying(100) NOT NULL,
    value text NOT NULL,
    description text,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    category public."settingCategory"
);

CREATE SEQUENCE public.rental_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rental_settings_id_seq OWNED BY public.rental_settings.id;

CREATE TABLE public.role_permissions (
    id integer NOT NULL,
    role public.unified_role NOT NULL,
    module character varying(50) NOT NULL,
    "canCreate" boolean DEFAULT false NOT NULL,
    "canRead" boolean DEFAULT false NOT NULL,
    "canUpdate" boolean DEFAULT false NOT NULL,
    "canDelete" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.role_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.role_permissions_id_seq OWNED BY public.role_permissions.id;

CREATE TABLE public.sessions (
    id integer NOT NULL,
    token character varying(64) NOT NULL,
    "sessionType" character varying(20) NOT NULL,
    "userId" integer NOT NULL,
    email character varying(255),
    role character varying(20),
    "expiresAt" timestamp without time zone NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;

CREATE TABLE public.shipping_pricing_equipment_mapping (
    id integer NOT NULL,
    "pricingTierId" integer NOT NULL,
    "rentalFleetId" integer
);

CREATE SEQUENCE public.shipping_pricing_equipment_mapping_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.shipping_pricing_equipment_mapping_id_seq OWNED BY public.shipping_pricing_equipment_mapping.id;

CREATE TABLE public.shipping_pricing_rules (
    id integer NOT NULL,
    "pricingTierId" integer NOT NULL,
    "equipmentModelId" integer,
    category character varying(255),
    priority integer DEFAULT 100 NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.shipping_pricing_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.shipping_pricing_rules_id_seq OWNED BY public.shipping_pricing_rules.id;

CREATE TABLE public.shipping_pricing_tiers (
    id integer NOT NULL,
    "tierName" character varying(100) NOT NULL,
    "baseFee" numeric(10,2) NOT NULL,
    "includedKilometers" numeric(10,2) NOT NULL,
    "pricePerKmAfter" numeric(10,2) NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.shipping_pricing_tiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.shipping_pricing_tiers_id_seq OWNED BY public.shipping_pricing_tiers.id;

CREATE TABLE public.site_settings (
    id integer NOT NULL,
    key character varying(100) NOT NULL,
    value text NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.site_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.site_settings_id_seq OWNED BY public.site_settings.id;

CREATE TABLE public.tax_rates (
    id integer NOT NULL,
    province character varying(2) NOT NULL,
    "provinceName" character varying(100) NOT NULL,
    "gstRate" numeric(5,4) DEFAULT '0'::numeric NOT NULL,
    "pstRate" numeric(5,4) DEFAULT '0'::numeric NOT NULL,
    "hstRate" numeric(5,4) DEFAULT '0'::numeric NOT NULL,
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.tax_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tax_rates_id_seq OWNED BY public.tax_rates.id;

CREATE TABLE public.user_permission_overrides (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    module character varying(50) NOT NULL,
    "canCreate" boolean,
    "canRead" boolean,
    "canUpdate" boolean,
    "canDelete" boolean,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.user_permission_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_permission_overrides_id_seq OWNED BY public.user_permission_overrides.id;

CREATE TABLE public.user_permissions (
    id integer NOT NULL,
    "userId" integer NOT NULL,
    "canManageUsers" boolean DEFAULT false NOT NULL,
    "canManageRentals" boolean DEFAULT true NOT NULL,
    "canManageInvoices" boolean DEFAULT true NOT NULL,
    "canEditPricing" boolean DEFAULT false NOT NULL,
    "canManageCustomers" boolean DEFAULT true NOT NULL,
    "canManageFleet" boolean DEFAULT true NOT NULL,
    "canViewReports" boolean DEFAULT true NOT NULL,
    "canManageSettings" boolean DEFAULT false NOT NULL,
    "canExportData" boolean DEFAULT false NOT NULL,
    "canDeleteRecords" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.user_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_permissions_id_seq OWNED BY public.user_permissions.id;

CREATE TABLE public.users (
    id integer NOT NULL,
    username character varying(100),
    email character varying(255),
    name character varying(255),
    "passwordHash" text,
    "isActive" boolean DEFAULT true NOT NULL,
    "lastSignedIn" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    phone character varying(20),
    role public.unified_role DEFAULT 'user'::public.unified_role NOT NULL
);

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

CREATE TABLE public.warehouses (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    address text,
    city character varying(100),
    province character varying(100),
    "postalCode" character varying(20),
    phone character varying(50),
    "isActive" boolean DEFAULT true NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "isPrimary" boolean DEFAULT false NOT NULL,
    "contactName" character varying(255),
    "contactPhone" character varying(50),
    "contactEmail" character varying(255),
    "deletedAt" timestamp without time zone,
    "updatedAt" timestamp without time zone DEFAULT now()
);

CREATE SEQUENCE public.warehouses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.warehouses_id_seq OWNED BY public.warehouses.id;

CREATE TABLE public.work_order_labor (
    id integer NOT NULL,
    "workOrderId" integer NOT NULL,
    "technicianName" character varying(120) NOT NULL,
    "userId" integer,
    "workDetail" text,
    "startAt" timestamp without time zone NOT NULL,
    "endAt" timestamp without time zone,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.work_order_labor_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.work_order_labor_id_seq OWNED BY public.work_order_labor.id;

CREATE TABLE public.work_order_parts (
    id integer NOT NULL,
    "workOrderId" integer,
    "partName" character varying(255) NOT NULL,
    "partNumber" character varying(100),
    quantity numeric(10,2) DEFAULT 1 NOT NULL,
    "unitCost" numeric(10,2) NOT NULL,
    "totalCost" numeric(10,2) NOT NULL,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.work_order_parts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.work_order_parts_id_seq OWNED BY public.work_order_parts.id;

CREATE TABLE public.work_orders (
    id integer NOT NULL,
    "workOrderNumber" character varying(50) NOT NULL,
    "rentalFleetId" integer,
    type public."workOrderType" DEFAULT 'other'::public."workOrderType" NOT NULL,
    priority public."workOrderPriority" DEFAULT 'normal'::public."workOrderPriority" NOT NULL,
    status public."workOrderStatus" DEFAULT 'open'::public."workOrderStatus" NOT NULL,
    "assignedTo" integer,
    "estimatedHours" numeric(6,2),
    "actualHours" numeric(6,2),
    "laborRate" numeric(10,2),
    "laborCost" numeric(10,2) DEFAULT 0,
    "partsCost" numeric(10,2) DEFAULT 0,
    "totalCost" numeric(10,2) DEFAULT 0,
    "triggerEngineHours" integer,
    "scheduledDate" timestamp without time zone,
    "startedAt" timestamp without time zone,
    "completedAt" timestamp without time zone,
    description text,
    findings text,
    resolution text,
    notes text,
    "createdBy" integer,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL,
    "deletedAt" timestamp without time zone,
    "damageClaimId" integer,
    "customerName" character varying(255),
    "customerPhone" character varying(50),
    "equipmentSource" character varying(20),
    "equipmentSourceNote" character varying(255),
    "plateNumber" character varying(50),
    "meterKms" integer,
    "meterHours" numeric(10,1)
);

CREATE SEQUENCE public.work_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.work_orders_id_seq OWNED BY public.work_orders.id;

ALTER TABLE ONLY public.attachment_compatibility ALTER COLUMN id SET DEFAULT nextval('public.attachment_compatibility_id_seq'::regclass);

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);

ALTER TABLE ONLY public.catalog_cache ALTER COLUMN id SET DEFAULT nextval('public.catalog_cache_id_seq'::regclass);

ALTER TABLE ONLY public.catalog_sync_log ALTER COLUMN id SET DEFAULT nextval('public.catalog_sync_log_id_seq'::regclass);

ALTER TABLE ONLY public.contract_templates ALTER COLUMN id SET DEFAULT nextval('public.contract_templates_id_seq'::regclass);

ALTER TABLE ONLY public.customer_credit_entries ALTER COLUMN id SET DEFAULT nextval('public.customer_credit_entries_id_seq'::regclass);

ALTER TABLE ONLY public.customer_interactions ALTER COLUMN id SET DEFAULT nextval('public.customer_interactions_id_seq'::regclass);

ALTER TABLE ONLY public.customer_merge_log ALTER COLUMN id SET DEFAULT nextval('public.customer_merge_log_id_seq'::regclass);

ALTER TABLE ONLY public.customer_pricing ALTER COLUMN id SET DEFAULT nextval('public.customer_pricing_id_seq'::regclass);

ALTER TABLE ONLY public.customer_sessions ALTER COLUMN id SET DEFAULT nextval('public.customer_sessions_id_seq'::regclass);

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);

ALTER TABLE ONLY public.damage_claims ALTER COLUMN id SET DEFAULT nextval('public.damage_claims_id_seq'::regclass);

ALTER TABLE ONLY public.deposit_rules ALTER COLUMN id SET DEFAULT nextval('public.deposit_rules_id_seq'::regclass);

ALTER TABLE ONLY public.dispatch_orders ALTER COLUMN id SET DEFAULT nextval('public.dispatch_orders_id_seq'::regclass);

ALTER TABLE ONLY public.downtime_records ALTER COLUMN id SET DEFAULT nextval('public.downtime_records_id_seq'::regclass);

ALTER TABLE ONLY public.drivers ALTER COLUMN id SET DEFAULT nextval('public.drivers_id_seq'::regclass);

ALTER TABLE ONLY public.equipment_categories ALTER COLUMN id SET DEFAULT nextval('public.equipment_categories_id_seq'::regclass);

ALTER TABLE ONLY public.equipment_model_price_versions ALTER COLUMN id SET DEFAULT nextval('public.equipment_model_price_versions_id_seq'::regclass);

ALTER TABLE ONLY public.equipment_models ALTER COLUMN id SET DEFAULT nextval('public.equipment_models_id_seq'::regclass);

ALTER TABLE ONLY public.extension_requests ALTER COLUMN id SET DEFAULT nextval('public.extension_requests_id_seq'::regclass);

ALTER TABLE ONLY public.feature_flags ALTER COLUMN id SET DEFAULT nextval('public.feature_flags_id_seq'::regclass);

ALTER TABLE ONLY public.inspection_tokens ALTER COLUMN id SET DEFAULT nextval('public.inspection_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.inspections ALTER COLUMN id SET DEFAULT nextval('public.inspections_id_seq'::regclass);

ALTER TABLE ONLY public.invoice_line_items ALTER COLUMN id SET DEFAULT nextval('public.invoice_line_items_id_seq'::regclass);

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);

ALTER TABLE ONLY public.login_sessions ALTER COLUMN id SET DEFAULT nextval('public.login_sessions_id_seq'::regclass);

ALTER TABLE ONLY public.notification_log ALTER COLUMN id SET DEFAULT nextval('public.notification_log_id_seq'::regclass);

ALTER TABLE ONLY public.notification_settings ALTER COLUMN id SET DEFAULT nextval('public.notification_settings_id_seq'::regclass);

ALTER TABLE ONLY public.notification_templates ALTER COLUMN id SET DEFAULT nextval('public.notification_templates_id_seq'::regclass);

ALTER TABLE ONLY public.otp_codes ALTER COLUMN id SET DEFAULT nextval('public.otp_codes_id_seq'::regclass);

ALTER TABLE ONLY public.payments ALTER COLUMN id SET DEFAULT nextval('public.payments_id_seq'::regclass);

ALTER TABLE ONLY public.projects ALTER COLUMN id SET DEFAULT nextval('public.projects_id_seq'::regclass);

ALTER TABLE ONLY public.promotions ALTER COLUMN id SET DEFAULT nextval('public.promotions_id_seq'::regclass);

ALTER TABLE ONLY public.quotation_line_items ALTER COLUMN id SET DEFAULT nextval('public.quotation_line_items_id_seq'::regclass);

ALTER TABLE ONLY public.quotations ALTER COLUMN id SET DEFAULT nextval('public.quotations_id_seq'::regclass);

ALTER TABLE ONLY public.referral_codes ALTER COLUMN id SET DEFAULT nextval('public.referral_codes_id_seq'::regclass);

ALTER TABLE ONLY public.referral_ledger ALTER COLUMN id SET DEFAULT nextval('public.referral_ledger_id_seq'::regclass);

ALTER TABLE ONLY public.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('public.refresh_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.reminder_deliveries ALTER COLUMN id SET DEFAULT nextval('public.reminder_deliveries_id_seq'::regclass);

ALTER TABLE ONLY public.rental_asset_progress_events ALTER COLUMN id SET DEFAULT nextval('public.rental_asset_progress_events_id_seq'::regclass);

ALTER TABLE ONLY public.rental_asset_return_operations ALTER COLUMN id SET DEFAULT nextval('public.rental_asset_return_operations_id_seq'::regclass);

ALTER TABLE ONLY public.rental_charges ALTER COLUMN id SET DEFAULT nextval('public.rental_charges_id_seq'::regclass);

ALTER TABLE ONLY public.rental_fleet ALTER COLUMN id SET DEFAULT nextval('public.rental_fleet_id_seq'::regclass);

ALTER TABLE ONLY public.rental_lifecycle_effects ALTER COLUMN id SET DEFAULT nextval('public.rental_lifecycle_effects_id_seq'::regclass);

ALTER TABLE ONLY public.rental_line_items ALTER COLUMN id SET DEFAULT nextval('public.rental_line_items_id_seq'::regclass);

ALTER TABLE ONLY public.rental_prepayments ALTER COLUMN id SET DEFAULT nextval('public.rental_prepayments_id_seq'::regclass);

ALTER TABLE ONLY public.rental_requests ALTER COLUMN id SET DEFAULT nextval('public.rental_requests_id_seq'::regclass);

ALTER TABLE ONLY public.rental_rolling_terms ALTER COLUMN id SET DEFAULT nextval('public.rental_rolling_terms_id_seq'::regclass);

ALTER TABLE ONLY public.rental_settings ALTER COLUMN id SET DEFAULT nextval('public.rental_settings_id_seq'::regclass);

ALTER TABLE ONLY public.role_permissions ALTER COLUMN id SET DEFAULT nextval('public.role_permissions_id_seq'::regclass);

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);

ALTER TABLE ONLY public.shipping_pricing_equipment_mapping ALTER COLUMN id SET DEFAULT nextval('public.shipping_pricing_equipment_mapping_id_seq'::regclass);

ALTER TABLE ONLY public.shipping_pricing_rules ALTER COLUMN id SET DEFAULT nextval('public.shipping_pricing_rules_id_seq'::regclass);

ALTER TABLE ONLY public.shipping_pricing_tiers ALTER COLUMN id SET DEFAULT nextval('public.shipping_pricing_tiers_id_seq'::regclass);

ALTER TABLE ONLY public.site_settings ALTER COLUMN id SET DEFAULT nextval('public.site_settings_id_seq'::regclass);

ALTER TABLE ONLY public.tax_rates ALTER COLUMN id SET DEFAULT nextval('public.tax_rates_id_seq'::regclass);

ALTER TABLE ONLY public.user_permission_overrides ALTER COLUMN id SET DEFAULT nextval('public.user_permission_overrides_id_seq'::regclass);

ALTER TABLE ONLY public.user_permissions ALTER COLUMN id SET DEFAULT nextval('public.user_permissions_id_seq'::regclass);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.warehouses ALTER COLUMN id SET DEFAULT nextval('public.warehouses_id_seq'::regclass);

ALTER TABLE ONLY public.work_order_labor ALTER COLUMN id SET DEFAULT nextval('public.work_order_labor_id_seq'::regclass);

ALTER TABLE ONLY public.work_order_parts ALTER COLUMN id SET DEFAULT nextval('public.work_order_parts_id_seq'::regclass);

ALTER TABLE ONLY public.work_orders ALTER COLUMN id SET DEFAULT nextval('public.work_orders_id_seq'::regclass);

ALTER TABLE ONLY public.attachment_compatibility
    ADD CONSTRAINT attachment_compatibility_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attachment_compatibility
    ADD CONSTRAINT attachment_compatibility_unique UNIQUE ("attachmentCatalogId", "machineCatalogId");

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.catalog_cache
    ADD CONSTRAINT catalog_cache_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.catalog_sync_log
    ADD CONSTRAINT catalog_sync_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contract_templates
    ADD CONSTRAINT contract_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT customer_credit_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer_interactions
    ADD CONSTRAINT customer_interactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer_merge_log
    ADD CONSTRAINT customer_merge_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer_pricing
    ADD CONSTRAINT customer_pricing_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer_sessions
    ADD CONSTRAINT customer_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.customer_sessions
    ADD CONSTRAINT customer_sessions_token_key UNIQUE (token);

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.damage_claims
    ADD CONSTRAINT damage_claims_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deposit_rules
    ADD CONSTRAINT deposit_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.dispatch_orders
    ADD CONSTRAINT dispatch_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.downtime_records
    ADD CONSTRAINT downtime_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.equipment_categories
    ADD CONSTRAINT equipment_categories_name_key UNIQUE (name);

ALTER TABLE ONLY public.equipment_categories
    ADD CONSTRAINT equipment_categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.equipment_model_price_versions
    ADD CONSTRAINT equipment_model_price_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.equipment_models
    ADD CONSTRAINT equipment_models_category_brand_model_key UNIQUE (category, brand, model);

ALTER TABLE ONLY public.equipment_models
    ADD CONSTRAINT equipment_models_category_brand_model_unique UNIQUE (category, brand, model);

ALTER TABLE ONLY public.equipment_models
    ADD CONSTRAINT equipment_models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.extension_requests
    ADD CONSTRAINT extension_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_key_key UNIQUE (key);

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.inspection_tokens
    ADD CONSTRAINT inspection_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.inspection_tokens
    ADD CONSTRAINT "inspection_tokens_tokenHash_unique" UNIQUE ("tokenHash");

ALTER TABLE ONLY public.inspections
    ADD CONSTRAINT inspections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT invoice_line_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT "invoices_invoiceNumber_key" UNIQUE ("invoiceNumber");

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.login_sessions
    ADD CONSTRAINT login_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_log
    ADD CONSTRAINT notification_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.otp_codes
    ADD CONSTRAINT otp_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT promotions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quotation_line_items
    ADD CONSTRAINT quotation_line_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT "quotations_quotationNumber_key" UNIQUE ("quotationNumber");

ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_code_key UNIQUE (code);

ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT referral_ledger_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.reminder_deliveries
    ADD CONSTRAINT reminder_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_asset_progress_events
    ADD CONSTRAINT "rental_asset_progress_events_eventKey_key" UNIQUE ("eventKey");

ALTER TABLE ONLY public.rental_asset_progress_events
    ADD CONSTRAINT rental_asset_progress_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_asset_return_operations
    ADD CONSTRAINT "rental_asset_return_operation_rentalRequestId_rentalFleetId_key" UNIQUE ("rentalRequestId", "rentalFleetId");

ALTER TABLE ONLY public.rental_asset_return_operations
    ADD CONSTRAINT rental_asset_return_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_charges
    ADD CONSTRAINT rental_charges_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_fleet
    ADD CONSTRAINT rental_fleet_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_lifecycle_effects
    ADD CONSTRAINT rental_lifecycle_effects_command_effect_unique UNIQUE ("commandKey", "effectType");

ALTER TABLE ONLY public.rental_lifecycle_effects
    ADD CONSTRAINT rental_lifecycle_effects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_line_items
    ADD CONSTRAINT rental_line_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_prepayments
    ADD CONSTRAINT rental_prepayments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT rental_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT "rental_requests_rentalNumber_key" UNIQUE ("rentalNumber");

ALTER TABLE ONLY public.rental_rolling_terms
    ADD CONSTRAINT rental_rolling_terms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rental_rolling_terms
    ADD CONSTRAINT "rental_rolling_terms_rentalRequestId_key" UNIQUE ("rentalRequestId");

ALTER TABLE ONLY public.rental_settings
    ADD CONSTRAINT rental_settings_key_unique UNIQUE (key);

ALTER TABLE ONLY public.rental_settings
    ADD CONSTRAINT rental_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_module_key UNIQUE (role, module);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_key UNIQUE (token);

ALTER TABLE ONLY public.shipping_pricing_equipment_mapping
    ADD CONSTRAINT shipping_pricing_equipment_mapping_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.shipping_pricing_rules
    ADD CONSTRAINT shipping_pricing_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.shipping_pricing_tiers
    ADD CONSTRAINT shipping_pricing_tiers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.site_settings
    ADD CONSTRAINT site_settings_key_unique UNIQUE (key);

ALTER TABLE ONLY public.site_settings
    ADD CONSTRAINT site_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tax_rates
    ADD CONSTRAINT tax_rates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tax_rates
    ADD CONSTRAINT tax_rates_province_unique UNIQUE (province);

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT user_permission_overrides_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT "user_permission_overrides_userId_module_key" UNIQUE ("userId", module);

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT "user_permissions_userId_key" UNIQUE ("userId");

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);

ALTER TABLE ONLY public.warehouses
    ADD CONSTRAINT warehouses_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_order_labor
    ADD CONSTRAINT work_order_labor_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_order_parts
    ADD CONSTRAINT work_order_parts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT work_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT "work_orders_workOrderNumber_key" UNIQUE ("workOrderNumber");

CREATE INDEX attachment_compatibility_attachment_catalog_idx ON public.attachment_compatibility USING btree ("attachmentCatalogId");

CREATE INDEX attachment_compatibility_machine_catalog_idx ON public.attachment_compatibility USING btree ("machineCatalogId");

CREATE INDEX audit_logs_created_at_idx ON public.audit_logs USING btree ("createdAt");

CREATE INDEX audit_logs_entity_idx ON public.audit_logs USING btree ("entityType", "entityId");

CREATE INDEX audit_logs_user_idx ON public.audit_logs USING btree ("userId");

CREATE INDEX catalog_cache_brand_idx ON public.catalog_cache USING btree (brand);

CREATE INDEX catalog_cache_source_idx ON public.catalog_cache USING btree ("sourceType", "sourceId");

CREATE INDEX customer_credit_entries_customer_idx ON public.customer_credit_entries USING btree ("customerId") WHERE ("deletedAt" IS NULL);

CREATE INDEX customer_credit_entries_rental_idx ON public.customer_credit_entries USING btree ("rentalRequestId") WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX customer_credit_entries_source_key_unique ON public.customer_credit_entries USING btree ("sourceKey") WHERE ("sourceKey" IS NOT NULL);

CREATE INDEX customer_pricing_active_idx ON public.customer_pricing USING btree ("isActive", "validFrom", "validTo");

CREATE INDEX customer_pricing_category_idx ON public.customer_pricing USING btree (category);

CREATE INDEX customer_pricing_customer_idx ON public.customer_pricing USING btree ("customerId");

CREATE INDEX customer_pricing_fleet_idx ON public.customer_pricing USING btree ("rentalFleetId");

CREATE INDEX customer_sessions_customer_idx ON public.customer_sessions USING btree ("customerId");

CREATE INDEX customer_sessions_token_idx ON public.customer_sessions USING btree (token);

CREATE INDEX customers_active_idx ON public.customers USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE INDEX customers_created_idx ON public.customers USING btree ("createdAt" DESC);

CREATE INDEX customers_email_idx ON public.customers USING btree (email);

CREATE INDEX customers_follow_up_idx ON public.customers USING btree ("nextFollowUp");

CREATE INDEX customers_phone_idx ON public.customers USING btree (phone);

CREATE INDEX customers_referral_idx ON public.customers USING btree ("referralCodeId");

CREATE INDEX damage_claims_customer_idx ON public.damage_claims USING btree ("customerId");

CREATE INDEX damage_claims_deleted_idx ON public.damage_claims USING btree ("deletedAt");

CREATE INDEX damage_claims_rental_idx ON public.damage_claims USING btree ("rentalId");

CREATE INDEX damage_claims_status_idx ON public.damage_claims USING btree (status);

CREATE INDEX deposit_rules_category_idx ON public.deposit_rules USING btree (category);

CREATE UNIQUE INDEX dispatch_confirmation_token_idx ON public.dispatch_orders USING btree ("confirmationToken");

CREATE INDEX dispatch_customer_idx ON public.dispatch_orders USING btree ("customerId");

CREATE INDEX dispatch_driver_idx ON public.dispatch_orders USING btree ("assignedDriverId");

CREATE INDEX dispatch_fleet_idx ON public.dispatch_orders USING btree ("rentalFleetId");

CREATE INDEX dispatch_orders_active_idx ON public.dispatch_orders USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE INDEX dispatch_orders_created_idx ON public.dispatch_orders USING btree ("createdAt" DESC);

CREATE INDEX dispatch_rental_idx ON public.dispatch_orders USING btree ("rentalRequestId");

CREATE INDEX dispatch_scheduled_date_idx ON public.dispatch_orders USING btree ("scheduledDate") WHERE ("deletedAt" IS NULL);

CREATE INDEX dispatch_status_idx ON public.dispatch_orders USING btree (status);

CREATE INDEX downtime_records_fleet_idx ON public.downtime_records USING btree ("rentalFleetId");

CREATE INDEX downtime_records_rental_idx ON public.downtime_records USING btree ("rentalId");

CREATE INDEX downtime_records_status_idx ON public.downtime_records USING btree (status);

CREATE INDEX drivers_active_idx ON public.drivers USING btree ("isActive");

CREATE INDEX drivers_user_idx ON public.drivers USING btree ("userId");

CREATE INDEX empv_model_from_idx ON public.equipment_model_price_versions USING btree (equipment_model_id, effective_from);

CREATE UNIQUE INDEX empv_one_open_per_model ON public.equipment_model_price_versions USING btree (equipment_model_id) WHERE (effective_to IS NULL);

CREATE INDEX equipment_models_brand_model_idx ON public.equipment_models USING btree (brand, model);

CREATE INDEX equipment_models_category_idx ON public.equipment_models USING btree (category);

CREATE INDEX ext_req_customer_idx ON public.extension_requests USING btree ("customerId");

CREATE INDEX ext_req_rental_idx ON public.extension_requests USING btree ("rentalRequestId");

CREATE INDEX ext_req_status_idx ON public.extension_requests USING btree (status);

CREATE INDEX feature_flags_key_idx ON public.feature_flags USING btree (key);

CREATE INDEX idx_inspections_not_deleted ON public.inspections USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE UNIQUE INDEX idx_inspections_offline_id_unique ON public.inspections USING btree ("offlineId") WHERE (("offlineId" IS NOT NULL) AND ("deletedAt" IS NULL));

CREATE INDEX idx_notification_log_status ON public.notification_log USING btree (status);

CREATE INDEX idx_rental_fleet_not_deleted ON public.rental_fleet USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE INDEX idx_rental_requests_not_deleted ON public.rental_requests USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE INDEX idx_users_not_deleted ON public.users USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE INDEX idx_warehouses_not_deleted ON public.warehouses USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE INDEX inspections_created_idx ON public.inspections USING btree ("createdAt" DESC);

CREATE INDEX inspections_fleet_idx ON public.inspections USING btree ("rentalFleetId");

CREATE INDEX inspections_offline_id_idx ON public.inspections USING btree ("offlineId");

CREATE INDEX inspections_rental_idx ON public.inspections USING btree ("rentalId");

CREATE INDEX inspections_type_idx ON public.inspections USING btree (type);

CREATE INDEX interactions_created_at_idx ON public.customer_interactions USING btree ("createdAt");

CREATE INDEX interactions_customer_idx ON public.customer_interactions USING btree ("customerId");

CREATE INDEX invoice_line_items_invoice_idx ON public.invoice_line_items USING btree ("invoiceId");

CREATE INDEX invoices_active_idx ON public.invoices USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE INDEX invoices_created_idx ON public.invoices USING btree ("createdAt" DESC);

CREATE INDEX invoices_customer_idx ON public.invoices USING btree ("customerId");

CREATE INDEX invoices_deleted_at_idx ON public.invoices USING btree ("deletedAt");

CREATE INDEX invoices_due_date_idx ON public.invoices USING btree ("dueDate");

CREATE INDEX invoices_number_idx ON public.invoices USING btree ("invoiceNumber");

CREATE INDEX invoices_project_idx ON public.invoices USING btree ("projectId");

CREATE INDEX invoices_rental_idx ON public.invoices USING btree ("rentalId");

CREATE UNIQUE INDEX invoices_source_key_unique ON public.invoices USING btree ("sourceKey");

CREATE INDEX invoices_status_idx ON public.invoices USING btree (status);

CREATE INDEX invoices_type_idx ON public.invoices USING btree (type);

CREATE INDEX login_sessions_login_at_idx ON public.login_sessions USING btree ("loginAt");

CREATE INDEX login_sessions_session_token_idx ON public.login_sessions USING btree ("sessionToken");

CREATE INDEX login_sessions_user_idx ON public.login_sessions USING btree ("userId");

CREATE INDEX notification_log_channel_idx ON public.notification_log USING btree (channel);

CREATE INDEX notification_log_created_at_idx ON public.notification_log USING btree ("createdAt");

CREATE INDEX otp_codes_expires_idx ON public.otp_codes USING btree ("expiresAt");

CREATE INDEX otp_codes_phone_idx ON public.otp_codes USING btree (phone);

CREATE INDEX payments_date_idx ON public.payments USING btree ("paymentDate");

CREATE INDEX payments_invoice_idx ON public.payments USING btree ("invoiceId");

CREATE INDEX projects_customer_idx ON public.projects USING btree ("customerId");

CREATE INDEX projects_deleted_at_idx ON public.projects USING btree ("deletedAt");

CREATE INDEX projects_status_idx ON public.projects USING btree (status);

CREATE INDEX promotions_active_idx ON public.promotions USING btree ("isActive");

CREATE INDEX promotions_dates_idx ON public.promotions USING btree ("startDate", "endDate");

CREATE INDEX promotions_type_idx ON public.promotions USING btree (type);

CREATE INDEX quotation_line_items_quotation_idx ON public.quotation_line_items USING btree ("quotationId");

CREATE INDEX quotations_customer_idx ON public.quotations USING btree ("customerId");

CREATE INDEX quotations_number_idx ON public.quotations USING btree ("quotationNumber");

CREATE INDEX quotations_project_idx ON public.quotations USING btree ("projectId");

CREATE INDEX quotations_rental_idx ON public.quotations USING btree ("rentalId");

CREATE INDEX quotations_status_idx ON public.quotations USING btree (status);

CREATE UNIQUE INDEX referral_codes_code_idx ON public.referral_codes USING btree (code);

CREATE INDEX referral_codes_driver_idx ON public.referral_codes USING btree ("driverId");

CREATE INDEX referral_codes_promotion_idx ON public.referral_codes USING btree ("promotionId");

CREATE INDEX referral_ledger_code_idx ON public.referral_ledger USING btree ("referralCodeId");

CREATE INDEX referral_ledger_driver_idx ON public.referral_ledger USING btree ("driverId");

CREATE INDEX referral_ledger_rental_idx ON public.referral_ledger USING btree ("rentalRequestId");

CREATE INDEX referral_ledger_status_idx ON public.referral_ledger USING btree ("commissionStatus");

CREATE UNIQUE INDEX reminder_deliveries_unique ON public.reminder_deliveries USING btree ("entityType", "entityId", kind);

CREATE INDEX rental_asset_progress_fleet_created_idx ON public.rental_asset_progress_events USING btree ("rentalFleetId", "createdAt");

CREATE INDEX rental_asset_progress_rental_fleet_created_idx ON public.rental_asset_progress_events USING btree ("rentalRequestId", "rentalFleetId", "createdAt");

CREATE INDEX rental_asset_return_operations_fleet_idx ON public.rental_asset_return_operations USING btree ("rentalFleetId", "pickedUpAt");

CREATE INDEX rental_asset_return_operations_progress_idx ON public.rental_asset_return_operations USING btree ("rentalRequestId", "pickedUpAt", "billingStopAt");

CREATE INDEX rental_charges_deleted_idx ON public.rental_charges USING btree ("deletedAt");

CREATE INDEX rental_charges_invoice_idx ON public.rental_charges USING btree ("invoiceId");

CREATE INDEX rental_charges_rental_idx ON public.rental_charges USING btree ("rentalRequestId");

CREATE UNIQUE INDEX rental_fleet_asset_number_unique ON public.rental_fleet USING btree ("assetNumber") WHERE (("assetNumber" IS NOT NULL) AND ("deletedAt" IS NULL));

CREATE INDEX rental_fleet_equipment_model_idx ON public.rental_fleet USING btree ("equipmentModelId");

CREATE INDEX rental_fleet_location_idx ON public.rental_fleet USING btree ("locationId");

CREATE UNIQUE INDEX rental_fleet_serial_number_unique ON public.rental_fleet USING btree ("serialNumber") WHERE (("serialNumber" IS NOT NULL) AND ("deletedAt" IS NULL));

CREATE INDEX rental_fleet_status_idx ON public.rental_fleet USING btree ("currentStatus");

CREATE UNIQUE INDEX rental_fleet_vin_unique ON public.rental_fleet USING btree (vin) WHERE ((vin IS NOT NULL) AND ("deletedAt" IS NULL));

CREATE INDEX rental_lifecycle_effects_pending_idx ON public.rental_lifecycle_effects USING btree (status, "nextAttemptAt");

CREATE INDEX rental_lifecycle_effects_rental_idx ON public.rental_lifecycle_effects USING btree ("rentalRequestId", "createdAt" DESC);

CREATE INDEX rental_line_items_fleet_idx ON public.rental_line_items USING btree ("rentalFleetId") WHERE ("deletedAt" IS NULL);

CREATE INDEX rental_line_items_model_idx ON public.rental_line_items USING btree ("equipmentModelId") WHERE ("deletedAt" IS NULL);

CREATE INDEX rental_line_items_rental_idx ON public.rental_line_items USING btree ("rentalRequestId") WHERE ("deletedAt" IS NULL);

CREATE INDEX rental_prepayments_applied_idx ON public.rental_prepayments USING btree ("appliedAt");

CREATE INDEX rental_prepayments_deleted_idx ON public.rental_prepayments USING btree ("deletedAt");

CREATE INDEX rental_prepayments_held_idx ON public.rental_prepayments USING btree ("rentalRequestId") WHERE (("deletedAt" IS NULL) AND ("appliedAt" IS NULL) AND ("transferredToCreditAt" IS NULL));

CREATE INDEX rental_prepayments_invoice_idx ON public.rental_prepayments USING btree ("invoiceId");

CREATE INDEX rental_prepayments_rental_idx ON public.rental_prepayments USING btree ("rentalRequestId");

CREATE INDEX rental_requests_availability_idx ON public.rental_requests USING btree ("rentalFleetId", status, "startDate", "endDate") WHERE ("deletedAt" IS NULL);

CREATE INDEX rental_requests_created_at_idx ON public.rental_requests USING btree ("createdAt");

CREATE INDEX rental_requests_created_idx ON public.rental_requests USING btree ("createdAt" DESC);

CREATE INDEX rental_requests_customer_email_idx ON public.rental_requests USING btree ("customerEmail");

CREATE INDEX rental_requests_customer_idx ON public.rental_requests USING btree ("customerId");

CREATE INDEX rental_requests_date_idx ON public.rental_requests USING btree ("startDate", "endDate");

CREATE INDEX rental_requests_deposit_paid_idx ON public.rental_requests USING btree ("depositPaid");

CREATE INDEX rental_requests_equipment_model_idx ON public.rental_requests USING btree ("equipmentModelId");

CREATE INDEX rental_requests_fleet_idx ON public.rental_requests USING btree ("rentalFleetId");

CREATE INDEX rental_requests_parent_idx ON public.rental_requests USING btree ("parentRentalId");

CREATE INDEX rental_requests_payment_status_idx ON public.rental_requests USING btree ("paymentStatus");

CREATE INDEX rental_requests_project_idx ON public.rental_requests USING btree ("projectId");

CREATE INDEX rental_requests_referral_idx ON public.rental_requests USING btree ("referralCodeId");

CREATE INDEX rental_requests_status_idx ON public.rental_requests USING btree (status);

CREATE INDEX rental_rolling_terms_status_settlement_idx ON public.rental_rolling_terms USING btree (status, "nextSettlementDate");

CREATE INDEX role_permissions_role_idx ON public.role_permissions USING btree (role);

CREATE INDEX sessions_expires_idx ON public.sessions USING btree ("expiresAt");

CREATE INDEX sessions_token_idx ON public.sessions USING btree (token);

CREATE INDEX shipping_rules_category_idx ON public.shipping_pricing_rules USING btree (category);

CREATE INDEX shipping_rules_model_idx ON public.shipping_pricing_rules USING btree ("equipmentModelId");

CREATE INDEX user_perm_overrides_user_idx ON public.user_permission_overrides USING btree ("userId");

CREATE INDEX user_permissions_user_idx ON public.user_permissions USING btree ("userId");

CREATE INDEX users_phone_idx ON public.users USING btree (phone);

CREATE INDEX work_order_labor_wo_idx ON public.work_order_labor USING btree ("workOrderId");

CREATE INDEX work_order_parts_wo_idx ON public.work_order_parts USING btree ("workOrderId");

CREATE INDEX work_orders_active_idx ON public.work_orders USING btree (id) WHERE ("deletedAt" IS NULL);

CREATE INDEX work_orders_assigned_idx ON public.work_orders USING btree ("assignedTo");

CREATE INDEX work_orders_deleted_at_idx ON public.work_orders USING btree ("deletedAt");

CREATE INDEX work_orders_fleet_idx ON public.work_orders USING btree ("rentalFleetId");

CREATE INDEX work_orders_status_idx ON public.work_orders USING btree (status);

ALTER TABLE ONLY public.attachment_compatibility
    ADD CONSTRAINT attachment_compatibility_attachmentcatalogid_catalog_cache_id_f FOREIGN KEY ("attachmentCatalogId") REFERENCES public.catalog_cache(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.attachment_compatibility
    ADD CONSTRAINT attachment_compatibility_machinecatalogid_catalog_cache_id_fk FOREIGN KEY ("machineCatalogId") REFERENCES public.catalog_cache(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT "audit_logs_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT "customer_credit_entries_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT "customer_credit_entries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT "customer_credit_entries_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT "customer_credit_entries_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_interactions
    ADD CONSTRAINT "customer_interactions_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_interactions
    ADD CONSTRAINT "customer_interactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customer_interactions
    ADD CONSTRAINT customer_interactions_customerid_customers_id_fk FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_pricing
    ADD CONSTRAINT "customer_pricing_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_pricing
    ADD CONSTRAINT "customer_pricing_customerId_customers_id_fk" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customer_pricing
    ADD CONSTRAINT "customer_pricing_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customer_pricing
    ADD CONSTRAINT customer_pricing_customerid_customers_id_fk FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_pricing
    ADD CONSTRAINT "customer_pricing_rentalFleetId_fkey" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customer_pricing
    ADD CONSTRAINT customer_pricing_rentalfleetid_rental_fleet_id_fk FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customer_sessions
    ADD CONSTRAINT "customer_sessions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_classification_confirmed_by_fk FOREIGN KEY ("classificationConfirmedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT "customers_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES public.referral_codes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.damage_claims
    ADD CONSTRAINT "damage_claims_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.damage_claims
    ADD CONSTRAINT "damage_claims_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.damage_claims
    ADD CONSTRAINT "damage_claims_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES public.inspections(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.damage_claims
    ADD CONSTRAINT "damage_claims_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.damage_claims
    ADD CONSTRAINT "damage_claims_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.dispatch_orders
    ADD CONSTRAINT "dispatch_orders_assignedDriverId_users_id_fk" FOREIGN KEY ("assignedDriverId") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.dispatch_orders
    ADD CONSTRAINT dispatch_orders_assigneddriverid_fkey FOREIGN KEY ("assignedDriverId") REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.dispatch_orders
    ADD CONSTRAINT "dispatch_orders_customerId_customers_id_fk" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.dispatch_orders
    ADD CONSTRAINT "dispatch_orders_deliveryWarehouseId_warehouses_id_fk" FOREIGN KEY ("deliveryWarehouseId") REFERENCES public.warehouses(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.dispatch_orders
    ADD CONSTRAINT "dispatch_orders_pickupWarehouseId_warehouses_id_fk" FOREIGN KEY ("pickupWarehouseId") REFERENCES public.warehouses(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.dispatch_orders
    ADD CONSTRAINT "dispatch_orders_rentalFleetId_rental_fleet_id_fk" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.dispatch_orders
    ADD CONSTRAINT "dispatch_orders_rentalRequestId_rental_requests_id_fk" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.downtime_records
    ADD CONSTRAINT downtime_records_creditinvoiceid_fkey FOREIGN KEY ("creditInvoiceId") REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.downtime_records
    ADD CONSTRAINT "downtime_records_rentalFleetId_fkey" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.downtime_records
    ADD CONSTRAINT downtime_records_rentalid_rental_requests_id_fk FOREIGN KEY ("rentalId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.downtime_records
    ADD CONSTRAINT "downtime_records_reportedBy_fkey" FOREIGN KEY ("reportedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT "drivers_userId_fkey1" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.equipment_model_price_versions
    ADD CONSTRAINT equipment_model_price_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.equipment_model_price_versions
    ADD CONSTRAINT equipment_model_price_versions_equipment_model_id_fkey FOREIGN KEY (equipment_model_id) REFERENCES public.equipment_models(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.extension_requests
    ADD CONSTRAINT extension_requests_customerid_customers_id_fk FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.extension_requests
    ADD CONSTRAINT extension_requests_rentalrequestid_rental_requests_id_fk FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.extension_requests
    ADD CONSTRAINT "extension_requests_reviewedBy_fkey" FOREIGN KEY ("reviewedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT fk_rental_delivery_inspection FOREIGN KEY ("deliveryInspectionId") REFERENCES public.inspections(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT fk_rental_return_inspection FOREIGN KEY ("returnInspectionId") REFERENCES public.inspections(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.inspection_tokens
    ADD CONSTRAINT "inspection_tokens_createdBy_users_id_fk" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.inspection_tokens
    ADD CONSTRAINT "inspection_tokens_rentalFleetId_rental_fleet_id_fk" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.inspection_tokens
    ADD CONSTRAINT "inspection_tokens_rentalId_rental_requests_id_fk" FOREIGN KEY ("rentalId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.inspections
    ADD CONSTRAINT "inspections_inspectorId_users_id_fk" FOREIGN KEY ("inspectorId") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.inspections
    ADD CONSTRAINT "inspections_rentalFleetId_rental_fleet_id_fk" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.inspections
    ADD CONSTRAINT "inspections_rentalId_rental_requests_id_fk" FOREIGN KEY ("rentalId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.invoice_line_items
    ADD CONSTRAINT "invoice_line_items_invoiceId_invoices_id_fk" FOREIGN KEY ("invoiceId") REFERENCES public.invoices(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT "invoices_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT "invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_projectid_fkey FOREIGN KEY ("projectId") REFERENCES public.projects(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT "invoices_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.login_sessions
    ADD CONSTRAINT "login_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.login_sessions
    ADD CONSTRAINT login_sessions_userid_users_id_fk FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "payments_invoiceId_invoices_id_fk" FOREIGN KEY ("invoiceId") REFERENCES public.invoices(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_invoiceid_invoices_id_fk FOREIGN KEY ("invoiceId") REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT "payments_recordedBy_fkey" FOREIGN KEY ("recordedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_customerid_customers_id_fk FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.promotions
    ADD CONSTRAINT "promotions_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.quotation_line_items
    ADD CONSTRAINT "quotation_line_items_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES public.quotations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT "quotations_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT "quotations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT "quotations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public.projects(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT "quotations_rentalId_fkey" FOREIGN KEY ("rentalId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_driverid_drivers_id_fk FOREIGN KEY ("driverId") REFERENCES public.drivers(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.referral_codes
    ADD CONSTRAINT referral_codes_promotionid_promotions_id_fk FOREIGN KEY ("promotionId") REFERENCES public.promotions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT "referral_ledger_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT "referral_ledger_driverId_drivers_id_fk" FOREIGN KEY ("driverId") REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT referral_ledger_driverid_fkey FOREIGN KEY ("driverId") REFERENCES public.drivers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT "referral_ledger_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES public.referral_codes(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.referral_ledger
    ADD CONSTRAINT "referral_ledger_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT "refresh_tokens_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rental_asset_progress_events
    ADD CONSTRAINT "rental_asset_progress_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_asset_progress_events
    ADD CONSTRAINT "rental_asset_progress_events_rentalFleetId_fkey" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rental_asset_progress_events
    ADD CONSTRAINT "rental_asset_progress_events_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.rental_asset_return_operations
    ADD CONSTRAINT "rental_asset_return_operations_pickedUpBy_fkey" FOREIGN KEY ("pickedUpBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_asset_return_operations
    ADD CONSTRAINT "rental_asset_return_operations_readyRecordedBy_fkey" FOREIGN KEY ("readyRecordedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_asset_return_operations
    ADD CONSTRAINT "rental_asset_return_operations_rentalFleetId_fkey" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.rental_asset_return_operations
    ADD CONSTRAINT "rental_asset_return_operations_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.rental_asset_return_operations
    ADD CONSTRAINT "rental_asset_return_operations_responsibilitySetBy_fkey" FOREIGN KEY ("responsibilitySetBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_charges
    ADD CONSTRAINT "rental_charges_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_charges
    ADD CONSTRAINT "rental_charges_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_charges
    ADD CONSTRAINT "rental_charges_newRentalFleetId_fkey" FOREIGN KEY ("newRentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_charges
    ADD CONSTRAINT "rental_charges_oldRentalFleetId_fkey" FOREIGN KEY ("oldRentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_charges
    ADD CONSTRAINT "rental_charges_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.rental_fleet
    ADD CONSTRAINT "rental_fleet_catalogCacheId_catalog_cache_id_fk" FOREIGN KEY ("catalogCacheId") REFERENCES public.catalog_cache(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_fleet
    ADD CONSTRAINT "rental_fleet_equipmentModelId_fkey" FOREIGN KEY ("equipmentModelId") REFERENCES public.equipment_models(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_fleet
    ADD CONSTRAINT "rental_fleet_locationId_warehouses_id_fk" FOREIGN KEY ("locationId") REFERENCES public.warehouses(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_lifecycle_effects
    ADD CONSTRAINT "rental_lifecycle_effects_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.rental_line_items
    ADD CONSTRAINT "rental_line_items_equipmentModelId_fkey" FOREIGN KEY ("equipmentModelId") REFERENCES public.equipment_models(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_line_items
    ADD CONSTRAINT "rental_line_items_rentalFleetId_fkey" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_line_items
    ADD CONSTRAINT "rental_line_items_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.rental_prepayments
    ADD CONSTRAINT "rental_prepayments_appliedBy_fkey" FOREIGN KEY ("appliedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_prepayments
    ADD CONSTRAINT "rental_prepayments_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_prepayments
    ADD CONSTRAINT "rental_prepayments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES public.invoices(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_prepayments
    ADD CONSTRAINT "rental_prepayments_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.rental_prepayments
    ADD CONSTRAINT rental_prepayments_transferred_by_fk FOREIGN KEY ("transferredToCreditBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT rental_requests_contracttemplateid_fk FOREIGN KEY ("contractTemplateId") REFERENCES public.contract_templates(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT "rental_requests_creditFinalizedBy_fkey" FOREIGN KEY ("creditFinalizedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT "rental_requests_customerId_customers_id_fk" FOREIGN KEY ("customerId") REFERENCES public.customers(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT "rental_requests_equipmentModelId_fkey" FOREIGN KEY ("equipmentModelId") REFERENCES public.equipment_models(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT "rental_requests_parentRentalId_fkey" FOREIGN KEY ("parentRentalId") REFERENCES public.rental_requests(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT "rental_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES public.projects(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT "rental_requests_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES public.referral_codes(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT "rental_requests_rentalFleetId_rental_fleet_id_fk" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_requests
    ADD CONSTRAINT rental_requests_repsignedby_users_id_fk FOREIGN KEY ("repSignedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_rolling_terms
    ADD CONSTRAINT "rental_rolling_terms_confirmedBy_fkey" FOREIGN KEY ("confirmedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_rolling_terms
    ADD CONSTRAINT "rental_rolling_terms_endedBy_fkey" FOREIGN KEY ("endedBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.rental_rolling_terms
    ADD CONSTRAINT "rental_rolling_terms_rentalRequestId_fkey" FOREIGN KEY ("rentalRequestId") REFERENCES public.rental_requests(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.shipping_pricing_equipment_mapping
    ADD CONSTRAINT "shipping_pricing_equipment_mapping_pricingTierId_shipping_prici" FOREIGN KEY ("pricingTierId") REFERENCES public.shipping_pricing_tiers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.shipping_pricing_equipment_mapping
    ADD CONSTRAINT "shipping_pricing_equipment_mapping_rentalFleetId_rental_fleet_i" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.shipping_pricing_rules
    ADD CONSTRAINT "shipping_pricing_rules_equipmentModelId_fkey" FOREIGN KEY ("equipmentModelId") REFERENCES public.equipment_models(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.shipping_pricing_rules
    ADD CONSTRAINT shipping_pricing_rules_equipmentmodelid_equipment_models_id_fk FOREIGN KEY ("equipmentModelId") REFERENCES public.equipment_models(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.shipping_pricing_rules
    ADD CONSTRAINT "shipping_pricing_rules_pricingTierId_fkey" FOREIGN KEY ("pricingTierId") REFERENCES public.shipping_pricing_tiers(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_permission_overrides
    ADD CONSTRAINT "user_permission_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT "user_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_order_labor
    ADD CONSTRAINT "work_order_labor_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.work_order_labor
    ADD CONSTRAINT "work_order_labor_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES public.work_orders(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.work_order_parts
    ADD CONSTRAINT "work_order_parts_workOrderId_work_orders_id_fk" FOREIGN KEY ("workOrderId") REFERENCES public.work_orders(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT "work_orders_assignedTo_fkey" FOREIGN KEY ("assignedTo") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT "work_orders_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT "work_orders_damageClaimId_fkey" FOREIGN KEY ("damageClaimId") REFERENCES public.damage_claims(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.work_orders
    ADD CONSTRAINT "work_orders_rentalFleetId_fkey" FOREIGN KEY ("rentalFleetId") REFERENCES public.rental_fleet(id) ON DELETE SET NULL;

ALTER TABLE public.attachment_compatibility ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.catalog_cache ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.catalog_sync_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.contract_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_credit_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_interactions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_merge_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_pricing ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customer_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.damage_claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deposit_rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.dispatch_orders ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.downtime_records ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.equipment_categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.equipment_model_price_versions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.equipment_models ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.extension_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.inspection_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.inspections ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.login_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.otp_codes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.quotation_line_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.referral_ledger ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.reminder_deliveries ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_asset_progress_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_asset_return_operations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_charges ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_fleet ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_lifecycle_effects ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_line_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_prepayments ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_rolling_terms ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.rental_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.shipping_pricing_equipment_mapping ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.shipping_pricing_rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.shipping_pricing_tiers ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.site_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.warehouses ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.work_order_labor ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.work_order_parts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.work_orders ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict 4StPz1PVEf9mNAkps12OJVyPcIToUW11OoWeQg54xbn0p7jUvkRVVOfybo8cGw9

