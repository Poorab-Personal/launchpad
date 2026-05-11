CREATE TYPE "public"."at_risk_reason" AS ENUM('No CC', 'No Booking', 'No Approval', 'No Form', 'CSM Flagged', 'Inactive', 'Trial Ending', 'Disengaged', 'No Listings', 'Engagement Falling', 'Churned');--> statement-breakpoint
CREATE TYPE "public"."at_risk_source" AS ENUM('engagement', 'payment-mode', 'csm');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('D2C', 'B2B');--> statement-breakpoint
CREATE TYPE "public"."design_approval" AS ENUM('Pending', 'Approved', 'Changes Requested');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('Paid', 'Waived');--> statement-breakpoint
CREATE TYPE "public"."product_tier" AS ENUM('Premium', 'Luxury');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('Active', 'Trial', 'Past Due', 'Cancelled');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"customer_type" "customer_type" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "customer_type" NOT NULL,
	"channel_id" uuid NOT NULL,
	"workflow_key" text NOT NULL,
	"contact_email" text NOT NULL,
	"platform_email" text NOT NULL,
	"phone" text,
	"business_name" text,
	"business_address" text,
	"website" text,
	"service_areas" text,
	"local_content_areas" text,
	"bio" text,
	"license_number" text,
	"topics" text,
	"hashtags" text,
	"gmb_name" text,
	"mls_ids" text,
	"special_instructions" text,
	"agent_photo" jsonb,
	"business_logo" jsonb,
	"other_assets" jsonb,
	"hubspot_deal_id" text,
	"stripe_payment_id" text,
	"add_on_stripe_payment_id" text,
	"product_tier" "product_tier",
	"payment_status" "payment_status",
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"selected_stripe_price_id" text,
	"selected_plan_name" text,
	"subscription_status" "subscription_status",
	"mrr" numeric,
	"renewal_date" timestamp with time zone,
	"billing_cycle" text,
	"at_risk" boolean DEFAULT false NOT NULL,
	"at_risk_reason" "at_risk_reason",
	"at_risk_detail" text,
	"at_risk_source" "at_risk_source",
	"last_engagement_briefing" text,
	"engagement_score" integer,
	"brokerage_id" uuid,
	"roster_record_id" uuid,
	"csm_team_member_id" uuid,
	"design_approval" "design_approval",
	"design_feedback" text,
	"design_revision_count" integer DEFAULT 0 NOT NULL,
	"design_proof" jsonb,
	"design_drafts" jsonb,
	"design_proofs_updated_at" timestamp with time zone,
	"has_voice" boolean DEFAULT false NOT NULL,
	"has_avatar" boolean DEFAULT false NOT NULL,
	"voice_stage" text,
	"avatar_stage" text,
	"voice_stripe_id" text,
	"avatar_stripe_id" text,
	"current_stage" text NOT NULL,
	"stage_entered_at" timestamp with time zone,
	"account_created" boolean DEFAULT false NOT NULL,
	"credentials_sent" boolean DEFAULT false NOT NULL,
	"call_booked" boolean DEFAULT false NOT NULL,
	"call_completed" boolean DEFAULT false NOT NULL,
	"call_date" timestamp with time zone,
	"no_show_count" integer DEFAULT 0 NOT NULL,
	"other_emails" text,
	"environment" text[],
	"rejig_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_workflow_key_format" CHECK ("customers"."workflow_key" ~ '^(D2C|B2B)-')
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_code_unique" ON "channels" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_access_token_unique" ON "customers" USING btree ("access_token");