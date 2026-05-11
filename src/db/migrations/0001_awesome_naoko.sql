CREATE TYPE "public"."actor_type" AS ENUM('Customer', 'Team Member', 'System');--> statement-breakpoint
CREATE TYPE "public"."attachment_type" AS ENUM('None', 'Form', 'File Upload', 'Embed', 'Proof', 'Payment Setup');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('Scheduled', 'Completed', 'No Show', 'Rescheduled', 'Canceled');--> statement-breakpoint
CREATE TYPE "public"."call_type" AS ENUM('Onboarding', 'Check-In 1', 'Check-In 2', 'Ad-hoc');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('Not Started', 'In Progress', 'Completed');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('pre-paid', 'setup-intent-at-intake', 'invoice', 'none');--> statement-breakpoint
CREATE TYPE "public"."product" AS ENUM('Core', 'Voice', 'Avatar');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('Draft', 'Active', 'In Review', 'Completed', 'Rejected');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('Client', 'Team');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('Designer', 'Senior Designer', 'CSM', 'Senior CSM', 'Account Creator', 'Sales', 'Admin');--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"slack_handle" text,
	"calendly_url" text,
	"roles" "team_role"[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brokerages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"landing_page_slug" text NOT NULL,
	"default_workflow_key" text NOT NULL,
	"roster_api_url" text,
	"roster_api_key" text,
	"roster_refresh_interval" text,
	"last_roster_sync" timestamp with time zone,
	"default_calendly_url" text,
	"billing_contact" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"includes_voice" boolean DEFAULT false NOT NULL,
	"includes_avatar" boolean DEFAULT false NOT NULL,
	"pricing_tagline" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"brokerage_id" uuid,
	"agent_name" text,
	"phone" text,
	"license_number" text,
	"website" text,
	"photo_url" text,
	"logo_url" text,
	"bio" text,
	"service_areas" text,
	"mls_ids" text,
	"topics" text,
	"hashtags" text,
	"gmb_name" text,
	"other_emails" text,
	"onboarding_status" "onboarding_status" DEFAULT 'Not Started' NOT NULL,
	"customer_id" uuid,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text,
	"customer_id" uuid NOT NULL,
	"type" "call_type" NOT NULL,
	"scheduled_date" timestamp with time zone NOT NULL,
	"status" "call_status" DEFAULT 'Scheduled' NOT NULL,
	"csm_team_member_id" uuid,
	"notes" text,
	"recording_url" text,
	"calendly_event_uuid" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"task_name" text NOT NULL,
	"task_type" "task_type" NOT NULL,
	"stage" text NOT NULL,
	"stage_order" integer NOT NULL,
	"task_order" integer NOT NULL,
	"status" "task_status" DEFAULT 'Draft' NOT NULL,
	"assigned_to_team_member_id" uuid,
	"visible_to_client" boolean DEFAULT true NOT NULL,
	"has_team_review" boolean DEFAULT false NOT NULL,
	"attachment_type" "attachment_type" DEFAULT 'None' NOT NULL,
	"embed_url" text,
	"instructions" text,
	"tags" text[],
	"notes" text,
	"due_date" date,
	"product" "product" DEFAULT 'Core' NOT NULL,
	"last_reminder_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_key" text NOT NULL,
	"stage" text NOT NULL,
	"stage_order" integer NOT NULL,
	"task_order" integer NOT NULL,
	"task_title" text NOT NULL,
	"task_type" "task_type" NOT NULL,
	"assigned_role" "team_role",
	"initial_status" "task_status" DEFAULT 'Draft' NOT NULL,
	"depends_on" text,
	"has_team_review" boolean DEFAULT false NOT NULL,
	"attachment_type" "attachment_type" DEFAULT 'None' NOT NULL,
	"embed_url" text,
	"visible_to_client" boolean DEFAULT true NOT NULL,
	"product" "product" DEFAULT 'Core' NOT NULL,
	"instructions" text,
	"due_days_after_activation" integer,
	"plan_features" text,
	"payment_mode" "payment_mode",
	"trial_days" integer
);
--> statement-breakpoint
CREATE TABLE "stripe_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_name" text NOT NULL,
	"workflow_key" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"description" text,
	"price_display" text,
	"price_period" text,
	"billing_detail" text,
	"footnote" text,
	"highlight" text,
	"display_order" integer
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_number" bigserial NOT NULL,
	"customer_id" uuid,
	"event_type" text NOT NULL,
	"actor_team_member_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"details" jsonb,
	"related_task_id" uuid,
	"related_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roster" ADD CONSTRAINT "roster_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_csm_team_member_id_team_members_id_fk" FOREIGN KEY ("csm_team_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_team_member_id_team_members_id_fk" FOREIGN KEY ("assigned_to_team_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_team_member_id_team_members_id_fk" FOREIGN KEY ("actor_team_member_id") REFERENCES "public"."team_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_related_task_id_tasks_id_fk" FOREIGN KEY ("related_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_related_call_id_calls_id_fk" FOREIGN KEY ("related_call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_email_unique" ON "team_members" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "brokerages_landing_page_slug_unique" ON "brokerages" USING btree ("landing_page_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_calendly_event_uuid_unique" ON "calls" USING btree ("calendly_event_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_pair_unique" ON "task_dependencies" USING btree ("task_id","depends_on_task_id");--> statement-breakpoint
CREATE INDEX "stripe_plans_workflow_active_idx" ON "stripe_plans" USING btree ("workflow_key","active");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_unique" ON "settings" USING btree ("key");--> statement-breakpoint
CREATE INDEX "events_customer_created_idx" ON "events" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "events_event_type_idx" ON "events" USING btree ("event_type");