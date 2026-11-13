-- Whether the agent's Rejig account writes as a team ("we / us") or an
-- individual ("I / me"). Set by the Account Creator in the Sync to Rejig
-- panel and sent as is_team. NULL = never confirmed; the panel guesses from
-- the name until then. No backfill.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "is_team" boolean;
