-- §9 of backfill plan — rename customers.rejig_account_id → rejig_user_id +
-- add UNIQUE partial index. The renamed column will become the cross-system
-- identity anchor written by the backfill script.
--
-- No data migration needed: rejig_account_id is currently unpopulated
-- (zero NOT NULL writes to the column today).

ALTER TABLE "customers" RENAME COLUMN "rejig_account_id" TO "rejig_user_id";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "customers_rejig_user_id_unique"
  ON "customers" ("rejig_user_id")
  WHERE "rejig_user_id" IS NOT NULL;
