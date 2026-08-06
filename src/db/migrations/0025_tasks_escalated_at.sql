-- Add escalated_at to tasks for the drop-off reminder cron's one-shot
-- escalation signal (see docs/plans/dropoff-reminder-cron.md). Kept separate
-- from last_reminder_at: that field tracks routine reminder-tier sends,
-- this one tracks whether the day-8 escalation (D2C sales rep / internal
-- ops trio) has actually been confirmed sent, so a reminder send succeeding
-- while the escalation send fails doesn't silently suppress a retry.
-- Cleared alongside last_reminder_at whenever a task's clock resets
-- (design-revision round, internal review reactivation).

ALTER TABLE "tasks" ADD COLUMN "escalated_at" timestamp with time zone;
