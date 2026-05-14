-- Phase 1 of the post-launch architectural migration (see
-- docs/plans/post-launch-migration.md). LaunchPad's responsibility
-- shrinks to "get the customer to Launched"; everything post-launch
-- (CSM tasks, check-ins, BI-driven attention states) moves to HubSpot.
--
-- This migration deletes the 18 workflow_template rows for the
-- post-launch stages across all three Core workflows:
--   D2C-Standard:   Onboarding Call, Post Onboarding, Review & Grow
--   B2B-Keyes:      Onboarding Call, Post Onboarding, Review & Grow
--   B2B-BW:         Onboarding Call, Post Onboarding, Review & Grow
--
-- After this migration the terminal stage for Core becomes the
-- existing "Prepare for Onboarding" stage; Auto 2's "no next stage"
-- branch (in activate-dependents.ts) writes Customer.currentStage =
-- 'Launched' once the last task in that stage completes.
--
-- Voice / Avatar add-on workflows are NOT in scope here — they
-- retain their existing terminal 'Done' state.
--
-- Existing in-flight customers whose tasks point at these now-deleted
-- templates are cleaned up by scripts/phase-1-cleanup-orphaned-tasks.ts.

DELETE FROM "workflow_templates"
WHERE "workflow_key" IN ('D2C-Standard', 'B2B-Keyes', 'B2B-BW')
  AND "task_title" IN (
    'Mark Onboarding Call Complete',
    'Send Zoom Recording',
    'Send Follow-Up Email',
    'Provide Onboarding Feedback',
    'Schedule Check-In 1',
    'Schedule Check-In 2'
  );
