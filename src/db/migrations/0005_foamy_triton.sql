CREATE TABLE "customer_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"product" "product" NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"hubspot_deal_id" text,
	"status" "subscription_status",
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"mrr" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubspot_inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hubspot_event_id" text NOT NULL,
	"subscription_type" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"property_name" text,
	"property_value" text,
	"change_source" text,
	"source_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"processing_status" text DEFAULT 'pending' NOT NULL,
	"processing_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "hubspot_contact_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "hubspot_ticket_id" text;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "customer_subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_subscriptions_customer_product_unique" ON "customer_subscriptions" USING btree ("customer_id","product");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_subscriptions_stripe_subscription_unique" ON "customer_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "customer_subscriptions_customer_idx" ON "customer_subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_subscriptions_hubspot_deal_idx" ON "customer_subscriptions" USING btree ("hubspot_deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hubspot_inbound_events_event_id_unique" ON "hubspot_inbound_events" USING btree ("hubspot_event_id");--> statement-breakpoint
CREATE INDEX "hubspot_inbound_events_object_idx" ON "hubspot_inbound_events" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "hubspot_inbound_events_status_idx" ON "hubspot_inbound_events" USING btree ("processing_status");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_hubspot_contact_id_unique" ON "customers" USING btree ("hubspot_contact_id") WHERE "customers"."hubspot_contact_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_hubspot_ticket_id_idx" ON "customers" USING btree ("hubspot_ticket_id");