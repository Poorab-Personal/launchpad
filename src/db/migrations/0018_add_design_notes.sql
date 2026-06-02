-- Add design_notes jsonb array + backfill from design_feedback.
-- Single source of truth for the round-by-round designer↔customer note trail.
-- design_feedback is retired in migration 0019 once the code deploy that
-- reads/writes design_notes is stable in production.

ALTER TABLE "customers" ADD COLUMN "design_notes" jsonb DEFAULT '[]'::jsonb;
--> statement-breakpoint

UPDATE "customers"
SET "design_notes" = jsonb_build_array(
  jsonb_build_object(
    'from', 'customer',
    'note', "design_feedback",
    'uploadTask', null,
    'at', to_char(COALESCE("last_modified", "created_at"), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )
)
WHERE "design_feedback" IS NOT NULL AND "design_feedback" != '';
