-- Add sales_rep_email to customers — deal owner's email at closedwon time.
-- Populated by src/lib/integrations/hubspot/closedwon-handler.ts from the
-- HubSpot Deal's hubspot_owner_id → Owners API lookup. CC'd on the welcome
-- email so the closing sales rep gets a copy of the customer's magic link.
-- Nullable: existing customers, admin-created customers, and B2B landing
-- customers all skip this field and receive no CC.

ALTER TABLE "customers" ADD COLUMN "sales_rep_email" text;
