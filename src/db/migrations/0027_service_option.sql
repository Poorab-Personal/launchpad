-- Ruhl service-option fork (B2B-RUHL launch, 2026-10-18).
--
-- Some brokerage agents self-manage their Rejig account and need onboarding
-- training; others are managed by the brokerage's marketing team and need none.
-- The agent declares which on the intake form.
--
-- Values are deliberately generic, not Ruhl's wording. Ruhl shows these as
-- "Self Post — Agent Access" and "Done For You Posts & Content"; another
-- brokerage can reuse the column with its own labels.
--
-- Both columns are additive and nullable — NULL means "not asked", which is the
-- correct reading for every customer created before this migration.

CREATE TYPE "service_option" AS ENUM ('Self-Managed', 'Brokerage-Managed');

ALTER TABLE "customers" ADD COLUMN "service_option" "service_option";

-- Where credentials get cc'd for Brokerage-Managed agents, so the team that
-- actually runs the account receives the login alongside the agent.
ALTER TABLE "brokerages" ADD COLUMN "managed_cc_email" text;
