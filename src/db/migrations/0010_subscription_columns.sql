-- §18 of backfill plan — extend customer_subscriptions for cohort-aware
-- billing/period tracking. Adds 6 nullable columns + 1 pgEnum, relaxes
-- NOT NULL on stripe_subscription_id (B&W and demos have no Stripe sub),
-- converts unique index to partial, and adds a defensive period_end index
-- for BI cron renewal-window queries.

-- New enum: 'stripe' | 'invoice'. NULL allowed at column level for unknown/demo.
CREATE TYPE "payment_source_enum" AS ENUM ('stripe', 'invoice');--> statement-breakpoint

-- 6 new columns
ALTER TABLE "customer_subscriptions" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD COLUMN "current_period_start_source" text;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD COLUMN "last_invoice_status" text;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD COLUMN "last_invoice_url" text;--> statement-breakpoint
ALTER TABLE "customer_subscriptions" ADD COLUMN "payment_source" "payment_source_enum";--> statement-breakpoint

-- Relax NOT NULL on stripe_subscription_id (B&W direct-invoice + demos)
ALTER TABLE "customer_subscriptions" ALTER COLUMN "stripe_subscription_id" DROP NOT NULL;--> statement-breakpoint

-- Convert unique index to partial: only enforce when stripe_subscription_id is set
DROP INDEX IF EXISTS "customer_subscriptions_stripe_subscription_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "customer_subscriptions_stripe_subscription_unique"
  ON "customer_subscriptions" ("stripe_subscription_id")
  WHERE "stripe_subscription_id" IS NOT NULL;--> statement-breakpoint

-- Defensive index for BI cron renewal-window queries
CREATE INDEX "idx_customer_subscriptions_current_period_end"
  ON "customer_subscriptions" ("current_period_end")
  WHERE "current_period_end" IS NOT NULL;
