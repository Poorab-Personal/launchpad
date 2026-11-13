-- Rejig account sync + structured brand kit (docs/plans/rejig-account-sync.md).
--
-- All additive and nullable. NULL brand_kit = the designer hasn't started it.
-- NULL first/last name = never edited in the sync panel; there is no backfill
-- because every existing customer already has a Rejig account.

ALTER TABLE "customers" ADD COLUMN "brand_kit" jsonb;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_brand_kit_is_object"
  CHECK ("brand_kit" IS NULL OR jsonb_typeof("brand_kit") = 'object');--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_name" text;--> statement-breakpoint

-- One row per push to Rejig, success or not. `rejig_customer_id` is Rejig's
-- staging id, not an account id — it never goes in customers.rejig_user_id.
CREATE TABLE "rejig_sync_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "customer_id" uuid NOT NULL,
  "environment" text NOT NULL,
  "outcome" text NOT NULL,
  "http_status" integer,
  "rejig_code" text,
  "rejig_customer_id" text,
  "payload" jsonb NOT NULL,
  "response" jsonb,
  "duration_ms" integer,
  "actor_team_member_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rejig_sync_attempts_environment_check" CHECK ("environment" IN ('dev', 'prod'))
);--> statement-breakpoint
ALTER TABLE "rejig_sync_attempts" ADD CONSTRAINT "rejig_sync_attempts_customer_id_customers_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rejig_sync_attempts" ADD CONSTRAINT "rejig_sync_attempts_actor_team_member_id_team_members_id_fk"
  FOREIGN KEY ("actor_team_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- "Last sync per environment" read on the sync panel.
CREATE INDEX "rsa_customer_env_created_idx" ON "rejig_sync_attempts" USING btree ("customer_id", "environment", "created_at" DESC);--> statement-breakpoint

-- Name resolution reads brokerage_roster by customer_id.
CREATE INDEX "idx_brokerage_roster_customer_id" ON "brokerage_roster" USING btree ("customer_id") WHERE "customer_id" IS NOT NULL;
