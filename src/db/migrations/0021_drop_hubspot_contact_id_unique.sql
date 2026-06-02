-- Drop the UNIQUE constraint on customers.hubspot_contact_id.
--
-- The 1:1 invariant (one customer per HS contact) is enforced by HubSpot
-- itself (Contact is keyed by email at the HS level). Re-asserting it in
-- LP turned out to be over-constraining:
--   1. /test flow: every test customer points at poorab@rejig.ai → same
--      HS contact → second test always collides on this index, the LP
--      write-back fails, the HS ticket gets orphaned (no hubspot_ticket_id
--      on the LP row → subsequent stage-change webhooks can't find the
--      customer). Bertha Matics hit this 2026-06-02.
--   2. Future re-onboarding: an agent who churns and comes back with a
--      new LP customer would block on this index, same failure mode.
--
-- Dropping the index leaves the column nullable + indexed (the implicit
-- btree index Postgres creates for FK-style usage), but allows duplicates.

DROP INDEX IF EXISTS "customers_hubspot_contact_id_unique";
