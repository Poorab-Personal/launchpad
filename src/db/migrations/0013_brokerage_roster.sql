-- Phase 1a of the DMG roster integration plan (docs/integrations/dmg-roster-plan.md).
-- Pure schema work — no business logic, no seed data, no adapters.
--
-- 1. New enums: source_type, verification_mode.
-- 2. brokerages: drop the three Airtable-era roster_api_* columns; add
--    source_type / source_config / verification_mode / support_contact_*.
-- 3. New brokerage_roster table — bulk pre-verification roster keyed by
--    (brokerage_id, source_user_id). Distinct from the existing `roster` table
--    (which is the post-verification one-row-per-onboarding-agent bridge).
--
-- Note: `events.event_type` is a free-form text column (not a pgEnum). The
-- plan's §3.3 `ALTER TYPE event_type ADD VALUE 'Roster Synced'` is a no-op
-- against the current schema; the application can write the literal
-- 'Roster Synced' without any DDL change.

-- New enums
CREATE TYPE "public"."source_type" AS ENUM('dmg');--> statement-breakpoint
CREATE TYPE "public"."verification_mode" AS ENUM('soft', 'magic_link_required');--> statement-breakpoint

-- Drop vestigial Airtable-era columns on brokerages
ALTER TABLE "brokerages" DROP COLUMN "roster_api_url";--> statement-breakpoint
ALTER TABLE "brokerages" DROP COLUMN "roster_api_key";--> statement-breakpoint
ALTER TABLE "brokerages" DROP COLUMN "roster_refresh_interval";--> statement-breakpoint

-- Add DMG-roster-plan columns on brokerages
ALTER TABLE "brokerages" ADD COLUMN "source_type" "source_type" DEFAULT 'dmg' NOT NULL;--> statement-breakpoint
ALTER TABLE "brokerages" ADD COLUMN "source_config" jsonb;--> statement-breakpoint
ALTER TABLE "brokerages" ADD COLUMN "verification_mode" "verification_mode" DEFAULT 'soft' NOT NULL;--> statement-breakpoint
ALTER TABLE "brokerages" ADD COLUMN "support_contact_name" text;--> statement-breakpoint
ALTER TABLE "brokerages" ADD COLUMN "support_contact_email" text;--> statement-breakpoint
ALTER TABLE "brokerages" ADD COLUMN "support_contact_phone" text;--> statement-breakpoint

-- New bulk-roster table
CREATE TABLE "brokerage_roster" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" uuid NOT NULL,
	"source_user_id" text NOT NULL,
	"account_type" text NOT NULL,
	"status" text,
	"display_name" text,
	"first_name" text,
	"last_name" text,
	"public_email" text,
	"private_email" text,
	"cell_phone" text,
	"website" text,
	"license" text,
	"photo_url" text,
	"bio" text,
	"mls_ids" text,
	"primary_office_id" text,
	"office_name" text,
	"source_data" jsonb NOT NULL,
	"source_schema_version" text,
	"customer_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- FKs
ALTER TABLE "brokerage_roster"
	ADD CONSTRAINT "brokerage_roster_brokerage_id_brokerages_id_fk"
	FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brokerage_roster"
	ADD CONSTRAINT "brokerage_roster_customer_id_customers_id_fk"
	FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Natural-key uniqueness: one row per (brokerage, source user id)
CREATE UNIQUE INDEX "brokerage_roster_natural_key_unique"
	ON "brokerage_roster" USING btree ("brokerage_id","source_user_id");--> statement-breakpoint

-- Lookup paths: case-insensitive email match, partial on alive rows.
-- See plan §4.2 step 3 (lookupByEmail).
CREATE INDEX "idx_brokerage_roster_public_email"
	ON "brokerage_roster" USING btree (LOWER("public_email"),"brokerage_id")
	WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_brokerage_roster_private_email"
	ON "brokerage_roster" USING btree (LOWER("private_email"),"brokerage_id")
	WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Sales nudge queries: unboarded agents per brokerage
CREATE INDEX "idx_brokerage_roster_unboarded"
	ON "brokerage_roster" USING btree ("brokerage_id")
	WHERE "customer_id" IS NULL AND "deleted_at" IS NULL;
