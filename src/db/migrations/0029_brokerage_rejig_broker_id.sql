-- Rejig's own id for each brokerage, sent as associated_brokerage on the onboarding sync.
-- A plain text slug that is identical in Rejig dev and prod (their Mongo _id
-- differs between the two, so we never use it). We pick it when adding a
-- brokerage and tell Rejig. NULL = Rejig doesn't know this brokerage yet.
ALTER TABLE "brokerages" ADD COLUMN IF NOT EXISTS "rejig_broker_id" text;--> statement-breakpoint
UPDATE "brokerages" SET "rejig_broker_id" = v.id
FROM (VALUES ('keyes', 'keyes'), ('b&w', 'baird'), ('ipre', 'ipre'), ('ruhl', 'ruhl'), ('coach', 'coach')) AS v(slug, id)
WHERE "brokerages"."landing_page_slug" = v.slug AND "brokerages"."rejig_broker_id" IS NULL;
