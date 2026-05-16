-- Add billing_relationship to customers + the supporting pgEnum.
-- Distinguishes paying customers from comped (real but not billed) and
-- internal_demo (Rejig-internal accounts). BI cron uses this to:
--   - skip internal_demo entirely
--   - suppress payment-related state escalations for comped
-- Default 'paying' so existing rows + new customers via standard flows
-- (D2C closedwon, B2B intake) get the right default without code change.

CREATE TYPE "billing_relationship_enum" AS ENUM ('paying', 'comped', 'internal_demo');--> statement-breakpoint

ALTER TABLE "customers"
  ADD COLUMN "billing_relationship" "billing_relationship_enum" DEFAULT 'paying';
