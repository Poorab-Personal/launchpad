CREATE TABLE "customer_state_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"attention_reason" text,
	"change_source" text NOT NULL,
	"source_detail" text,
	"changed_at" timestamp with time zone NOT NULL,
	"raw_hubspot_event_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_usage_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"rejig_user_id" text,
	"signal_type" text NOT NULL,
	"signal_value_numeric" numeric,
	"signal_value_jsonb" jsonb,
	"observed_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "onboarding_state" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "attention_reason" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "attention_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "created_via" text DEFAULT 'organic' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_state_transitions" ADD CONSTRAINT "customer_state_transitions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_usage_signals" ADD CONSTRAINT "customer_usage_signals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cst_customer_changed_at_idx" ON "customer_state_transitions" USING btree ("customer_id","changed_at");--> statement-breakpoint
CREATE INDEX "cst_change_source_changed_at_idx" ON "customer_state_transitions" USING btree ("change_source","changed_at");--> statement-breakpoint
CREATE INDEX "cus_customer_signal_observed_idx" ON "customer_usage_signals" USING btree ("customer_id","signal_type","observed_at");--> statement-breakpoint
CREATE INDEX "cus_signal_observed_idx" ON "customer_usage_signals" USING btree ("signal_type","observed_at");--> statement-breakpoint
CREATE INDEX "cus_rejig_user_signal_idx" ON "customer_usage_signals" USING btree ("rejig_user_id","signal_type");