-- Drop partial unique on customer_subscriptions.stripe_subscription_id.
-- Discovered during backfill smoke: 4 Stripe sub_ids are shared by 60
-- Rejig accounts (team subscriptions — Keyes master billing, agentship.com
-- agency, kristancole KW team, arcrealtyco). The partial unique blocked
-- legitimate team-subscription inserts.
--
-- The existing (customer_id, product) unique still prevents duplicate-row
-- creation on Stripe webhook retries — that was the real reason for the
-- partial unique. So dropping it doesn't compromise idempotency.

DROP INDEX IF EXISTS "customer_subscriptions_stripe_subscription_unique";
