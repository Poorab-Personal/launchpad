-- Add hubspot_meeting_id to calls table for HS Meetings booking idempotency.
-- Mirrors the calendly_event_uuid UNIQUE pattern: nullable text + UNIQUE
-- index (Postgres UNIQUE allows multiple NULLs, so dedup only fires on
-- rows that actually have an HS meeting id set).

ALTER TABLE "calls" ADD COLUMN "hubspot_meeting_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "calls_hubspot_meeting_id_unique" ON "calls" ("hubspot_meeting_id");
