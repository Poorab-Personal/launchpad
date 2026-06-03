-- Add assignee_notified_at to tasks for the internal task-assignee
-- notification dedupe (see docs/plans/internal-task-assignee-notifications.md).
-- Stamped inside the same race-guarded UPDATE that flips status to Active,
-- so a concurrent loser sees the timestamp set and skips re-sending.
-- Cleared on reassignment to allow the new assignee to receive a notification.

ALTER TABLE "tasks" ADD COLUMN "assignee_notified_at" timestamp with time zone;
